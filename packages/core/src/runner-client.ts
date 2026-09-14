/**
 * 通过 RunnerHub 调用 Go 代理原语。不再 HTTP 回调 :7443。
 */
import { randomUUID } from "node:crypto";
import type {
  DockerPullEvent,
  ImageUpdateEntry,
  MigrationManifest,
  RunnerHostInfo,
  RunnerUpdateProgress,
} from "@zakura/shared";
import type {
  ListDetailedResult,
  ReadTextResult,
  WorkspaceFs,
  WorkspaceFsEntry,
} from "./workspace-fs.js";
import type { ShellJobSnapshot } from "./shell-job.js";

export type HubRpc = {
  rpc<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  onStream?: (id: string, fn: (chan: string, data: Buffer) => void) => () => void;
  storageRoot?: string;
};

export type RunnerClientOptions = {
  hub: HubRpc;
  workspaceKind?: "host" | "container";
  /** @deprecated HTTP 入站已移除 */
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
};

type DockerInfo = {
  dockerId: string;
  name: string;
  image: string;
  status: string;
  ports?: Array<{ containerPort: number; hostPort?: number; protocol?: string }>;
  labels?: Record<string, string>;
};

export class RunnerClient {
  readonly baseUrl = "";
  private readonly hub: HubRpc;
  readonly workspaceKind: "host" | "container";

  constructor(opts: RunnerClientOptions) {
    if (!opts.hub) {
      throw new Error("RunnerClient 需要 Hub 会话；旧 HTTP Runner 已移除，请重装 zakura-agent");
    }
    this.hub = opts.hub;
    this.workspaceKind = opts.workspaceKind === "host" ? "host" : "container";
  }

