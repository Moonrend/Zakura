import {
  LocalWorkspaceFs,
  RunnerClient,
  ShellJobRegistry,
  mapContainerPathToHost,
  type RunningContainer,
  type ShellJob,
} from "@zakura/core";
import type { ContainerSpec } from "@zakura/shared";
import type { AppConfig } from "../config.js";
import type { DockerRuntime } from "../runtime/docker.js";
import { agentWorkspaceHostPath } from "./agent-workspace.js";

/** In-process implementation of the primitives used by RunnerClient. */
class LocalRunnerBackend {
  constructor(
    readonly runtime: DockerRuntime,
    readonly config: AppConfig,
    readonly tenantId: string,
  ) {}

  workspaceFs(agentId: string): LocalWorkspaceFs {
    if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) throw new Error("Invalid agent ID");
    return new LocalWorkspaceFs(agentWorkspaceHostPath(this.config, agentId));
  }

  async container(id: string): Promise<RunningContainer | null> {
    const row = await this.runtime.inspect(id);
    if (row && row.labels["zakura.tenant"] !== this.tenantId) {
      throw new Error("Container does not belong to this tenant");
    }
    return row;
  }

  async requireContainer(id: string): Promise<RunningContainer> {
    const row = await this.container(id);
    if (!row) throw new Error("本机容器不存在或已停止");
    return row;
  }

  rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.dispatch(method, params) as Promise<T>;
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (method === "sys.info") {
      return { storageRoot: this.config.dataDir, docker: await this.runtime.ping() };
    }
    if (method.startsWith("host.fs.")) {
      const p = params as { agentId: string; path: string; content?: string; base64?: string; recursive?: boolean; oldPath: string; newPath: string };
      const fs = this.workspaceFs(p.agentId);
      switch (method) {
        case "host.fs.mkdir": return { ...await fs.mkdirApi(p.path), abs: fs.getRoot() };
        case "host.fs.list": return fs.listDetailed(p.path);
        case "host.fs.stat": return fs.statDetailed(p.path);
        case "host.fs.read": {
          const result = await fs.readBytes(p.path);
          return { path: result.path, size: result.size, content: result.data.toString("utf8"), base64: result.data.toString("base64") };
        }
        case "host.fs.write": return p.base64 !== undefined
          ? fs.writeBytes(p.path, Buffer.from(p.base64, "base64"))
          : fs.writeText(p.path, p.content ?? "");
        case "host.fs.remove": return fs.deleteApi(p.path, p.recursive);
        case "host.fs.rename": return fs.renameApi(p.oldPath, p.newPath);
      }
    }
    switch (method) {
      case "docker.pull":
        return this.runtime.ensureImage((params as { image: string }).image);
      case "docker.list": {
        const { label } = params as { label?: string };
        const rows = await this.runtime.list({ tenantId: this.tenantId });
        return rows.filter((row) => !label || Object.entries(row.labels).some(([key, value]) => `${key}=${value}` === label))
          .map((row) => ({ ...row, dockerId: row.id }));
      }
      case "docker.run": {
        const spec = params as ContainerSpec & { restart?: ContainerSpec["restartPolicy"] };
        const existing = await this.container(spec.name);
        if (existing?.status === "running" && existing.image === spec.image) {
          return { ...existing, dockerId: existing.id };
        }
        if (existing) await this.runtime.remove(existing.id);
        if (spec.network) await this.runtime.ensureNetwork(spec.network);
        const agentId = spec.labels?.["zakura.agent"];
        const purpose = spec.labels?.["zakura.purpose"] ?? (agentId ? "workspace" : "component");
        const row = await this.runtime.createAndStart({
          tenantId: this.tenantId,
          instanceId: spec.labels?.["zakura.instance"],
          allocatedTo: agentId,
          purpose,
          spec: {
            ...spec,
            restartPolicy: spec.restart,
            labels: { ...spec.labels, "zakura.managed": "true", "zakura.tenant": this.tenantId, "zakura.purpose": purpose },
            volumes: spec.volumes?.map((volume) => ({
              ...volume,
              hostPath: volume.hostPath
                ? mapContainerPathToHost(volume.hostPath, this.config.dataDir, this.config.hostDataDir ?? undefined)
                : undefined,
            })),
          },
        });
        return { ...row, dockerId: row.id };
      }
      case "docker.stop": {
        const p = params as { id: string; remove?: boolean };
        const row = await this.container(p.id);
        if (!row) return;
        if (p.remove) await this.runtime.remove(row.id);
        else await this.runtime.stop(row.id);
        return;
      }
      case "docker.exec": {
        const p = params as { id: string; command: string[]; workingDir?: string; env?: Record<string, string>; timeoutMs?: number };
        const row = await this.requireContainer(p.id);
        return this.runtime.exec(row.id, p.command, p);
      }
      default:
        throw new Error(`Local Runner 不支持 ${method}`);
    }
  }
}

/** Local Runner uses the server's filesystem and Docker, with no Go session. */
export class LocalRunnerClient extends RunnerClient {
  private readonly local: LocalRunnerBackend;
  private readonly jobs = new ShellJobRegistry();

  constructor(runtime: DockerRuntime, config: AppConfig, tenantId: string) {
    const local = new LocalRunnerBackend(runtime, config, tenantId);
    super({ hub: local, workspaceKind: "container" });
    this.local = local;
  }

  override workspaceFs(agentId: string) {
    return this.local.workspaceFs(agentId);
  }

