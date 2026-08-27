/**
 * Local Docker ops for agent workspace containers on the Runner host.
 */
import Docker from "dockerode";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import {
  log,
  resolveDockerContextSocketPath,
  toDockerHostPath,
  mapContainerPathToHost,
  normalizeImageRef,
  ShellJob,
  ShellJobRegistry,
  StdioExec,
  StdioExecRegistry,
  bindExecStream,
  ensureWorkspaceDir,
  type ShellJobSnapshot,
} from "@zakura/core";
import {
  AGENT_PORT_CDP,
  AGENT_PORT_NOVNC,
  AGENT_WORKSPACE_ROOT,
  AGENT_DESKTOP_WIDTH,
  AGENT_DESKTOP_HEIGHT,
  ACP_IMAGE_BIN_DIR,
} from "@zakura/shared";

function dockerErr(err: unknown): Error {
  if (!err || typeof err !== "object") return new Error(String(err));
  const e = err as { message?: string; json?: { message?: string } };
  return new Error(e.json?.message || e.message || String(err));
}

/** `["K=V", …]` (docker's merged image+runtime env) → record. */
function parseEnvPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/**
 * Keep a custom network, drop Docker's implicit defaults.
 * A `startsWith("bridge")` test (the previous form) also swallowed real user
 * networks named e.g. `bridge-internal`.
 */
