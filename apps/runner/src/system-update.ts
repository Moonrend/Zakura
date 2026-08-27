/**
 * Runner self-update: pull a target runner image, then recreate this container.
 *
 * The Runner container is privileged and mounts the host docker.sock, so it can
 * manage the host's Docker daemon directly. We never rely on a compose CLI being
 * installed inside the Runner image. Instead we:
 *
 *   1. docker pull <image>
 *   2. inspect the current container to copy its full config
 *   3. detach-spawn a short-lived "recreator" process (still this image's node)
 *      that, after a grace delay, creates + starts the replacement container
 *      with the copied config and the NEW image, then removes the old one.
 *   4. the Runner process exits; the replacement takes over (compose
 *      `restart: always` is not needed — we create the new container directly).
 *
 * The recreator uses the Docker API against the same socket, so it survives the
 * old container being removed (it runs as a child of PID 1; we detach via
 * `child_process` with stdio inherited and unref).
 */
import type Docker from "dockerode";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "@zakura/core";

function dockerErr(err: unknown): Error {
  if (!err || typeof err !== "object") return new Error(String(err));
  const e = err as { message?: string; json?: { message?: string } };
  return new Error(e.json?.message || e.message || String(err));
}

export async function pullImage(
  docker: Docker,
  image: string,
): Promise<{ image: string }> {
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(dockerErr(err));
      docker.modem.followProgress(stream, (e: Error | null) =>
        e ? reject(dockerErr(e)) : resolve(),
      );
    });
  });
  return { image };
}

/**
 * Locate this Runner's own container id from the Docker daemon.
 *
 * Inside a container `HOSTNAME` defaults to the **12-char container id**, not a
 * name. The previous implementation compared it against container *Names*, which
 * essentially never matched, and its fallback compared a node id against a
 * `zakura.runner_slug` label — two different identifiers. Self-update therefore
 * failed with "无法定位当前 Runner 容器" on normal deployments. Match on the id
 * first, and only then fall back to names/labels.
 */