  override readText(agentId: string, path: string) {
    return this.workspaceFs(agentId).readText(path);
  }

  override writeText(agentId: string, path: string, content: string, expectedRevision?: string | null) {
    return this.workspaceFs(agentId).writeText(path, content, expectedRevision);
  }

  override archivePaths(agentId: string, paths: string[]) {
    return this.workspaceFs(agentId).archive(paths);
  }

  override extractArchive(agentId: string, path: string, destination?: string) {
    return this.workspaceFs(agentId).extract(path, destination);
  }

  override async startWorkspace(body: Parameters<RunnerClient["startWorkspace"]>[0]) {
    if (body.workspaceKind === "host") throw new Error("本机 Local Runner 使用容器工作区");
    return super.startWorkspace(body);
  }

  override async getWorkspace(agentId: string) {
    const rows = (await this.local.runtime.list({ tenantId: this.local.tenantId, purpose: "workspace" }))
      .filter((row) => row.labels["zakura.agent"] === agentId);
    const row = rows.find((item) => item.status === "running") ?? rows[0];
    if (!row) return null;
    const novncPort = row.ports.find((port) => port.containerPort === 6080)?.hostPort ?? null;
    const cdpPort = row.ports.find((port) => port.containerPort === 9222)?.hostPort ?? null;
    return {
      dockerId: row.id,
      status: row.status,
      endpoints: {
        novncPort, cdpPort,
        novncUrl: novncPort ? `http://127.0.0.1:${novncPort}/vnc.html?autoconnect=true` : null,
        cdpUrl: cdpPort ? `http://127.0.0.1:${cdpPort}` : null,
      },
    };
  }

  override async stopWorkspace(agentId: string, remove = true) {
    await this.jobs.killAgent(agentId);
    await super.stopWorkspace(agentId, remove);
  }

  override async checkImageUpdates(body: Parameters<RunnerClient["checkImageUpdates"]>[0]) {
    return { images: await this.local.runtime.checkImageUpdates(body.images, body) };
  }

  override pullImage(...args: Parameters<RunnerClient["pullImage"]>) {
    return this.local.runtime.pullImage(...args);
  }

  override async refreshWorkspaceImage(body: Parameters<RunnerClient["refreshWorkspaceImage"]>[0]) {
    await this.pullImage(body.image);
    const recreated = body.recreateRunning === false ? []
      : await this.local.runtime.recreateWorkspaces(body.image, this.local.tenantId);
    return { image: body.image, status: "updated", recreated };
  }

  override async startStdio(agentId: string, command: string[], opts?: Parameters<RunnerClient["startStdio"]>[2]) {
    const dockerId = opts?.dockerId ?? (await this.getWorkspace(agentId))?.dockerId;
    if (!dockerId) throw new Error("本机工作区容器未运行");
    await this.local.requireContainer(dockerId);
    const exec = opts?.attach
      ? await this.local.runtime.attachStdio(dockerId)
      : await this.local.runtime.execStdio(dockerId, command, opts);
    return { ...exec.toWebStreams(), kill: () => exec.kill(), onStderr: (fn: (chunk: string) => void) => exec.onStderr(fn) };
  }

  private job(agentId: string, jobId: string): ShellJob {
    const job = this.jobs.getForAgent(agentId, jobId);
    if (!job) throw new Error("Shell job not found");
    return job;
  }

  private async startContainerJob(agentId: string, dockerId: string, command: string[], opts?: Parameters<RunnerClient["startExecJob"]>[2]) {
    await this.local.requireContainer(dockerId);
    const job = await this.local.runtime.execJob(dockerId, command, { agentId, ...opts });
    this.jobs.add(job);
    setTimeout(() => {
      if (job.snapshot().running) void job.kill();
      setTimeout(() => this.jobs.remove(job.id), 60_000).unref();
    }, opts?.timeoutMs ?? 300_000).unref();
    return job.snapshot();
  }

  override async startExecJob(agentId: string, command: string[], opts?: Parameters<RunnerClient["startExecJob"]>[2]) {
    const ws = await this.getWorkspace(agentId);
    if (!ws?.dockerId) throw new Error("本机工作区容器未运行");
    return this.startContainerJob(agentId, ws.dockerId, command, opts);
  }

  override async getExecJob(agentId: string, jobId: string) {
    return this.job(agentId, jobId).snapshot();
  }

  override async waitExecJob(agentId: string, jobId: string, waitMs: number, stdin?: string) {
    const job = this.job(agentId, jobId);
    if (stdin) job.write(stdin);
    return job.wait(waitMs);
  }

  override async killExecJob(agentId: string, jobId: string) {
    const job = this.job(agentId, jobId);
    await job.kill();
    return job.snapshot();
  }

  override async resizeExecJob(agentId: string, jobId: string, cols: number, rows: number) {
    await this.job(agentId, jobId).resize(cols, rows);
  }

  override async startAcpAdapterLoginShell(agentId: string, adapterId: string, opts?: Parameters<RunnerClient["startAcpAdapterLoginShell"]>[2]) {
    const name = `zakura-acpa-${agentId}-${adapterId}-${opts?.sessionKey ?? ""}`.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 63);
    const snap = await this.startContainerJob(agentId, name, opts?.command ?? ["sh"], { env: opts?.env, workingDir: "/workspace" });
    await this.resizeExecJob(agentId, snap.jobId, opts?.cols ?? 80, opts?.rows ?? 24);
    return snap;
  }
}