function resolveNetworkMode(mode: string | undefined): string | undefined {
  const m = mode?.trim();
  if (!m) return undefined;
  if (m === "bridge" || m === "default" || m === "host" || m === "none") return undefined;
  return m;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      const port = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

function demux(buffer: Buffer): { stdout: string; stderr: string } {
  if (buffer.length >= 8 && buffer[0]! <= 2 && buffer[1] === 0) {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let offset = 0;
    while (offset + 8 <= buffer.length) {
      const streamType = buffer[offset]!;
      const size = buffer.readUInt32BE(offset + 4);
      offset += 8;
      if (size < 0 || offset + size > buffer.length) break;
      const chunk = buffer.subarray(offset, offset + size);
      offset += size;
      if (streamType === 1) stdout.push(chunk);
      else if (streamType === 2) stderr.push(chunk);
    }
    return {
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    };
  }
  return { stdout: buffer.toString("utf8"), stderr: "" };
}

export type WorkspaceStartSpec = {
  agentId: string;
  agentSlug: string;
  tenantSlug?: string;
  image: string;
  network?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
};

export type WorkspaceInfo = {
  agentId: string;
  dockerId: string;
  name: string;
  image: string;
  status: string;
  ports: Array<{ containerPort: number; hostPort?: number; protocol?: string }>;
  labels: Record<string, string>;
  workspaceHostPath: string;
  endpoints: {
    novncPort: number | null;
    cdpPort: number | null;
    novncUrl: string | null;
    cdpUrl: string | null;
  };
};

export class RunnerDockerWorkspace {
  private readonly docker: Docker;
  private readonly jobs = new ShellJobRegistry();
  private readonly stdio = new StdioExecRegistry();

  /**
   * Host-side spelling of `storageRoot`. Only differs from `storageRoot` when the
   * Runner itself runs in a container: the generated compose maps the host's
   * `/var/zakura/<slug>/data` to `/var/lib/zakura` inside us, but the workspace
   * containers we create are created on the *host* daemon and must be given the
   * host path. See `mapContainerPathToHost`.
   */
  private readonly hostStorageRoot: string;

  constructor(
    private readonly storageRoot: string,
    private readonly publicHost: string,
    dockerOpts?: Docker.DockerOptions,
    hostStorageRoot?: string,
  ) {
    const socketPath = dockerOpts ? undefined : resolveDockerContextSocketPath();
    this.docker = new Docker(socketPath ? { socketPath } : dockerOpts);
    this.hostStorageRoot =
      hostStorageRoot?.trim() ||
      process.env.ZAKURA_RUNNER_HOST_STORAGE_ROOT?.trim() ||
      storageRoot;
  }

  /** Bind-mount source for an agent workspace, in host-filesystem terms. */
  private workspaceHostPath(agentId: string): string {
    return toDockerHostPath(
      mapContainerPathToHost(
        this.workspacePath(agentId),
        this.storageRoot,
        this.hostStorageRoot,
      ),
    );
  }

  /** Shared Docker client (used by system-update self-recreate). */
  get client(): Docker {
    return this.docker;
  }

  workspacePath(agentId: string): string {
    return join(this.storageRoot, "agents", agentId, "workspace");
  }

  private containerName(tenantSlug: string | undefined, agentSlug: string): string {
    const t = (tenantSlug || "default").toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    const a = agentSlug.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    return `zakura-ws-${t}-${a}`.slice(0, 63);
  }

  async ping(): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
    try {
      const info = await this.docker.version();
      return { ok: true, version: info.Version ?? "unknown" };
    } catch (err) {
      return { ok: false, error: dockerErr(err).message };
    }
  }

  /** 指定 bridge 网络不存在时自动创建（与 Server DockerRuntime 对齐） */
  async ensureNetwork(name: string): Promise<void> {
    const network = name.trim();
    if (!network) return;
    try {
      const networks = await this.docker.listNetworks({
        filters: { name: [network] },
      });
      if (networks.some((n) => n.Name === network)) return;
      await this.docker.createNetwork({
        Name: network,
        CheckDuplicate: true,
        Driver: "bridge",
        Labels: { "zakura.managed": "true" },
      });
    } catch (err) {
      const msg = dockerErr(err).message;
      if (/already exists/i.test(msg)) return;
      throw dockerErr(err);
    }
  }

  async findByAgent(agentId: string): Promise<WorkspaceInfo | null> {
    const list = await this.docker.listContainers({
      all: true,
      filters: { label: [`zakura.agent=${agentId}`, "zakura.purpose=workspace"] },
    });
    if (!list.length) return null;
    const info = await this.docker.getContainer(list[0]!.Id).inspect();
    return this.toInfo(agentId, info);
  }

  /**
   * List running workspace containers with their agent id + image id. Used by
   * the image-update checker to detect "running container is on an older image
   * than the current tag" (image pulled but container not recreated). Returns
   * only running containers (all:false already filters exited).
   */
  async listRunningImages(): Promise<
    Array<{ agentId: string; imageId: string; imageRef: string }>
  > {
    const list = await this.docker.listContainers({
      all: false,
      filters: { label: ["zakura.purpose=workspace", "zakura.managed=true"] },
    });
    const out: Array<{ agentId: string; imageId: string; imageRef: string }> = [];
    for (const c of list) {
      const agentId = (c.Labels ?? {})["zakura.agent"];
      if (!agentId) continue;
      out.push({ agentId, imageId: c.ImageID, imageRef: c.Image });
    }
    return out;
  }

  /** Always pull the image (refresh), unlike start() which only pulls when missing. */
  async pullImage(image: string): Promise<{ image: string; status: string }> {
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(dockerErr(err));
        this.docker.modem.followProgress(stream, (e: Error | null) =>
          e ? reject(dockerErr(e)) : resolve(),
        );
      });
    });
    const info = await this.docker.getImage(image).inspect();
    return { image, status: info.Id ? "updated" : "unknown" };
  }

  /**
   * Daemon-pulled remote digest: pull `image` (the daemon honors its registry
   * mirrors, HTTP proxies and auth — every path the in-process fetch probe
   * can't see) and return the resulting RepoDigest. Used as the last-resort
   * fallback when the manifest HEAD probe can't reach the registry. Returns
   * null when the daemon can't pull either (offline / no auth).
   */
  async pullToDigest(image: string): Promise<string | null> {
    try {
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(dockerErr(err));
          this.docker.modem.followProgress(stream, (e: Error | null) =>
            e ? reject(dockerErr(e)) : resolve(),
          );
        });
      });
      const info = await this.docker.getImage(image).inspect();
      const digests = info.RepoDigests ?? [];
      return digests.length ? (digests[0]!.split("@")[1] ?? null) : null;
    } catch {
      return null;
    }
  }

  /**
   * Force-recreate every running workspace container that matches `image` (or
   * all workspaces when image is null) on this Runner host. Used by the
   * workspace-image refresh flow so freshly pulled images take effect.
   * Returns the agents whose workspace was recreated.
   */
  async recreateWorkspaces(image?: string | null): Promise<
    Array<{ agentId: string; dockerId: string; name: string }>
  > {
    const list = await this.docker.listContainers({
      all: false,
      filters: { label: ["zakura.purpose=workspace", "zakura.managed=true"] },
    });
    // Match by image id, not just ref string: the update checker flags
    // `runningStale` by image id, but a container's reported `Image` ref may
    // differ from the canonical ref passed in (registry prefix, default tag),
    // so an exact-string match silently matched nothing and the refresh no-op'd.
    let targetImageId: string | null = null;
    if (image) {
      try {
        targetImageId = (await this.docker.getImage(image).inspect()).Id ?? null;
      } catch {
        targetImageId = null;
      }
    }
    const recreated: Array<{ agentId: string; dockerId: string; name: string }> = [];
    const failed: Array<{ agentId: string; error: string }> = [];

    for (const c of list) {
      // Match by normalized ref (handles docker.io / registry-1.docker.io /
      // bare prefixes) and fall back to image id. The image-id guard alone
      // misses the "just pulled a new tag" case (new id ≠ old running id), so
      // the normalized string match is what actually triggers the recreate.
      const matchesImage =
        !image ||
        normalizeImageRef(c.Image) === normalizeImageRef(image) ||
        (targetImageId !== null && c.ImageID === targetImageId);
      if (!matchesImage) continue;
      const agentId = (c.Labels ?? {})["zakura.agent"];
      const agentSlug = (c.Labels ?? {})["zakura.agent_slug"];
      const tenantSlug = (c.Labels ?? {})["zakura.tenant"];
      if (!agentId || !agentSlug) continue;

      // Preserve the original env and labels. Passing `undefined` (as this used
      // to) silently dropped any per-agent env injected at first start.
      let priorEnv: Record<string, string> | undefined;
      let priorLabels: Record<string, string> | undefined;
      try {
        const inspected = await this.docker.getContainer(c.Id).inspect();
        priorEnv = parseEnvPairs(inspected.Config?.Env ?? []);
        priorLabels = inspected.Config?.Labels ?? undefined;
      } catch {
        /* fall back to defaults reconstructed by start() */
      }

      // Park the old container under a temporary name instead of deleting it.
      // Removing first and hoping `start()` succeeds means a failure (bad image,
      // port clash) leaves the agent with **no** workspace at all.
      const parkedName = `${c.Names[0]?.replace(/^\//, "") ?? agentSlug}-old-${Date.now()}`.slice(
        0,
        63,
      );
      let parked = false;
      try {
        await this.docker.getContainer(c.Id).stop({ t: 5 }).catch(() => undefined);
        await this.docker.getContainer(c.Id).rename({ name: parkedName });
        parked = true;
      } catch {
        // Rename unavailable: fall back to the old destructive path.
        await this.docker.getContainer(c.Id).remove({ force: true }).catch(() => undefined);
      }

      try {
        const info = await this.start({
          agentId,
          agentSlug,
          tenantSlug,
          image: image || c.Image,
          env: priorEnv,
          labels: priorLabels,
          network: resolveNetworkMode(c.HostConfig?.NetworkMode),
        });
        recreated.push({ agentId, dockerId: info.dockerId, name: info.name });
        if (parked) {
          await this.docker.getContainer(c.Id).remove({ force: true }).catch(() => undefined);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("runner.workspace_recreate_failed", { agent_id: agentId, error: message });
        if (parked) {
          // Roll back: put the original container back and restart it.
          await this.docker
            .getContainer(c.Id)
            .rename({ name: parkedName.replace(/-old-\d+$/, "") })
            .catch(() => undefined);
          await this.docker.getContainer(c.Id).start().catch(() => undefined);
        }
        // Keep going: one broken agent must not abort the whole refresh and
        // leave the remaining containers silently unprocessed.
        failed.push({ agentId, error: message });
      }
    }

    if (failed.length) {
      log.warn("runner.workspace_recreate_partial", {
        recreated: recreated.length,
        failed: failed.length,
      });
    }
    return recreated;
  }


  private toInfo(agentId: string, info: Docker.ContainerInspectInfo): WorkspaceInfo {
    const ports: WorkspaceInfo["ports"] = [];
    const bindings = info.NetworkSettings?.Ports ?? {};
    for (const [key, hosts] of Object.entries(bindings)) {
      const [portStr, protocol] = key.split("/");
      const containerPort = Number(portStr);
      if (hosts && hosts.length > 0) {
        for (const h of hosts) {
          ports.push({
            containerPort,
            hostPort: h.HostPort ? Number(h.HostPort) : undefined,
            protocol,
          });
        }
      } else {
        ports.push({ containerPort, protocol });
      }
    }
    const find = (p: number) => ports.find((x) => x.containerPort === p)?.hostPort ?? null;
    const novncPort = find(AGENT_PORT_NOVNC);
    const cdpPort = find(AGENT_PORT_CDP);
    const host = this.publicHost || "127.0.0.1";
    return {
      agentId,
      dockerId: info.Id,
      name: info.Name?.replace(/^\//, "") ?? info.Id.slice(0, 12),
      image: info.Config?.Image ?? "",
      status: info.State?.Status ?? "unknown",
      ports,
      labels: info.Config?.Labels ?? {},
      workspaceHostPath: this.workspacePath(agentId),
      endpoints: {
        novncPort,
        cdpPort,
        novncUrl: novncPort
          ? `http://${host}:${novncPort}/vnc.html?autoconnect=true&resize=scale&password=`
          : null,
        cdpUrl: cdpPort ? `http://${host}:${cdpPort}` : null,
      },
    };
  }

  async start(spec: WorkspaceStartSpec): Promise<WorkspaceInfo> {
    const root = this.workspacePath(spec.agentId);
    ensureWorkspaceDir(root);

    // Remove old containers for this agent
    const existing = await this.findByAgent(spec.agentId);
    if (existing) {
      try {
        await this.docker.getContainer(existing.dockerId).stop({ t: 5 }).catch(() => undefined);
        await this.docker.getContainer(existing.dockerId).remove({ force: true });
      } catch {
        /* ignore */
      }
    }

    const name = this.containerName(spec.tenantSlug, spec.agentSlug);
    // Best-effort remove by name
    try {
      const byName = this.docker.getContainer(name);
      await byName.remove({ force: true });
    } catch {
      /* ignore */
    }

    // Ensure image exists (pull if missing)
    try {
      await this.docker.getImage(spec.image).inspect();
    } catch {
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(spec.image, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(dockerErr(err));
          this.docker.modem.followProgress(stream, (e: Error | null) =>
            e ? reject(dockerErr(e)) : resolve(),
          );
        });
      });
    }

    const novncHost = await findFreePort();
    const cdpHost = await findFreePort();

    const labels: Record<string, string> = {
      "zakura.managed": "true",
      "zakura.purpose": "workspace",
      "zakura.agent": spec.agentId,
      "zakura.agent_slug": spec.agentSlug,
      "zakura.stack": "display",
      "zakura.feat.computer": "true",
      ...(spec.labels ?? {}),
    };

    const env = {
      ZAKURA_AGENT_ID: spec.agentId,
      ZAKURA_AGENT_SLUG: spec.agentSlug,
      ZAKURA_ENABLE_BROWSER: "1",
      ZAKURA_ENABLE_COMPUTER: "1",
      ZAKURA_DESKTOP_WIDTH: String(AGENT_DESKTOP_WIDTH),
      ZAKURA_DESKTOP_HEIGHT: String(AGENT_DESKTOP_HEIGHT),
      HOME: AGENT_WORKSPACE_ROOT,
      DISPLAY: ":99",
      PATH: `${ACP_IMAGE_BIN_DIR}:/usr/local/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      ...(spec.env ?? {}),
    };

    // NOT `toDockerHostPath(root)`: `root` is our own view of the directory. The
    // container is created on the host daemon, so the bind source has to be the
    // host's spelling of the same directory.
    const hostPath = this.workspaceHostPath(spec.agentId);
    const createOpts: Docker.ContainerCreateOptions = {
      name,
      Image: spec.image,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Labels: labels,
      WorkingDir: AGENT_WORKSPACE_ROOT,
      ExposedPorts: {
        [`${AGENT_PORT_NOVNC}/tcp`]: {},
        [`${AGENT_PORT_CDP}/tcp`]: {},
      },
      HostConfig: {
        Binds: [`${hostPath}:${AGENT_WORKSPACE_ROOT}`],
        PortBindings: {
          [`${AGENT_PORT_NOVNC}/tcp`]: [{ HostPort: String(novncHost) }],
          [`${AGENT_PORT_CDP}/tcp`]: [{ HostPort: String(cdpHost) }],
        },
        RestartPolicy: { Name: "unless-stopped" },
        ShmSize: 2 * 1024 * 1024 * 1024,
      },
    };

    if (spec.network) {
      await this.ensureNetwork(spec.network);
      createOpts.NetworkingConfig = {
        EndpointsConfig: { [spec.network]: {} },
      };
    }

    let container: Docker.Container;
    try {
      container = await this.docker.createContainer(createOpts);
    } catch (err) {
      throw dockerErr(err);
    }
    try {
      await container.start();
    } catch (err) {
      try {
        await container.remove({ force: true });
      } catch {
        /* ignore */
      }
      throw dockerErr(err);
    }

    const info = await container.inspect();
    return this.toInfo(spec.agentId, info);
  }

  async stop(agentId: string, remove = true): Promise<{ ok: true }> {
    await this.jobs.killAgent(agentId);
    const existing = await this.findByAgent(agentId);
    if (!existing) return { ok: true };
    try {
      await this.docker.getContainer(existing.dockerId).stop({ t: 10 }).catch(() => undefined);
      if (remove) {
        await this.docker.getContainer(existing.dockerId).remove({ force: true });
      }
    } catch (err) {
      const msg = dockerErr(err).message;
      if (!/No such container/i.test(msg)) throw dockerErr(err);
    }
    return { ok: true };
  }

  /** Probe that /workspace is a readable bind mount (host dir not deleted). */
  /**
   * Verify that `/workspace` inside the container really is the directory the FS
   * API reads and writes — not merely *a* directory.
   *
   * `test -d /workspace` is not enough: when the bind source was given in our own
   * container-internal spelling, the host daemon happily created an empty
   * directory at that path and mounted it. The check passes, both sides look
   * healthy, and the split only shows up later as `ENOENT` when the user browses
   * a folder the agent just created. So we write a sentinel through our own
   * filesystem and require the container to see it.
   */
  async probeWorkspaceMount(
    dockerId: string,
    agentId?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const result = await this.execRaw(dockerId, ["test", "-d", AGENT_WORKSPACE_ROOT], {
        workingDir: "/",
      });
      if (result.exitCode !== 0) {
        return {
          ok: false,
          error: `工作区挂载已失效（无法访问 ${AGENT_WORKSPACE_ROOT}）。主机目录可能被删除，请重启电脑环境。`,
        };
      }

      if (!agentId) return { ok: true };

      const root = this.workspacePath(agentId);
      const sentinelName = ".zakura-mount-check";
      const token = `${process.pid}-${Date.now()}`;
      try {
        writeFileSync(join(root, sentinelName), token, "utf8");
      } catch {
        // Can't write our side; the -d check above already covers the useful case.
        return { ok: true };
      }
      const seen = await this.execRaw(
        dockerId,
        ["cat", `${AGENT_WORKSPACE_ROOT}/${sentinelName}`],
        { workingDir: "/" },
      );
      try {
        rmSync(join(root, sentinelName), { force: true });
      } catch {
        /* best effort */
      }
      if (seen.exitCode !== 0 || !seen.stdout.includes(token)) {
        return {
          ok: false,
          error:
            `工作区挂载指向了另一个目录：Runner 看到的是 ${root}，` +
            `但容器里的 ${AGENT_WORKSPACE_ROOT} 是别的目录，两边内容不同步。` +
            `Runner 跑在容器里时，请把 ZAKURA_RUNNER_HOST_STORAGE_ROOT 设为` +
            `宿主机上对应 ${this.storageRoot} 的真实路径（compose 里挂载的那个），然后重建电脑环境。`,
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async execRaw(
    dockerId: string,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const container = this.docker.getContainer(dockerId);
    const exec = await container.exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: opts?.workingDir,
      Env: opts?.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = opts?.timeoutMs
        ? setTimeout(() => {
            stream.destroy(new Error(`容器命令执行超时（${opts.timeoutMs}ms）`));
            reject(new Error(`容器命令执行超时（${opts.timeoutMs}ms）`));
          }, opts.timeoutMs)
        : null;
      const finish = (fn: () => void) => {
        if (timer) clearTimeout(timer);
        fn();
      };
      stream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
      stream.on("end", () => finish(resolve));
      stream.on("error", (err) => finish(() => reject(err)));
    });
    const demuxed = demux(Buffer.concat(chunks));
    const inspect = await exec.inspect();
    return {
      exitCode: inspect.ExitCode ?? 0,
      stdout: demuxed.stdout,
      stderr: demuxed.stderr,
    };
  }

  async exec(
    agentId: string,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const existing = await this.findByAgent(agentId);
    if (!existing || existing.status !== "running") {
      throw new Error("Workspace container not running on this runner");
    }
    // Host dir must exist; recreating after delete without container restart leaves a broken mount
    const root = this.workspacePath(agentId);
    if (!existsSync(root)) {
      ensureWorkspaceDir(root);
      throw new Error(
        `工作区主机目录丢失并已重建为空目录：${root}。请重启电脑环境以重新挂载 /workspace。`,
      );
    }
    const probe = await this.probeWorkspaceMount(existing.dockerId, agentId);
    if (!probe.ok) throw new Error(probe.error);
    return this.execRaw(existing.dockerId, command, opts);
  }

  async startJob(
    agentId: string,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number },
  ): Promise<ShellJobSnapshot> {
    const existing = await this.findByAgent(agentId);
    if (!existing || existing.status !== "running") {
      throw new Error("Workspace container not running on this runner");
    }
    const container = this.docker.getContainer(existing.dockerId);
    const exec = await container.exec({
      Cmd: command,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      WorkingDir: opts?.workingDir,
      Env: opts?.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined,
    });
    const stream = (await exec.start({
      hijack: true,
      stdin: true,
      Tty: true,
    })) as unknown as NodeJS.ReadWriteStream;
    const job = new ShellJob({ agentId });
    bindExecStream(job, stream, {
      inspect: () => exec.inspect(),
      resize: (cols, rows) => exec.resize({ w: cols, h: rows }),
      killPid: async (pid) => {
        try {
          const killer = await container.exec({
            Cmd: ["kill", "-TERM", String(pid)],
            AttachStdout: true,
            AttachStderr: true,
          });
          const ks = await killer.start({ hijack: true, stdin: false });
          ks.resume();
        } catch {
          /* gone */
        }
      },
    });
    this.jobs.add(job);
    if (opts?.stdin) setTimeout(() => job.write(opts.stdin!), 30);
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      setTimeout(() => {
        if (job.snapshot().running) void job.kill();
      }, opts.timeoutMs);
    }
    return job.snapshot();
  }

  getJob(agentId: string, jobId: string): ShellJob | undefined {
    return this.jobs.getForAgent(agentId, jobId);
  }

  async waitJob(
    agentId: string,
    jobId: string,
    waitMs: number,
    stdin?: string,
  ): Promise<ShellJobSnapshot> {
    const job = this.jobs.getForAgent(agentId, jobId);
    if (!job) throw new Error("Shell job not found");
    if (stdin) job.write(stdin);
    return job.wait(waitMs);
  }

  async killJob(agentId: string, jobId: string): Promise<ShellJobSnapshot> {
    const job = this.jobs.getForAgent(agentId, jobId);
    if (!job) throw new Error("Shell job not found");
    await job.kill();
    return job.snapshot();
  }

  async killAgentJobs(agentId: string): Promise<void> {
    await this.jobs.killAgent(agentId);
  }

  async startStdio(
    agentId: string,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string> },
  ) {
    const existing = await this.findByAgent(agentId);
    if (!existing || existing.status !== "running") {
      throw new Error("Workspace container not running on this runner");
    }
    const container = this.docker.getContainer(existing.dockerId);
    const exec = await container.exec({
      Cmd: command,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      WorkingDir: opts?.workingDir,
      Env: opts?.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined,
    });
    const stream = (await exec.start({
      hijack: true,
      stdin: true,
      Tty: false,
    })) as unknown as NodeJS.ReadWriteStream;
    const job = new StdioExec(stream, {
      inspect: () => exec.inspect(),
      killPid: async (pid) => {
        try {
          const killer = await container.exec({
            Cmd: ["kill", "-TERM", String(pid)],
            AttachStdout: true,
            AttachStderr: true,
          });
          const ks = await killer.start({ hijack: true, stdin: false });
          ks.resume();
        } catch {
          /* gone */
        }
      },
    });
    this.stdio.add(job);
    return job;
  }

  getStdio(id: string) {
    return this.stdio.get(id);
  }

  /**
   * Proxy a container localhost TCP port to the host via docker exec + socat/nc.
   * Used by Cloudflare Quick Tunnel (cloudflared binds to host loopback).
   */
  async openTcpTunnel(
    agentId: string,
    containerPort: number,
  ): Promise<{ host: string; port: number; url: string; close: () => void }> {
    const existing = await this.findByAgent(agentId);
    if (!existing || existing.status !== "running") {
      throw new Error("Workspace container not running on this runner");
    }
    const container = this.docker.getContainer(existing.dockerId);
    const server = createServer((socket: Socket) => {
      void (async () => {
        let stream: (NodeJS.ReadableStream & NodeJS.WritableStream & { destroy?: () => void }) | null =
          null;
        const cleanup = () => {
          try {
            socket.destroy();
          } catch {
            /* ignore */
          }
          try {
            stream?.destroy?.();
          } catch {
            /* ignore */
          }
        };
        try {
          const exec = await container.exec({
            Cmd: [
              "bash",
              "-lc",
              `if command -v socat >/dev/null 2>&1; then exec socat STDIO TCP:127.0.0.1:${containerPort},forever; elif command -v nc >/dev/null 2>&1; then exec nc 127.0.0.1 ${containerPort}; else echo 'socat/nc missing' >&2; exit 127; fi`,
            ],
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Tty: false,
          });
          stream = (await exec.start({
            hijack: true,
            stdin: true,
          })) as NodeJS.ReadableStream & NodeJS.WritableStream & { destroy?: () => void };

          socket.pipe(stream);
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          this.docker.modem.demuxStream(stream, stdout, stderr);
          stdout.pipe(socket);
          stderr.resume();

          socket.on("close", cleanup);
          socket.on("error", cleanup);
          stream.on("end", cleanup);
          stream.on("error", cleanup);
          stdout.on("error", cleanup);
        } catch {
          cleanup();
        }
      })();
    });

    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo | null;
        if (!addr) {
          reject(new Error("failed to bind TCP tunnel"));
          return;
        }
        resolve(addr.port);
      });
    });

    return {
      host: "127.0.0.1",
      port,
      url: `http://127.0.0.1:${port}`,
      close: () => {
        try {
          server.close();
        } catch {
          /* ignore */
        }
      },
    };
  }
}