  private rpc<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    return this.hub.rpc<T>(method, params, timeoutMs);
  }

  async ping(): Promise<{
    ok: boolean;
    version?: string;
    storageRoot?: string;
    hostInfo?: RunnerHostInfo;
    docker?: { ok: boolean; version?: string; error?: string };
    sha256?: string;
    goos?: string;
    goarch?: string;
  }> {
    const info = await this.rpc<{
      version?: string;
      storageRoot?: string;
      hostInfo?: RunnerHostInfo;
      docker?: { ok: boolean; version?: string; error?: string };
      sha256?: string;
      goos?: string;
      goarch?: string;
    }>("sys.info");
    return { ok: true, ...info };
  }

  async systemVersion(): Promise<{
    version: string; image: string; containerId: string | null;
    sha256?: string; goos?: string; goarch?: string; updateError?: string;
  }> {
    const info = await this.rpc<{
      version?: string; binPath?: string; sha256?: string;
      goos?: string; goarch?: string; updateError?: string;
    }>("sys.info", { light: true }, 10_000);
    return { ...info, version: info.version ?? "dev", image: info.binPath ?? "", containerId: null };
  }

  async updateRunner(body: {
    image: string;
    url?: string;
    sha256?: string;
    version?: string;
    recreateDelayMs?: number;
  }, onProgress?: (progress: RunnerUpdateProgress) => void): Promise<{
    image: string;
    scheduled: boolean;
    alreadyCurrent?: boolean;
    note?: string;
  }> {
    const progressStream = onProgress && this.hub.onStream ? `update-${randomUUID()}` : undefined;
    const unsubscribe = progressStream
      ? this.hub.onStream!(progressStream, (chan, data) => {
          if (chan !== "progress") return;
          try {
            const event = JSON.parse(data.toString("utf8")) as RunnerUpdateProgress;
            if (!["downloading", "verifying", "installing", "restarting"].includes(event.phase)) return;
            onProgress?.({
              phase: event.phase,
              downloadedBytes: Number.isFinite(event.downloadedBytes) ? Math.max(0, event.downloadedBytes) : 0,
              totalBytes: Number.isFinite(event.totalBytes) ? Math.max(0, event.totalBytes) : 0,
            });
          } catch { /* A malformed progress frame must not interrupt an update. */ }
        })
      : undefined;
    try {
      const result = await this.rpc<{ ok?: boolean; alreadyCurrent?: boolean; note?: string }>("sys.update", {
        url: body.url ?? body.image,
        sha256: body.sha256,
        version: body.version,
        restart: true,
        ...(progressStream ? { progressStream } : {}),
      }, 11 * 60_000); // The agent (including older releases) allows a ten-minute download.
      if (result?.ok === false) throw new Error(result.note || "代理更新失败");
      return { image: body.image, scheduled: !result?.alreadyCurrent, alreadyCurrent: result?.alreadyCurrent, note: result?.note };
    } finally {
      unsubscribe?.();
    }
  }

  async refreshWorkspaceImage(body: {
    image: string;
    recreateRunning?: boolean;
  }): Promise<{
    image: string;
    status: string;
    recreated: Array<{ agentId: string; dockerId: string; name: string }>;
  }> {
    await this.rpc("docker.pull", { image: body.image }, 10 * 60_000);
    if (body.recreateRunning === false) {
      return { image: body.image, status: "updated", recreated: [] };
    }
    const result = await this.rpc<{
      recreated?: Array<{ dockerId?: string; name?: string; labels?: Record<string, string> }>;
    }>("docker.recreate", { image: body.image }, 10 * 60_000);
    const recreated = (result.recreated ?? []).map((c) => ({
      agentId: c.labels?.["zakura.agent"] ?? "",
      dockerId: c.dockerId ?? "",
      name: c.name ?? "",
    }));
    return { image: body.image, status: "updated", recreated };
  }

  async checkImageUpdates(body: {
    images: string[];
    allowPullFallback?: boolean;
  }): Promise<{ images: ImageUpdateEntry[] }> {
    void body.allowPullFallback;
    if (body.allowPullFallback) {
      for (const image of body.images) {
        try {
          await this.rpc("docker.pull", { image }, 10 * 60_000);
        } catch {
          /* 探测失败记在 docker.images.error */
        }
      }
    }
    const rows = await this.rpc<
      Array<{
        image: string;
        id?: string;
        digest?: string;
        runningStale?: boolean;
        error?: string;
      }>
    >("docker.images", { images: body.images }, 60_000);
    const images: ImageUpdateEntry[] = (rows ?? []).map((row) => ({
      image: row.image,
      localId: row.id ?? null,
      localDigest: row.digest ?? row.id ?? null,
      remoteDigest: row.digest ?? null,
      updateAvailable: Boolean(row.runningStale),
      runningStale: Boolean(row.runningStale),
      error: row.error ?? null,
    }));
    return { images };
  }

  private wsName(tenantSlug: string | undefined, agentSlug: string): string {
    const t = (tenantSlug || "default").toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    const a = agentSlug.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    return `zakura-ws-${t}-${a}`.slice(0, 63);
  }

  async startWorkspace(body: {
    agentId: string;
    agentSlug: string;
    tenantSlug?: string;
    image?: string;
    network?: string;
    env?: Record<string, string>;
    labels?: Record<string, string>;
    workspaceKind?: "host" | "container";
  }): Promise<{
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
  }> {
    const mk = await this.rpc<{ abs?: string }>("host.fs.mkdir", { agentId: body.agentId, path: "/" });
    const kind = body.workspaceKind ?? this.workspaceKind;
    if (kind === "host") {
      const info = await this.ping();
      const root = mk.abs || `${info.storageRoot ?? ""}/agents/${body.agentId}/workspace`;
      return {
        agentId: body.agentId,
        dockerId: "",
        name: `host-${body.agentSlug}`,
        image: "host",
        status: "running",
        ports: [],
        labels: body.labels ?? {},
        workspaceHostPath: root,
        endpoints: { novncPort: null, cdpPort: null, novncUrl: null, cdpUrl: null },
      };
    }
    const docker = (await this.ping()).docker;
    if (!docker?.ok) {
      throw new Error(docker?.error || "本机没有 Docker，无法创建容器电脑。文件/终端可用，或改绑直连电脑。");
    }
    const image = body.image || "sunwuyuan/zakura-workspace-dev:latest";
    await this.rpc("docker.pull", { image }, 10 * 60_000);
    const name = this.wsName(body.tenantSlug, body.agentSlug);
    const info = await this.ping();
    const hostPath = mk.abs || `${info.storageRoot ?? ""}/agents/${body.agentId}/workspace`;
    const running = await this.rpc<DockerInfo>("docker.run", {
      name,
      image,
      network: body.network,
      env: { ZAKURA_AGENT_ID: body.agentId, ...(body.env ?? {}) },
      labels: { ...(body.labels ?? {}), "zakura.agent": body.agentId, "zakura.purpose": "workspace" },
      volumes: [{ hostPath, containerPath: "/workspace" }],
      // Desktop and CDP use authenticated stdio tunnels. Neither endpoint needs
      // an unauthenticated published port (Chrome also binds container localhost).
      ports: [],
      workingDir: "/workspace",
      restart: "unless-stopped",
    });
    const novnc = running.ports?.find((p) => p.containerPort === 6080);
    const cdp = running.ports?.find((p) => p.containerPort === 9222);
    return {
      agentId: body.agentId,
      dockerId: running.dockerId,
      name: running.name,
      image: running.image,
      status: running.status,
      ports: running.ports ?? [],
      labels: running.labels ?? {},
      workspaceHostPath: hostPath,
      endpoints: {
        novncPort: novnc?.hostPort ?? null,
        cdpPort: cdp?.hostPort ?? null,
        novncUrl: novnc?.hostPort ? `http://127.0.0.1:${novnc.hostPort}/vnc.html?autoconnect=true` : null,
        cdpUrl: cdp?.hostPort ? `http://127.0.0.1:${cdp.hostPort}` : null,
      },
    };
  }

  async getWorkspace(agentId: string): Promise<{
    dockerId: string;
    status: string;
    endpoints: {
      novncPort: number | null;
      cdpPort: number | null;
      novncUrl: string | null;
      cdpUrl: string | null;
    };
  } | null> {
    if (this.workspaceKind === "host") {
      return {
        dockerId: "",
        status: "running",
        endpoints: { novncPort: null, cdpPort: null, novncUrl: null, cdpUrl: null },
      };
    }
    const list = await this.rpc<DockerInfo[]>("docker.list", { label: `zakura.agent=${agentId}` });
    // ACP sidecars/adapters carry the same agent label and are often listed
    // first. Never run desktop commands in them or stop them as the workspace.
    // Older workspace containers predate the purpose label.
    const c = list?.find((container) => container.labels?.["zakura.purpose"] === "workspace")
      ?? list?.find((container) => !container.labels?.["zakura.purpose"]);
    if (!c) return null;
    const novnc = c.ports?.find((p) => p.containerPort === 6080);
    const cdp = c.ports?.find((p) => p.containerPort === 9222);
    return {
      dockerId: c.dockerId,
      status: c.status,
      endpoints: {
        novncPort: novnc?.hostPort ?? null,
        cdpPort: cdp?.hostPort ?? null,
        novncUrl: novnc?.hostPort ? `http://127.0.0.1:${novnc.hostPort}/vnc.html?autoconnect=true` : null,
        cdpUrl: cdp?.hostPort ? `http://127.0.0.1:${cdp.hostPort}` : null,
      },
    };
  }

  async stopWorkspace(agentId: string, remove = true): Promise<void> {
    if (this.workspaceKind === "host") return;
    const ws = await this.getWorkspace(agentId);
    if (ws?.dockerId) await this.rpc("docker.stop", { id: ws.dockerId, remove });
  }

  async startInstance(body: {
    instanceId: string;
    tenantId: string;
    name: string;
    image: string;
    env?: Record<string, string>;
    command?: string[];
    args?: string[];
    ports?: Array<{ containerPort: number; hostPort?: number; hostIp?: string; protocol?: "tcp" | "udp" }>;
    volumes?: Array<{ hostPath?: string; volumeName?: string; containerPath: string; readOnly?: boolean }>;
    labels?: Record<string, string>;
    network?: string;
    workingDir?: string;
  }): Promise<{
    dockerId: string;
    name: string;
    image: string;
    status: string;
    ports: Array<{ containerPort: number; hostPort?: number; protocol?: string }>;
    dataHostPath: string;
  }> {
    const docker = (await this.ping()).docker;
    if (!docker?.ok) throw new Error(docker?.error || "Docker 不可用，无法启动 MCP 容器");
    await this.rpc("docker.pull", { image: body.image }, 10 * 60_000);
    const running = await this.rpc<DockerInfo>("docker.run", {
      name: body.name,
      image: body.image,
      command: [...(body.command ?? []), ...(body.args ?? [])],
      env: body.env,
      labels: { "zakura.instance": body.instanceId, ...(body.labels ?? {}) },
      ports: body.ports,
      volumes: body.volumes,
      network: body.network,
      workingDir: body.workingDir,
    });
    return {
      dockerId: running.dockerId,
      name: running.name,
      image: running.image,
      status: running.status,
      ports: running.ports ?? [],
      dataHostPath: "",
    };
  }

  async getInstance(instanceId: string): Promise<{
    dockerId: string;
    name: string;
    image: string;
    status: string;
    ports: Array<{ containerPort: number; hostPort?: number; protocol?: string }>;
    dataHostPath: string;
  } | null> {
    const list = await this.rpc<DockerInfo[]>("docker.list", { label: `zakura.instance=${instanceId}` });
    const c = list?.[0];
    if (!c) return null;
    return { ...c, ports: c.ports ?? [], dataHostPath: "" };
  }

  async stopInstance(instanceId: string, remove = true): Promise<void> {
    const inst = await this.getInstance(instanceId);
    if (inst?.dockerId) await this.rpc("docker.stop", { id: inst.dockerId, remove });
  }

  async exportInstanceMigration(
    instanceId: string,
    body: { sourceNodeId: string; excludePatterns?: string[]; includePatterns?: string[] },
  ): Promise<{ archive: Buffer; manifest: MigrationManifest; archiveSha256: string }> {
    return this.exportMigration(instanceId, body);
  }

  async importInstanceMigration(
    instanceId: string,
    archive: Buffer,
    opts?: { expectedSha256?: string; atomic?: boolean },
  ): Promise<{ ok: true; fileCount: number; workspaceRoot: string }> {
    return this.importMigration(instanceId, archive, opts);
  }

  async execWorkspace(
    agentId: string,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (this.workspaceKind === "host") {
      return this.rpc("host.exec", { agentId, command, ...opts });
    }
    const ws = await this.getWorkspace(agentId);
    if (!ws?.dockerId) throw new Error("工作区容器未运行");
    return this.rpc("docker.exec", { id: ws.dockerId, command, workingDir: opts?.workingDir, env: opts?.env });
  }

  async startExecJob(
    agentId: string,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string>; timeoutMs?: number; stdin?: string },
  ): Promise<ShellJobSnapshot> {
    const params: Record<string, unknown> = { command, ...opts };
    if (this.workspaceKind === "host") {
      params.agentId = agentId;
    } else {
      const ws = await this.getWorkspace(agentId);
      if (!ws?.dockerId) throw new Error("工作区容器未运行");
      // 后台 job 复用 host.exec 登记；真正进容器靠本机 docker CLI。
      params.command = [
        "docker",
        "exec",
        ...(opts?.workingDir ? ["-w", opts.workingDir] : []),
        ws.dockerId,
        ...command,
      ];
      delete params.workingDir;
    }
    const snap = await this.rpc<{
      id: string;
      stdout: string;
      stderr: string;
      exitCode: number | null;
      running: boolean;
    }>("host.exec.start", params);
    return {
      jobId: snap.id,
      running: snap.running,
      exitCode: snap.exitCode,
      stdout: snap.stdout,
      stderr: snap.stderr,
      timedOut: false,
      elapsedMs: 0,
    };
  }

  async getExecJob(_agentId: string, jobId: string): Promise<ShellJobSnapshot> {
    const snap = await this.rpc<{
      id: string;
      stdout: string;
      stderr: string;
      exitCode: number | null;
      running: boolean;
    }>("host.exec.get", { id: jobId });
    return {
      jobId: snap.id,
      running: snap.running,
      exitCode: snap.exitCode,
      stdout: snap.stdout,
      stderr: snap.stderr,
      timedOut: false,
      elapsedMs: 0,
    };
  }

  async waitExecJob(
    agentId: string,
    jobId: string,
    waitMs: number,
    _stdin?: string,
  ): Promise<ShellJobSnapshot> {
    const deadline = Date.now() + waitMs;
    let last = await this.getExecJob(agentId, jobId);
    while (last.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      last = await this.getExecJob(agentId, jobId);
    }
    return last;
  }

  async killExecJob(_agentId: string, jobId: string): Promise<ShellJobSnapshot> {
    const snap = await this.rpc<{
      id: string;
      stdout: string;
      stderr: string;
      exitCode: number | null;
      running: boolean;
    }>("host.exec.kill", { id: jobId });
    return {
      jobId: snap.id,
      running: snap.running,
      exitCode: snap.exitCode,
      stdout: snap.stdout,
      stderr: snap.stderr,
      timedOut: false,
      elapsedMs: 0,
    };
  }

  async resizeExecJob(_agentId: string, jobId: string, cols: number, rows: number): Promise<void> {
    await this.rpc("host.pty.resize", { id: jobId, cols, rows }).catch(() => undefined);
  }

  async startStdio(
    agentId: string,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string>; dockerId?: string; attach?: boolean },
  ): Promise<{
    writable: WritableStream<Uint8Array>;
    readable: ReadableStream<Uint8Array>;
    kill: () => Promise<void>;
    onStderr: (fn: (chunk: string) => void) => () => void;
  }> {
    let dockerId = opts?.dockerId;
    if (!dockerId && this.workspaceKind !== "host") {
      dockerId = (await this.getWorkspace(agentId))?.dockerId;
      if (!dockerId) throw new Error("工作区容器未运行");
    }
    const method = opts?.attach
      ? "docker.attach"
      : dockerId
        ? "docker.exec.start"
        : "host.pty.start";
    const started = await this.rpc<{ id: string }>(method, {
      id: dockerId,
      agentId,
      command,
      workingDir: opts?.workingDir,
      env: opts?.env,
    });
    const streamId = started.id;
    const stderrListeners = new Set<(chunk: string) => void>();
    let closed = false;
    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.hub.onStream?.(streamId, (chan, data) => {
          if (chan === "stdout" && data.length) controller.enqueue(new Uint8Array(data));
          if (chan === "stderr" && data.length) {
            const text = data.toString("utf8");
            for (const fn of stderrListeners) fn(text);
          }
          if (chan === "exit" && !closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              /* ignore */
            }
          }
        });
      },
    });
    const writeMethod = dockerId ? "docker.exec.write" : "host.pty.write";
    const closeMethod = dockerId ? "docker.exec.close" : "host.pty.close";
    const writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await this.rpc(writeMethod, { id: streamId, base64: Buffer.from(chunk).toString("base64") });
      },
    });
    return {
      writable,
      readable,
      kill: async () => {
        await this.rpc(closeMethod, { id: streamId }).catch(() => undefined);
      },
      onStderr: (fn) => {
        stderrListeners.add(fn);
        return () => stderrListeners.delete(fn);
      },
    };
  }

  async listDetailed(agentId: string, path: string): Promise<ListDetailedResult> {
    return this.rpc("host.fs.list", { agentId, path: path || "/" });
  }

  async readText(agentId: string, path: string): Promise<ReadTextResult> {
    const r = await this.rpc<{ path: string; content: string }>("host.fs.read", { agentId, path });
    return { path: r.path, content: r.content, revision: "" } as ReadTextResult;
  }

  async writeText(
    agentId: string,
    path: string,
    content: string,
    _expectedRevision?: string | null,
  ): Promise<{ path: string; ok: true; revision: string }> {
    return this.rpc("host.fs.write", { agentId, path, content });
  }

  async mkdir(agentId: string, path: string): Promise<{ path: string; ok: true }> {
    return this.rpc("host.fs.mkdir", { agentId, path });
  }

  async delete(agentId: string, path: string, recursive?: boolean): Promise<{ path: string; ok: true }> {
    return this.rpc("host.fs.remove", { agentId, path, recursive });
  }

  async downloadBytes(
    agentId: string,
    path: string,
  ): Promise<{ data: Buffer; size: number; name: string }> {
    const r = await this.rpc<{ base64: string; size: number }>("host.fs.read", { agentId, path, max: 32 << 20 });
    const data = Buffer.from(r.base64, "base64");
    return { data, size: data.length, name: path.split("/").filter(Boolean).pop() || "download" };
  }

  async uploadBytes(
    agentId: string,
    path: string,
    data: Buffer,
  ): Promise<{ path: string; size: number }> {
    await this.rpc("host.fs.write", { agentId, path, base64: data.toString("base64") });
    return { path, size: data.length };
  }

  async archivePaths(
    agentId: string,
    paths: string[],
  ): Promise<{ filename: string; buffer: Buffer }> {
    const tar = await this.execWorkspace(agentId, ["tar", "-czf", "-", ...paths]);
    return { filename: "archive.tar.gz", buffer: Buffer.from(tar.stdout, "binary") };
  }

  async extractArchive(
    agentId: string,
    archivePath: string,
    destination?: string,
  ): Promise<{ destination: string; ok: true }> {
    const dest = destination || "/";
    await this.execWorkspace(agentId, ["tar", "-xzf", archivePath, "-C", dest]);
    return { destination: dest, ok: true };
  }

  async rename(agentId: string, oldPath: string, newPath: string): Promise<{ ok: true; path: string }> {
    return this.rpc("host.fs.rename", { agentId, oldPath, newPath });
  }

  async exportMigration(
    agentId: string,
    body: { sourceNodeId: string; excludePatterns?: string[]; includePatterns?: string[] },
  ): Promise<{ archive: Buffer; manifest: MigrationManifest; archiveSha256: string }> {
    const arch = await this.archivePaths(agentId, ["."]);
    const manifest: MigrationManifest = {
      version: 1,
      agentId,
      exportedAt: new Date().toISOString(),
      sourceNodeId: body.sourceNodeId,
      compression: "gzip",
      excludePatterns: body.excludePatterns ?? [],
      files: [],
      totalBytes: arch.buffer.length,
      fileCount: 0,
    };
    return { archive: arch.buffer, manifest, archiveSha256: "" };
  }

  async importMigration(
    agentId: string,
    archive: Buffer,
    _opts?: { expectedSha256?: string; atomic?: boolean },
  ): Promise<{ ok: true; fileCount: number; workspaceRoot: string }> {
    await this.uploadBytes(agentId, "/.migrate.tar.gz", archive);
    await this.extractArchive(agentId, "/.migrate.tar.gz", "/");
    return { ok: true, fileCount: 0, workspaceRoot: "/" };
  }

  async startExposure(_input: {
    exposureId: string;
    agentId: string;
    port: number;
    provider?: string;
    protocol?: "http" | "https" | "tcp";
    ttlMinutes?: number;
  }): Promise<{ publicUrl: string; relayHost: string; relayPort: number }> {
    throw new Error("端口暴露改由控制面隧道处理；Go 代理不再内嵌 Quick Tunnel");
  }

  async stopExposure(_exposureId: string): Promise<void> {}

  workspaceFs(agentId: string): WorkspaceFs {
    const client = this;
    return {
      async stat(path: string) {
        const s = await client.rpc<WorkspaceFsEntry>("host.fs.stat", { agentId, path });
        return { path: s.path, type: s.isDir ? ("dir" as const) : ("file" as const), size: s.size, mtime: s.modTime };
      },
      async statDetailed(path: string) {
        return client.rpc("host.fs.stat", { agentId, path });
      },
      async list(path: string) {
        const d = await client.listDetailed(agentId, path);
        return {
          path: d.path,
          entries: d.entries.map((e) => ({
            name: e.name,
            type: e.isDir ? ("dir" as const) : ("file" as const),
            size: e.size,
          })),
          truncated: false,
        };
      },
      async listDetailed(path: string) {
        return client.listDetailed(agentId, path);
      },
      async read(path: string) {
        const t = await client.readText(agentId, path);
        const lines = t.content.split("\n");
        return { path: t.path, content: t.content, truncated: false, totalLines: lines.length, startLine: 1 };
      },
      async readText(path: string) {
        return client.readText(agentId, path);
      },
      async write(path: string, content: string) {
        const r = await client.writeText(agentId, path, content);
        return { path: r.path, bytes: content.length };
      },
      async writeText(path: string, content: string, expectedRevision?: string | null) {
        return client.writeText(agentId, path, content, expectedRevision);
      },
      async edit(path: string, oldText: string, newText: string) {
        const cur = await client.readText(agentId, path);
        if (!cur.content.includes(oldText)) throw new Error("oldText 未找到");
        await client.writeText(agentId, path, cur.content.replace(oldText, newText));
        return { path, ok: true as const };
      },
      async mkdir(path: string) {
        return client.mkdir(agentId, path);
      },
      async mkdirApi(path: string) {
        return client.mkdir(agentId, path);
      },
      async delete(path: string, recursive?: boolean) {
        return client.delete(agentId, path, recursive);
      },
      async deleteApi(path: string, recursive?: boolean) {
        return client.delete(agentId, path, recursive);
      },
      async move(from: string, to: string) {
        await client.rename(agentId, from, to);
        return { from, to };
      },
      async renameApi(oldPath: string, newPath: string) {
        return client.rename(agentId, oldPath, newPath);
      },
      async exists(path: string) {
        try {
          await client.rpc("host.fs.stat", { agentId, path });
          return true;
        } catch {
          return false;
        }
      },
      async readBytes(path: string) {
        const r = await client.downloadBytes(agentId, path);
        return { path, data: r.data, size: r.size, name: r.name };
      },
      async writeBytes(path: string, data: Buffer) {
        return client.uploadBytes(agentId, path, data);
      },
      async archive(paths: string[]) {
        return client.archivePaths(agentId, paths);
      },
      async extract(archivePath: string, destPath?: string) {
        return client.extractArchive(agentId, archivePath, destPath);
      },
    };
  }

  async ensureAcpSidecar(body: {
    agentId: string;
    image?: string;
    network?: string;
  }): Promise<{ dockerId: string; image: string; status: string }> {
    const image = body.image || "sunwuyuan/zakura-acp-sidecar:latest";
    const docker = (await this.ping()).docker;
    if (!docker?.ok) throw new Error(docker?.error || "Docker 不可用，无法启动 ACP sidecar");
    await this.rpc("docker.pull", { image }, 10 * 60_000);
    const mk = await this.rpc<{ abs?: string }>("host.fs.mkdir", { agentId: body.agentId, path: "/" });
    const hostPath = mk.abs || `${(await this.ping()).storageRoot ?? ""}/agents/${body.agentId}/workspace`;
    const running = await this.rpc<DockerInfo>("docker.run", {
      name: `zakura-acp-${body.agentId}`.slice(0, 63),
      image,
      network: body.network,
      labels: { "zakura.agent": body.agentId, "zakura.purpose": "acp-sidecar" },
      volumes: [{ hostPath, containerPath: "/workspace" }],
      workingDir: "/workspace",
      restart: "unless-stopped",
    });
    return { dockerId: running.dockerId, image: running.image, status: running.status };
  }

  async stopAcpSidecar(agentId: string): Promise<void> {
    await this.rpc("docker.stop", { id: `zakura-acp-${agentId}`.slice(0, 63), remove: true }).catch(() => undefined);
  }

  async execInSidecar(
    agentId: string,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.rpc("docker.exec", {
      id: `zakura-acp-${agentId}`.slice(0, 63),
      command,
      workingDir: opts?.workingDir,
      env: opts?.env,
    });
  }

  async startStdioInSidecar(
    agentId: string,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string> },
  ) {
    return this.startStdio(agentId, command, {
      ...opts,
      dockerId: `zakura-acp-${agentId}`.slice(0, 63),
    });
  }

  async ensureAcpAdapterContainer(
    agentId: string,
    adapterId: string,
    body: {
      image: string;
      network?: string;
      env?: Record<string, string>;
      sessionKey: string;
      specHash?: string;
    },
  ): Promise<{ dockerId: string; image: string; status: string; name: string }> {
    const docker = (await this.ping()).docker;
    if (!docker?.ok) throw new Error(docker?.error || "Docker 不可用，无法启动 ACP adapter");
    await this.rpc("docker.pull", { image: body.image }, 10 * 60_000);
    const mk = await this.rpc<{ abs?: string }>("host.fs.mkdir", { agentId, path: "/" });
    const info = await this.ping();
    const hostPath = mk.abs || `${info.storageRoot ?? ""}/agents/${agentId}/workspace`;
    const name = `zakura-acpa-${agentId}-${adapterId}-${body.sessionKey}`.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 63);
    const running = await this.rpc<DockerInfo>("docker.run", {
      name,
      image: body.image,
      network: body.network,
      env: body.env,
      labels: {
        "zakura.agent": agentId,
        "zakura.purpose": "acp-adapter",
        "zakura.adapter": adapterId,
      },
      volumes: [{ hostPath, containerPath: "/workspace" }],
      workingDir: "/workspace",
      restart: "no",
      stdinOpen: true,
    });
    return { dockerId: running.dockerId, image: running.image, status: running.status, name };
  }

  async execDocker(
    id: string,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string> },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.rpc("docker.exec", { id, command, workingDir: opts?.workingDir, env: opts?.env });
  }

  async attachContainer(dockerId: string): Promise<{
    writable: WritableStream<Uint8Array>;
    readable: ReadableStream<Uint8Array>;
    kill: () => Promise<void>;
    onStderr: (fn: (chunk: string) => void) => () => void;
  }> {
    return this.startStdio("", [], { dockerId, attach: true });
  }

  async attachStdioInAdapter(
    agentId: string,
    adapterId: string,
    sessionKey: string,
  ): Promise<{ stdioId: string; agentId: string; adapterId: string }> {
    const name = `zakura-acpa-${agentId}-${adapterId}-${sessionKey}`.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 63);
    const r = await this.rpc<{ id: string }>("docker.attach", { id: name });
    return { stdioId: r.id, agentId, adapterId };
  }

  async removeAcpAdapterContainer(agentId: string, adapterId: string, sessionKey: string): Promise<void> {
    const name = `zakura-acpa-${agentId}-${adapterId}-${sessionKey}`.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 63);
    await this.rpc("docker.stop", { id: name, remove: true }).catch(() => undefined);
  }

  async pullImage(
    image: string,
    onProgress?: (line: string, event?: DockerPullEvent) => void,
  ): Promise<void> {
    // Subscribe before requesting the pull: the first layers may arrive before
    // the RPC response. Older agents can ignore progressStream and still pull.
    const progressStream = onProgress && this.hub.onStream ? `pull-${randomUUID()}` : undefined;
    const unsubscribe = progressStream
      ? this.hub.onStream!(progressStream, (chan, data) => {
          if (chan !== "progress") return;
          try {
            const event = JSON.parse(data.toString("utf8")) as DockerPullEvent;
            if (!event || typeof event !== "object") return;
            const line = event.error || [event.id, event.status, event.progress]
              .filter((part) => typeof part === "string" && part.trim())
              .map((part) => part!.trim())
              .join(" ");
            onProgress?.(line, { ...event, zakura: { ...event.zakura, image } });
          } catch {
            // Malformed events and progress observers must not fail the pull.
          }
        })
      : undefined;
    try {
      await this.rpc(
        "docker.pull",
        { image, ...(progressStream ? { progressStream } : {}) },
        10 * 60_000,
      );
    } finally {
      unsubscribe?.();
    }
  }

  async removeAcpAdapterContainers(agentId: string, adapterId: string): Promise<number> {
    const list = await this.rpc<DockerInfo[]>("docker.list", { label: `zakura.agent=${agentId}` });
    let n = 0;
    for (const c of list ?? []) {
      if (c.labels?.["zakura.purpose"] !== "acp-adapter") continue;
      if (c.labels?.["zakura.adapter"] !== adapterId) continue;
      await this.rpc("docker.stop", { id: c.dockerId, remove: true }).catch(() => undefined);
      n++;
    }
    return n;
  }

  async startAcpAdapterLoginShell(
    agentId: string,
    adapterId: string,
    opts?: {
      command?: string[];
      env?: Record<string, string>;
      sessionKey?: string;
      cols?: number;
      rows?: number;
    },
  ): Promise<ShellJobSnapshot> {
    const name = `zakura-acpa-${agentId}-${adapterId}-${opts?.sessionKey ?? ""}`
      .replace(/[^a-zA-Z0-9_.-]/g, "-")
      .slice(0, 63);
    const docker = (await this.ping()).docker;
    if (!docker?.ok) throw new Error(docker?.error || "Docker 不可用，无法打开 ACP 登录壳");
    void opts?.cols;
    void opts?.rows;
    const inner = opts?.command?.length ? opts.command : ["sh"];
    return this.startExecJob(agentId, ["docker", "exec", "-i", name, ...inner], {
      env: opts?.env,
    });
  }
}
