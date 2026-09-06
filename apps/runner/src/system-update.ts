/**
 * Runner self-update: pull a target runner image, then recreate this container.
 *
 * The Runner container is privileged and mounts the host docker.sock, so it can
 * manage the host's Docker daemon directly. We never rely on a compose CLI being
 * installed inside the Runner image. Instead we:
 *
 *   1. docker pull <image>
 *   2. inspect the current container to copy its full config
 *   3. start a sibling "zakura-recreator" container (same new image + docker.sock)
 *      that, after a grace delay, creates + starts the replacement with the
 *      copied runtime identity and the NEW image's Cmd/Entrypoint, then removes
 *      the old one. A child process inside this PID namespace would die when we
 *      `docker stop` ourselves — the sibling container does not.
 *   4. this process keeps serving until the recreator stops it; the replacement
 *      takes over.
 */
import type Docker from "dockerode";
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

export type SelfProcHints = {
  cgroupId: string | null;
  overlayUpperId: string | null;
  /** container ids from mountinfo, excluding the netns owner's resolv.conf/hostname/hosts */
  mountinfoContainerIds: string[];
};

export type FindSelfOpts = {
  hints?: SelfProcHints;
  hostname?: string;
  token?: string;
  slug?: string;
};

const HEX_ID = /^[0-9a-f]{12,64}$/i;
const HEX64 = /[0-9a-f]{64}/i;

/**
 * Parse cgroup + mountinfo the way a Tailscale-sidecar Runner actually looks:
 * privileged cgroup is `0::/`, overlay upperdir is OUR layer, and the only
 * `containers/<id>` paths are the sidecar's `/etc/resolv.conf|hostname|hosts`
 * because `network_mode: container:<ts>` shares that netns.
 *
 * The previous implementation took the first `containers/<id>` (the sidecar)
 * and self-update then rebuilt zakura-ts with the runner image.
 */
export function parseSelfProcHints(cgroup: string, mountinfo: string): SelfProcHints {
  const cgroupId =
    /(?:docker[-/]|containerd-[^/\s]*\/|libpod-)([0-9a-f]{64})/i.exec(cgroup)?.[1] ?? null;

  let overlayUpperId: string | null = null;
  const mountinfoContainerIds: string[] = [];
  for (const line of mountinfo.split("\n")) {
    if (!overlayUpperId) {
      const upper = /(?:^|[\s,])upperdir=\S*?([0-9a-f]{64})/i.exec(line);
      if (upper?.[1]) overlayUpperId = upper[1];
    }
    // Shared-netns files belong to the network-namespace owner, not us.
    if (/\/etc\/(?:resolv\.conf|hostname|hosts)(?:\s|$)/.test(line)) continue;
    const fromPath = /containers\/([0-9a-f]{64})/i.exec(line);
    if (fromPath?.[1] && !mountinfoContainerIds.includes(fromPath[1])) {
      mountinfoContainerIds.push(fromPath[1]);
    }
  }

  return { cgroupId, overlayUpperId, mountinfoContainerIds };
}