export async function findSelfContainerId(docker: Docker): Promise<string | null> {
  const list = await docker.listContainers({ all: true });

  // 1. /proc-derived container id (most reliable): HOSTNAME is the short id.
  const hostname = process.env.HOSTNAME?.trim();
  if (hostname && /^[0-9a-f]{12,64}$/i.test(hostname)) {
    const byId = list.find((c) => c.Id.startsWith(hostname));
    if (byId) return byId.Id;
  }

  // 2. cgroup/mountinfo id, for runtimes that set a custom hostname.
  const cgroupId = await readSelfContainerIdFromProc();
  if (cgroupId) {
    const byCgroup = list.find((c) => c.Id.startsWith(cgroupId));
    if (byCgroup) return byCgroup.Id;
  }

  // 3. Explicit container_name match (compose sets it to zakura-runner-<slug>).
  if (hostname) {
    const byName = list.find((c) =>
      c.Names.some((n) => n.replace(/^\//, "") === hostname),
    );
    if (byName) return byName.Id;
  }

  // 4. Label match on the runner slug (compare slug to slug, not node id).
  const slug = process.env.ZAKURA_RUNNER_SLUG?.trim();
  if (slug) {
    const byLabel = list.find((c) => (c.Labels ?? {})["zakura.runner_slug"] === slug);
    if (byLabel) return byLabel.Id;
  }

  return null;
}

/** Read our own container id from cgroup / mountinfo. Returns null on a host. */
async function readSelfContainerIdFromProc(): Promise<string | null> {
  const { readFileSync } = await import("node:fs");
  for (const path of ["/proc/self/cgroup", "/proc/self/mountinfo"]) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    // docker/<id>, containerd .../<id>, or a 64-hex path segment
    const m =
      /(?:docker[-/]|containers\/)([0-9a-f]{64})/.exec(raw) ??
      /\b([0-9a-f]{64})\b/.exec(raw);
    if (m?.[1]) return m[1];
  }
  return null;
}

/**
 * Update this Runner to `image`. Returns immediately after scheduling the
 * detached recreator; the actual swap happens a few seconds later.
 */
export async function updateRunnerSelf(
  docker: Docker,
  image: string,
  opts?: { recreateDelayMs?: number },
): Promise<{ image: string; scheduled: true }> {
  await pullImage(docker, image);

  const selfId = await findSelfContainerId(docker);
  if (!selfId) {
    throw new Error(
      "无法定位当前 Runner 容器（未匹配到 hostname / runner_slug）。请在宿主机手动 `docker compose up -d --force-recreate`。",
    );
  }
  const self = await docker.getContainer(selfId).inspect();

  // Build the replacement config from the live container, swapping the image.
  const cfg = self.Config;
  const hostConfig = self.HostConfig ?? {};
  // Preserve all env except any prior version pin so the new image's default wins.
  const env = (cfg.Env ?? []).filter(
    (e) => !e.startsWith("ZAKURA_RUNNER_VERSION="),
  );

  // Docker rejects createContainer when EndpointsConfig has more than one entry,
  // so attach to a single network here and let the recreator connect the rest.
  const networks = Object.entries(self.NetworkSettings?.Networks ?? {});
  const primaryNetwork = networks[0];
  const extraNetworks = networks.slice(1).map(([name, v]) => ({
    name,
    aliases: v.Aliases ?? [],
  }));

  const createOpts: Docker.ContainerCreateOptions = {
    name: self.Name.replace(/^\//, ""),
    Image: image,
    Env: env,
    Cmd: cfg.Cmd ?? undefined,
    Entrypoint: cfg.Entrypoint ?? undefined,
    Labels: cfg.Labels ?? {},
    WorkingDir: cfg.WorkingDir ?? undefined,
    ExposedPorts: cfg.ExposedPorts ?? {},
    HostConfig: {
      ...hostConfig,
      RestartPolicy: { Name: "always" },
      PortBindings: hostConfig.PortBindings ?? {},
      Binds: hostConfig.Binds ?? [],
      NetworkMode: hostConfig.NetworkMode ?? "bridge",
    },
    NetworkingConfig: primaryNetwork
      ? {
          EndpointsConfig: {
            [primaryNetwork[0]]: { Aliases: primaryNetwork[1].Aliases ?? [] },
          },
        }
      : undefined,
  };

  const delayMs = opts?.recreateDelayMs ?? 3000;

  // Detached recreator: survives this process exit and drives the daemon over the
  // same socket.
  //
  // `--input-type=module` is load-bearing. The script uses top-level `await`, and
  // `node -e` evaluates as CommonJS by default — so it used to die instantly with
  // a SyntaxError. With `stdio: "ignore"` and no error handler that failure was
  // completely invisible, and the route still answered `scheduled: true`: the
  // self-update reported success and did nothing, every time.
  const recreatorScript = buildRecreatorScript(selfId, image, createOpts, delayMs, extraNetworks);
  const child = spawn(process.execPath, ["--input-type=module", "-e", recreatorScript], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    // `node -e` resolves bare specifiers from CWD, not from the app directory.
    cwd: appRootDir(),
    env: { ...process.env, ZAKURA_RECREATOR: "1" },
  });

  // Surface an immediately-failing child (bad flags, unresolvable imports) instead
  // of silently claiming success.
  const earlyFailure = await new Promise<string | null>((resolve) => {
    let stderr = "";
    const done = setTimeout(() => resolve(null), 400);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (err) => {
      clearTimeout(done);
      resolve(err.message);
    });
    child.once("exit", (code) => {
      clearTimeout(done);
      resolve(code === 0 ? null : `recreator exited with ${code}: ${stderr.slice(-500)}`);
    });
  });
  if (earlyFailure) {
    log.error("runner.update_recreator_failed", { image, error: earlyFailure });
    throw new Error(`无法启动 Runner 自更新进程：${earlyFailure}`);
  }

  child.stderr?.destroy();
  child.unref();

  log.info("runner.update_scheduled", {
    image,
    self_id: selfId.slice(0, 12),
    recreate_delay_ms: delayMs,
  });
  return { image, scheduled: true };
}

