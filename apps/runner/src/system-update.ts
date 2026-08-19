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

/** Locate this Runner's own container id from the Docker daemon. */
export async function findSelfContainerId(
  docker: Docker,
): Promise<string | null> {
  // Best-effort: match by hostname (container_name contains slug) or by env hint.
  const hostname = process.env.HOSTNAME?.trim();
  const list = await docker.listContainers({ all: true });
  if (hostname) {
    const byName = list.find(
      (c) => c.Names.some((n) => n.replace(/^\//, "") === hostname) ||
        c.Names.some((n) => n.includes(hostname)),
    );
    if (byName) return byName.Id;
  }
  const byEnv = process.env.ZAKURA_RUNNER_NODE_ID?.trim();
  if (byEnv) {
    const match = list.find((c) => (c.Labels ?? {})["zakura.runner_slug"] === byEnv);
    if (match) return match.Id;
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
    NetworkingConfig: self.NetworkSettings?.Networks
      ? {
          EndpointsConfig: Object.fromEntries(
            Object.entries(self.NetworkSettings.Networks).map(([k, v]) => [
              k,
              { Aliases: v.Aliases ?? [] },
            ]),
          ),
        }
      : undefined,
  };

  const delayMs = opts?.recreateDelayMs ?? 3000;

  // Detached recreator: survives this process exit because we spawn it detached
  // and let it drive the daemon via the same socket.
  const recreatorScript = buildRecreatorScript(selfId, image, createOpts, delayMs);
  const child = spawn(process.execPath, ["-e", recreatorScript], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ZAKURA_RECREATOR: "1" },
  });
  child.unref();

  log.info("runner.update_scheduled", {
    image,
    self_id: selfId.slice(0, 12),
    recreate_delay_ms: delayMs,
  });
  return { image, scheduled: true };
}

function buildRecreatorScript(
  oldId: string,
  image: string,
  createOpts: Docker.ContainerCreateOptions,
  delayMs: number,
): string {
  // Serialise config once; the recreator only needs Docker + the parsed config.
  const configJson = JSON.stringify(createOpts);
  return `
const Docker = (await import("dockerode")).default;
const { resolveDockerContextSocketPath } = await import("@zakura/core");
const socketPath = resolveDockerContextSocketPath();
const docker = new Docker(socketPath ? { socketPath } : {});
const oldId = ${JSON.stringify(oldId)};
const image = ${JSON.stringify(image)};
const createOpts = ${configJson};
const delayMs = ${delayMs};

async function main() {
  await new Promise((r) => setTimeout(r, delayMs));
  // Two containers cannot share a name, so rename the old one aside first,
  // create + start the replacement with the original name, then remove old.
  let oldName = "zakura-runner-old-" + Date.now();
  try {
    const oldInfo = await docker.getContainer(oldId).inspect();
    oldName = (oldInfo.Name || "").replace(/^\\//, "") + "-old-" + Date.now();
    await docker.getContainer(oldId).rename({ name: oldName });
  } catch (e) {
    console.error("[recreator] rename old failed:", e?.message || e);
    // If rename failed, fall back to removing old before create (brief downtime).
    try { await docker.getContainer(oldId).stop({ t: 10 }).catch(() => {}); } catch {}
    try { await docker.getContainer(oldId).remove({ force: true }); } catch {}
  }
  let newContainer;
  try {
    newContainer = await docker.createContainer(createOpts);
    await newContainer.start();
  } catch (e) {
    console.error("[recreator] create/start failed:", e?.message || e);
    process.exit(1);
  }
  // Give the new container a moment to come up before removing the renamed old.
  await new Promise((r) => setTimeout(r, 2000));
  try {
    await docker.getContainer(oldId).stop({ t: 10 }).catch(() => {});
    await docker.getContainer(oldId).remove({ force: true });
  } catch (e) {
    console.error("[recreator] old cleanup failed:", e?.message || e);
  }
}
main().catch((e) => { console.error("[recreator] fatal:", e?.message || e); process.exit(1); });
  `.trim();
}