function containerName(names: string[] | undefined, name?: string): string {
  if (name) return name.replace(/^\//, "");
  return (names?.[0] ?? "").replace(/^\//, "");
}

/** Reject the Tailscale sidecar even if /proc or HOSTNAME points at it. */
export function containerLooksLikeRunner(
  info: {
    names?: string[];
    name?: string;
    image?: string;
    command?: string;
    cmd?: string[] | null;
    env?: string[] | null;
  },
  token?: string | null,
): boolean {
  const name = containerName(info.names, info.name);
  if (name.startsWith("zakura-ts-")) return false;
  const image = info.image ?? "";
  if (/(^|\/)tailscale(\/|:|$)/i.test(image)) return false;
  const command = `${info.command ?? ""} ${(info.cmd ?? []).join(" ")}`;
  if (command.includes("containerboot")) return false;
  const env = info.env ?? [];
  if (token && !env.includes(`ZAKURA_RUNNER_TOKEN=${token}`)) return false;
  const hasTsAuth = env.some((e) => e.startsWith("TS_AUTHKEY="));
  const hasRunnerToken = env.some((e) => e.startsWith("ZAKURA_RUNNER_TOKEN="));
  if (hasTsAuth && !hasRunnerToken) return false;
  return true;
}

function graphDriverBlob(info: Docker.ContainerInspectInfo): string {
  const data = info.GraphDriver?.Data ?? {};
  return Object.values(data).join(" ");
}

async function readSelfProcHintsFromHost(): Promise<SelfProcHints> {
  const { readFileSync } = await import("node:fs");
  const read = (path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  return parseSelfProcHints(read("/proc/self/cgroup"), read("/proc/self/mountinfo"));
}

/**
 * Locate this Runner's own container id from the Docker daemon.
 *
 * Never return a container that does not look like the Runner — a Tailscale
 * sidecar shares hostname/UTS/netns with us, and its id is the first
 * `containers/<id>` in mountinfo. Matching that used to recreate zakura-ts
 * with the runner image while keeping `Cmd=containerboot`.
 */
export async function findSelfContainerId(
  docker: Docker,
  opts?: FindSelfOpts,
): Promise<string | null> {
  const list = await docker.listContainers({ all: true });
  const hostname = (opts?.hostname ?? process.env.HOSTNAME)?.trim();
  const token = (opts?.token ?? process.env.ZAKURA_RUNNER_TOKEN)?.trim();
  const slug = (opts?.slug ?? process.env.ZAKURA_RUNNER_SLUG)?.trim();
  const hints = opts?.hints ?? (await readSelfProcHintsFromHost());

  const inspectCache = new Map<string, Docker.ContainerInspectInfo>();
  const inspectOf = async (id: string) => {
    const cached = inspectCache.get(id);
    if (cached) return cached;
    const info = await docker.getContainer(id).inspect();
    inspectCache.set(id, info);
    return info;
  };

  const accept = async (id: string | undefined): Promise<string | null> => {
    if (!id) return null;
    const row = list.find((c) => c.Id === id || c.Id.startsWith(id) || id.startsWith(c.Id));
    if (!row) return null;
    const info = await inspectOf(row.Id);
    const ok = containerLooksLikeRunner(
      {
        name: info.Name,
        image: info.Config?.Image,
        cmd: info.Config?.Cmd,
        env: info.Config?.Env,
      },
      token,
    );
    return ok ? row.Id : null;
  };

  if (hostname && HEX_ID.test(hostname)) {
    const hit = await accept(list.find((c) => c.Id.startsWith(hostname))?.Id);
    if (hit) return hit;
  }

  if (hints.overlayUpperId && HEX64.test(hints.overlayUpperId)) {
    for (const row of list) {
      const info = await inspectOf(row.Id);
      if (!graphDriverBlob(info).includes(hints.overlayUpperId)) continue;
      const hit = await accept(row.Id);
      if (hit) return hit;
    }
  }

  if (hints.cgroupId) {
    const hit = await accept(list.find((c) => c.Id.startsWith(hints.cgroupId!))?.Id);
    if (hit) return hit;
  }

  for (const id of hints.mountinfoContainerIds) {
    const hit = await accept(list.find((c) => c.Id.startsWith(id))?.Id);
    if (hit) return hit;
  }

  if (hostname) {
    const byName = list.find((c) =>
      c.Names.some((n) => n.replace(/^\//, "") === hostname),
    );
    const hit = await accept(byName?.Id);
    if (hit) return hit;
  }

  if (slug) {
    const byLabel = list.find((c) => (c.Labels ?? {})["zakura.runner_slug"] === slug);
    const labeled = await accept(byLabel?.Id);
    if (labeled) return labeled;
    const byName = list.find((c) =>
      c.Names.some((n) => n.replace(/^\//, "") === `zakura-runner-${slug}`),
    );
    const named = await accept(byName?.Id);
    if (named) return named;
  }

  if (token) {
    const matches: string[] = [];
    for (const row of list) {
      const hit = await accept(row.Id);
      if (hit) matches.push(hit);
    }
    const named = matches.filter((id) =>
      containerName(undefined, inspectCache.get(id)?.Name).startsWith("zakura-runner-"),
    );
    if (named.length === 1) return named[0]!;
    if (matches.length === 1) return matches[0]!;
  }

  return null;
}

export function sidecarNameForRunner(runnerName: string): string | null {
  const m = /^zakura-runner-(.+)$/.exec(runnerName.replace(/^\//, ""));
  return m ? `zakura-ts-${m[1]}` : null;
}

/**
 * `network_mode: container:<id>` dies with the sidecar. Rewrite to
 * `container:<name>` so the replacement attaches to whoever currently owns
 * that name (compose recreate of zakura-ts changes the id).
 */
export function resolveSharedNetworkMode(
  mode: string | undefined,
  idToName: (id: string) => string | undefined,
  fallbackName?: string | null,
): string | undefined {
  if (!mode) return mode;
  const m = /^container:([0-9a-f]{12,64})$/i.exec(mode.trim());
  if (!m?.[1]) return mode;
  const name = idToName(m[1]) ?? fallbackName ?? undefined;
  return name ? `container:${name.replace(/^\//, "")}` : mode;
}

export function hostDockerSockPath(self: Docker.ContainerInspectInfo): string {
  for (const bind of self.HostConfig?.Binds ?? []) {
    if (bind.includes("/var/run/docker.sock")) {
      return bind.split(":")[0] || "/var/run/docker.sock";
    }
  }
  return "/var/run/docker.sock";
}

export function assertSafeToRecreate(
  self: Docker.ContainerInspectInfo,
  token?: string | null,
): void {
  const name = (self.Name ?? "").replace(/^\//, "");
  if (name.startsWith("zakura-ts-")) {
    throw new Error("定位到的容器是 Tailscale sidecar（zakura-ts-*）。已中止自更新。");
  }
  if (
    !containerLooksLikeRunner(
      {
        name,
        image: self.Config?.Image,
        cmd: self.Config?.Cmd,
        env: self.Config?.Env,
      },
      token,
    )
  ) {
    throw new Error(
      "定位到的容器不是当前 Runner（疑似 Tailscale sidecar）。已中止自更新，避免误重建。",
    );
  }
  const devices = self.HostConfig?.Devices ?? [];
  if (
    devices.some(
      (d: { PathOnHost?: string; PathInContainer?: string }) =>
        `${d.PathOnHost ?? ""} ${d.PathInContainer ?? ""}`.includes("/dev/net/tun"),
    )
  ) {
    throw new Error("定位到的容器挂了 /dev/net/tun，是 Tailscale sidecar。已中止自更新。");
  }
}

export function replacementLooksHealthy(
  info: {
    Name?: string;
    State?: { Running?: boolean };
    Config?: { Cmd?: string[] | null; Image?: string };
  },
  expectedName: string,
): string | null {
  if (!info.State?.Running) return "replacement is not running";
  const name = (info.Name ?? "").replace(/^\//, "");
  if (name.startsWith("zakura-ts-")) return "replacement is the Tailscale sidecar";
  if (name !== expectedName) return `name is ${name}, expected ${expectedName}`;
  const cmd = (info.Config?.Cmd ?? []).join(" ");
  if (cmd.includes("containerboot")) return "replacement is running Tailscale containerboot";
  if (/(^|\/)tailscale(\/|:|$)/i.test(info.Config?.Image ?? "")) {
    return "replacement image is tailscale";
  }
  return null;
}

/**
 * Copy runtime identity from the live Runner, but never copy Cmd/Entrypoint —
 * those belong to the *new image*. Copying them is how a mis-identified
 * sidecar turned into `node docker-entrypoint.sh /usr/local/bin/containerboot`.
 */
export function buildReplacementCreateOpts(
  self: Docker.ContainerInspectInfo,
  image: string,
  networkMode: string | undefined,
): {
  createOpts: Docker.ContainerCreateOptions;
  extraNetworks: Array<{ name: string; aliases: string[] }>;
} {
  const name = (self.Name ?? "").replace(/^\//, "");
  if (name.startsWith("zakura-ts-")) {
    throw new Error("拒绝重建 Tailscale sidecar");
  }
  const cfg = self.Config;
  const shared = Boolean(networkMode?.startsWith("container:"));
  const hostConfig: Docker.ContainerCreateOptions["HostConfig"] = {
    ...(self.HostConfig ?? {}),
    RestartPolicy: { Name: "always" },
    Binds: self.HostConfig?.Binds ?? [],
    NetworkMode: networkMode ?? self.HostConfig?.NetworkMode ?? "bridge",
    PortBindings: shared ? {} : (self.HostConfig?.PortBindings ?? {}),
    PublishAllPorts: shared ? false : self.HostConfig?.PublishAllPorts,
  };

  const networks = shared ? [] : Object.entries(self.NetworkSettings?.Networks ?? {});
  const primaryNetwork = networks[0];
  const extraNetworks = networks.slice(1).map(([netName, v]) => ({
    name: netName,
    aliases: v.Aliases ?? [],
  }));

  return {
    createOpts: {
      name,
      Image: image,
      Env: (cfg.Env ?? []).filter((e) => !e.startsWith("ZAKURA_RUNNER_VERSION=")),
      Labels: cfg.Labels ?? {},
      WorkingDir: cfg.WorkingDir ?? undefined,
      ExposedPorts: shared ? undefined : (cfg.ExposedPorts ?? {}),
      HostConfig: hostConfig,
      NetworkingConfig: primaryNetwork
        ? {
            EndpointsConfig: {
              [primaryNetwork[0]]: { Aliases: primaryNetwork[1].Aliases ?? [] },
            },
          }
        : undefined,
    },
    extraNetworks,
  };
}

export const RECREATOR_CONTAINER_NAME = "zakura-recreator";

export function buildRecreatorContainerSpec(
  image: string,
  script: string,
  sockPath: string,
): Docker.ContainerCreateOptions {
  return {
    name: RECREATOR_CONTAINER_NAME,
    Image: image,
    Entrypoint: ["node"],
    Cmd: ["--input-type=module", "-e", script],
    WorkingDir: "/app/apps/runner",
    Env: ["DOCKER_HOST=unix:///var/run/docker.sock", "ZAKURA_RECREATOR=1"],
    HostConfig: {
      Binds: [`${sockPath}:/var/run/docker.sock`],
      RestartPolicy: { Name: "no" },
      NetworkMode: "none",
    },
  };
}

/**
 * Update this Runner to `image`. Returns immediately after scheduling a
 * sibling recreator *container* (not a child process). A child of this PID
 * dies when we `docker stop` ourselves; a separate container with docker.sock
 * survives and can roll back.
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
      "无法定位当前 Runner 容器（未匹配到 overlay / token / runner_slug）。请在宿主机手动 `docker compose up -d --force-recreate`。",
    );
  }
  const self = await docker.getContainer(selfId).inspect();
  assertSafeToRecreate(self, process.env.ZAKURA_RUNNER_TOKEN);

  const runnerName = (self.Name ?? "").replace(/^\//, "");
  const rawMode = self.HostConfig?.NetworkMode;
  let idToName: string | undefined;
  const idMatch = /^container:([0-9a-f]{12,64})$/i.exec(rawMode ?? "");
  if (idMatch?.[1]) {
    try {
      const peer = await docker.getContainer(idMatch[1]).inspect();
      idToName = (peer.Name ?? "").replace(/^\//, "");
    } catch {
      idToName = undefined;
    }
  }
  const networkMode = resolveSharedNetworkMode(
    rawMode,
    () => idToName,
    sidecarNameForRunner(runnerName),
  );

  const { createOpts, extraNetworks } = buildReplacementCreateOpts(self, image, networkMode);
  const delayMs = opts?.recreateDelayMs ?? 3000;
  const recreatorScript = buildRecreatorScript(
    selfId,
    image,
    createOpts,
    delayMs,
    extraNetworks,
  );

  try {
    await docker.getContainer(RECREATOR_CONTAINER_NAME).remove({ force: true });
  } catch {
    // leftover from a previous update, or first run
  }

  const rec = await docker.createContainer(
    buildRecreatorContainerSpec(image, recreatorScript, hostDockerSockPath(self)),
  );
  await rec.start();

  await new Promise((r) => setTimeout(r, 400));
  try {
    const st = await rec.inspect();
    if (st.State?.Status === "exited" && st.State.ExitCode !== 0) {
      throw new Error(`recreator exited with ${st.State.ExitCode}`);
    }
  } catch (err) {
    log.error("runner.update_recreator_failed", {
      image,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(
      `无法启动 Runner 自更新进程：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  log.info("runner.update_scheduled", {
    image,
    self_id: selfId.slice(0, 12),
    recreate_delay_ms: delayMs,
    via: RECREATOR_CONTAINER_NAME,
  });
  return { image, scheduled: true };
}

/**
 * Sibling-container script that performs the swap.
 *
 * Ordering is chosen so a failure is always recoverable:
 *   1. stop + rename the old container aside (still present, still restartable)
 *   2. create + start the replacement under the original name
 *   3. verify it is still running, is not the Tailscale sidecar, and is not
 *      executing containerboot
 *   4. only then remove the old one
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

function replacementLooksHealthy(info) {
  if (!info?.State?.Running) return "replacement is not running";
  const name = String(info.Name || "").replace(/^\\//, "");
  if (name.startsWith("zakura-ts-")) return "replacement is the Tailscale sidecar";
  if (name !== originalName) return "name is " + name + ", expected " + originalName;
  const cmd = (info.Config?.Cmd || []).join(" ");
  if (cmd.includes("containerboot")) return "replacement is running Tailscale containerboot";
  if (/(^|\\/)tailscale(\\/|:|$)/i.test(String(info.Config?.Image || ""))) return "replacement image is tailscale";
  return null;
}

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

  if (String(originalName || "").startsWith("zakura-ts-")) {
    log("refusing to recreate Tailscale sidecar", originalName);
    process.exit(1);
  }

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

  await sleep(5000);
  let reason = "inspect after start failed";
  try {
    reason = replacementLooksHealthy(await created.inspect()) || "";
  } catch (e) {
    log("inspect after start failed:", e?.message || e);
  }
  if (reason) {
    log("replacement unhealthy — rolling back:", reason);
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