/** Directory containing this app's node_modules, so `node -e` can resolve imports. */
function appRootDir(): string {
  // dist/system-update.js | src/system-update.ts → package root
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * The detached process that performs the actual swap.
 *
 * Ordering is chosen so a failure is always recoverable:
 *   1. stop + rename the old container aside (still present, still restartable)
 *   2. create + start the replacement under the original name
 *   3. verify it is still running after a grace period
 *   4. only then remove the old one
 * If step 2 or 3 fails we roll back — rename the old container to its original
 * name and start it — instead of leaving the host with no Runner at all. The
 * previous version force-removed the old container on any rename hiccup, and on
 * a failed create it exited leaving the old container running under a
 * `-old-<ts>` name, which then broke id/name matching for all future updates.
 */
function buildRecreatorScript(
  oldId: string,
  image: string,
  createOpts: Docker.ContainerCreateOptions,
  delayMs: number,
  extraNetworks: Array<{ name: string; aliases: string[] }>,
): string {
  return `
import DockerMod from "dockerode";
import { resolveDockerContextSocketPath } from "@zakura/core";

const Docker = DockerMod.default ?? DockerMod;
const socketPath = resolveDockerContextSocketPath();
const docker = new Docker(socketPath ? { socketPath } : {});
const oldId = ${JSON.stringify(oldId)};
const image = ${JSON.stringify(image)};
const createOpts = ${JSON.stringify(createOpts)};
const delayMs = ${delayMs};
const extraNetworks = ${JSON.stringify(extraNetworks)};

const log = (...a) => console.error("[recreator]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const originalName = createOpts.name;

async function rollback(parkedName) {
  log("rolling back to the previous container");
  try {
    if (parkedName) await docker.getContainer(oldId).rename({ name: originalName });
    await docker.getContainer(oldId).start().catch(() => {});
    log("rollback done");
  } catch (e) {
    log("rollback FAILED:", e?.message || e, "— start it manually:", originalName);
  }
}

async function main() {
  await sleep(delayMs);

  // Park the old container: two containers cannot share a name.
  const parkedName = originalName + "-old-" + Date.now();
  try {
    await docker.getContainer(oldId).stop({ t: 10 }).catch(() => {});
    await docker.getContainer(oldId).rename({ name: parkedName });
  } catch (e) {
    log("could not park the old container:", e?.message || e);
    return;
  }

  let created;
  try {
    created = await docker.createContainer(createOpts);
    for (const net of extraNetworks) {
      await docker
        .getNetwork(net.name)
        .connect({ Container: created.id, EndpointConfig: { Aliases: net.aliases } })
        .catch((e) => log("extra network", net.name, "failed:", e?.message || e));
    }
    await created.start();
  } catch (e) {
    log("create/start failed:", e?.message || e);
    try { if (created) await created.remove({ force: true }); } catch {}
    await rollback(parkedName);
    process.exit(1);
  }

  // Verify it stayed up. A container that starts and immediately crashes used to
  // pass silently, because the old one was removed after a fixed sleep.
  await sleep(5000);
  let healthy = false;
  try {
    healthy = Boolean((await created.inspect())?.State?.Running);
  } catch (e) {
    log("inspect after start failed:", e?.message || e);
  }
  if (!healthy) {
    log("replacement is not running after start — rolling back");
    try { await created.stop({ t: 5 }).catch(() => {}); await created.remove({ force: true }); } catch {}
    await rollback(parkedName);
    process.exit(1);
  }

  try {
    await docker.getContainer(oldId).remove({ force: true });
    log("updated to", image);
  } catch (e) {
    log("old container cleanup failed (harmless):", e?.message || e);
  }
}

main().catch(async (e) => {
  log("fatal:", e?.message || e);
  process.exit(1);
});
  `.trim();
}
