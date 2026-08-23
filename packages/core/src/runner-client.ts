/**
 * Server-side HTTP client for a remote Runner Agent.
 */
import type { MigrationManifest, RunnerHostInfo } from "@zakura/shared";
import type {
  ListDetailedResult,
  ReadTextResult,
  WorkspaceFs,
  WorkspaceFsEntry,
} from "./workspace-fs.js";
import type { ShellJobSnapshot } from "./shell-job.js";

export type RunnerClientOptions = {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
};

export class RunnerClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RunnerClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      ...extra,
    };
  }

  async ping(): Promise<{
    ok: boolean;
    version?: string;
    storageRoot?: string;
    hostInfo?: RunnerHostInfo;
    docker?: { ok: boolean; version?: string; error?: string };
  }> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/ping`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      return { ok: false };
    }
    return (await res.json()) as {
      ok: boolean;
      version?: string;
      storageRoot?: string;
      hostInfo?: RunnerHostInfo;
      docker?: { ok: boolean; version?: string; error?: string };
    };
  }

  async systemVersion(): Promise<{
    version: string;
    image: string;
    containerId: string | null;
  }> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/system/version`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as {
      version: string;
      image: string;
      containerId: string | null;
    };
  }

  /**
   * Trigger a Runner self-update: pull `image`, then recreate the Runner
   * container with it. Returns once the recreation is scheduled; the Runner
   * will briefly disconnect while the container swaps.
   */
  async updateRunner(body: {
    image: string;
    recreateDelayMs?: number;
  }): Promise<{ image: string; scheduled: true }> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/system/update`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as { image: string; scheduled: true };
  }

  /**
   * Pull (refresh) a workspace image on the Runner, optionally recreating every
   * currently-running workspace container that uses it so the new image takes
   * effect immediately.
   */
  async refreshWorkspaceImage(body: {
    image: string;
    recreateRunning?: boolean;
  }): Promise<{
    image: string;
    status: string;
    recreated: Array<{ agentId: string; dockerId: string; name: string }>;
  }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/system/workspace-image/refresh`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as {
      image: string;
      status: string;
      recreated: Array<{ agentId: string; dockerId: string; name: string }>;
    };
  }

  /**
   * Probe the Runner's local image digests against their remote registry
   * digests (no pull). Returns one entry per image with `updateAvailable`
   * when the remote digest differs from the local one. The Server uses
   * this to show "镜像有更新" hints in the runner detail page.
   */
  async checkImageUpdates(body: {
    images: string[];
  }): Promise<{
    images: Array<{
      image: string;
      localDigest: string | null;
      remoteDigest: string | null;
      updateAvailable: boolean;
      runningStale: boolean;
      error: string | null;
    }>;
  }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/system/image-updates`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as {
      images: Array<{
        image: string;
        localDigest: string | null;
        remoteDigest: string | null;
        updateAvailable: boolean;
        runningStale: boolean;
        error: string | null;
      }>;
    };
  }

  async startWorkspace(body: {
    agentId: string;
    agentSlug: string;
    tenantSlug?: string;
    image?: string;
    network?: string;
    env?: Record<string, string>;
    labels?: Record<string, string>;
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
    const res = await this.fetchImpl(`${this.baseUrl}/v1/workspaces`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as { workspace: {
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
    } };
    return data.workspace;
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
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/workspaces/${encodeURIComponent(agentId)}`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as { workspace: {
      dockerId: string;
      status: string;
      endpoints: {
        novncPort: number | null;
        cdpPort: number | null;
        novncUrl: string | null;
        cdpUrl: string | null;
      };
    } | null };
    return data.workspace;
  }

  async stopWorkspace(agentId: string, remove = true): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/workspaces/${encodeURIComponent(agentId)}/stop`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ remove }),
      },
    );
    if (!res.ok) throw new Error(await res.text());
  }

  async startInstance(body: {
    instanceId: string;
    tenantId: string;
    name: string;
    image: string;
    env?: Record<string, string>;
    command?: string[];
    args?: string[];
    ports?: Array<{
      containerPort: number;
      hostPort?: number;
      hostIp?: string;
      protocol?: "tcp" | "udp";
    }>;
    volumes?: Array<{
      hostPath?: string;
      volumeName?: string;
      containerPath: string;
      readOnly?: boolean;
    }>;
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
    const { instanceId, ...spec } = body;
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/instances/${encodeURIComponent(instanceId)}/start`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(spec),
      },
    );
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as {
      instance: {
        dockerId: string;
        name: string;
        image: string;
        status: string;
        ports: Array<{ containerPort: number; hostPort?: number; protocol?: string }>;
        dataHostPath: string;
      };
    };
    return data.instance;
  }

  async getInstance(instanceId: string): Promise<{
    dockerId: string;
    name: string;
    image: string;
    status: string;
    ports: Array<{ containerPort: number; hostPort?: number; protocol?: string }>;
    dataHostPath: string;
  } | null> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/instances/${encodeURIComponent(instanceId)}`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as {
      instance: {
        dockerId: string;
        name: string;
        image: string;
        status: string;
        ports: Array<{ containerPort: number; hostPort?: number; protocol?: string }>;
        dataHostPath: string;
      } | null;
    };
    return data.instance;
  }

  async stopInstance(instanceId: string, remove = true): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/instances/${encodeURIComponent(instanceId)}/stop`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ remove }),
      },
    );
    if (!res.ok) throw new Error(await res.text());
  }

  async exportInstanceMigration(
    instanceId: string,
    body: {
      sourceNodeId: string;
      excludePatterns?: string[];
      includePatterns?: string[];
    },
  ): Promise<{ archive: Buffer; manifest: MigrationManifest; archiveSha256: string }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/instances/${encodeURIComponent(instanceId)}/migration/export`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(await res.text());
    const sha = res.headers.get("x-archive-sha256") ?? "";
    const manifestHeader = res.headers.get("x-migration-manifest");
    const archive = Buffer.from(await res.arrayBuffer());
    let manifest: MigrationManifest;
    if (manifestHeader) {
      manifest = JSON.parse(
        Buffer.from(manifestHeader, "base64url").toString("utf8"),
      ) as MigrationManifest;
    } else {
      manifest = {
        version: 1,
        agentId: instanceId,
        exportedAt: new Date().toISOString(),
        sourceNodeId: body.sourceNodeId,
        compression: "gzip",
        excludePatterns: body.excludePatterns ?? [],
        files: [],
        totalBytes: archive.length,
        fileCount: 0,
      };
    }
    return { archive, manifest, archiveSha256: sha };
  }

  async importInstanceMigration(
    instanceId: string,
    archive: Buffer,
    opts?: { expectedSha256?: string; atomic?: boolean },
  ): Promise<{ ok: true; fileCount: number; workspaceRoot: string }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/instances/${encodeURIComponent(instanceId)}/migration/import`,
      {
        method: "POST",
        headers: this.headers({
          "Content-Type": "application/octet-stream",
          ...(opts?.expectedSha256 ? { "X-Archive-Sha256": opts.expectedSha256 } : {}),
          ...(opts?.atomic === false ? { "X-Atomic": "0" } : {}),
        }),
        body: archive,
      },
    );
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as { ok: true; fileCount: number; workspaceRoot: string };
  }

  async execWorkspace(
    agentId: string,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/workspaces/${encodeURIComponent(agentId)}/exec`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          command,
          workingDir: opts?.workingDir,
          env: opts?.env,
          timeoutMs: opts?.timeoutMs,
        }),
      },
    );
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as { exitCode: number; stdout: string; stderr: string };
  }

  async startExecJob(
    agentId: string,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string>; timeoutMs?: number; stdin?: string },
  ): Promise<ShellJobSnapshot> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/workspaces/${encodeURIComponent(agentId)}/exec/jobs`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          command,
          workingDir: opts?.workingDir,
          env: opts?.env,
          timeoutMs: opts?.timeoutMs,
          stdin: opts?.stdin,
        }),
      },
    );
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as ShellJobSnapshot;
  }

  async getExecJob(agentId: string, jobId: string): Promise<ShellJobSnapshot> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/workspaces/${encodeURIComponent(agentId)}/exec/jobs/${encodeURIComponent(jobId)}`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as ShellJobSnapshot;
  }

  async waitExecJob(
    agentId: string,
    jobId: string,
    waitMs: number,
    stdin?: string,
  ): Promise<ShellJobSnapshot> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/workspaces/${encodeURIComponent(agentId)}/exec/jobs/${encodeURIComponent(jobId)}/wait`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ waitMs, stdin }),
      },
    );
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as ShellJobSnapshot;
  }

  async killExecJob(agentId: string, jobId: string): Promise<ShellJobSnapshot> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/workspaces/${encodeURIComponent(agentId)}/exec/jobs/${encodeURIComponent(jobId)}/kill`,
      { method: "POST", headers: this.headers() },
    );
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as ShellJobSnapshot;
  }

  async resizeExecJob(agentId: string, jobId: string, cols: number, rows: number): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/workspaces/${encodeURIComponent(agentId)}/exec/jobs/${encodeURIComponent(jobId)}/resize`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ cols, rows }),
      },
    );
    if (!res.ok) throw new Error(await res.text());
  }

  async startStdio(
    agentId: string,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string> },
  ): Promise<{
    writable: WritableStream<Uint8Array>;
    readable: ReadableStream<Uint8Array>;
    kill: () => Promise<void>;
    /** 订阅子进程 stderr（runner SSE 的 `t:"err"` 帧）。 */
    onStderr: (fn: (chunk: string) => void) => () => void;
  }> {
    const start = await this.fetchImpl(
      `${this.baseUrl}/v1/workspaces/${encodeURIComponent(agentId)}/exec/stdio`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          command,
          workingDir: opts?.workingDir,
          env: opts?.env,
        }),
      },
    );
    if (!start.ok) throw new Error(await start.text());
    const { id } = (await start.json()) as { id: string };
    const events = await this.fetchImpl(
      `${this.baseUrl}/v1/workspaces/${encodeURIComponent(agentId)}/exec/stdio/${encodeURIComponent(id)}`,
      { headers: this.headers({ Accept: "text/event-stream" }) },
    );
    if (!events.ok || !events.body) throw new Error(await events.text());

    const stderrListeners = new Set<(chunk: string) => void>();
    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = events.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            for (;;) {
              const idx = buf.indexOf("\n\n");
              if (idx < 0) break;
              const block = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const line = block
                .split("\n")
                .find((l) => l.startsWith("data: "));
              if (!line) continue;
              const msg = JSON.parse(line.slice(6)) as {
                t?: string;
                d?: string;
                code?: number | null;
              };
              if (msg.t === "out" && msg.d) {
                controller.enqueue(Uint8Array.from(Buffer.from(msg.d, "base64")));
              } else if (msg.t === "err" && msg.d) {
                for (const fn of stderrListeners) fn(msg.d);
              }
              if (msg.t === "exit") {
                controller.close();
                return;
              }
            }
          }
        } finally {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
    });

    const writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        const res = await this.fetchImpl(
          `${this.baseUrl}/v1/workspaces/${encodeURIComponent(agentId)}/exec/stdio/${encodeURIComponent(id)}/stdin`,
          {
            method: "POST",
            headers: this.headers({ "Content-Type": "application/octet-stream" }),
            body: chunk,
          },
        );
        if (!res.ok) throw new Error(await res.text());
      },
    });

    return {
      writable,
      readable,
      kill: async () => {
        await this.fetchImpl(
          `${this.baseUrl}/v1/workspaces/${encodeURIComponent(agentId)}/exec/stdio/${encodeURIComponent(id)}/kill`,
          { method: "POST", headers: this.headers() },
        ).catch(() => undefined);
      },
      onStderr: (fn) => {
        stderrListeners.add(fn);
        return () => {
          stderrListeners.delete(fn);
        };
      },
    };
  }

  async listDetailed(agentId: string, path: string): Promise<ListDetailedResult> {
    const url = new URL(`${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/fs/list`);
    url.searchParams.set("path", path || "/");
    const res = await this.fetchImpl(url, { headers: this.headers() });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as ListDetailedResult;
  }

  async readText(agentId: string, path: string): Promise<ReadTextResult> {
    const url = new URL(`${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/fs/read`);
    url.searchParams.set("path", path);
    const res = await this.fetchImpl(url, { headers: this.headers() });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as ReadTextResult;
  }

  async writeText(
    agentId: string,
    path: string,
    content: string,
    expectedRevision?: string | null,
  ): Promise<{ path: string; ok: true; revision: string }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/fs/write`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ path, content, expectedRevision }),
      },
    );
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as { path: string; ok: true; revision: string };
  }

  async mkdir(agentId: string, path: string): Promise<{ path: string; ok: true }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/fs/mkdir`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ path }),
      },
    );
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as { path: string; ok: true };
  }

  async delete(
    agentId: string,
    path: string,
    recursive?: boolean,
  ): Promise<{ path: string; ok: true }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/fs/delete`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ path, recursive }),
      },
    );
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as { path: string; ok: true };
  }

  async downloadBytes(
    agentId: string,
    path: string,
  ): Promise<{ data: Buffer; size: number; name: string }> {
    const url = new URL(
      `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/fs/download`,
    );
    url.searchParams.set("path", path);
    const res = await this.fetchImpl(url, { headers: this.headers() });
    if (!res.ok) throw new Error(await res.text());
    const data = Buffer.from(await res.arrayBuffer());
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = disposition.match(/filename="([^"]+)"/);
    const name = match?.[1] ? decodeURIComponent(match[1]) : path.split("/").filter(Boolean).pop() || "download";
    return { data, size: data.length, name };
  }

  async uploadBytes(
    agentId: string,
    path: string,
    data: Buffer,
  ): Promise<{ path: string; size: number }> {
    const form = new FormData();
    form.append("path", path);
    form.append("file", new Blob([data]), path.split("/").filter(Boolean).pop() || "upload");
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/fs/upload`,
      {
        method: "POST",
        headers: this.headers(),
        body: form,
      },
    );
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as { path: string; size: number };
  }

  async archivePaths(
    agentId: string,
    paths: string[],
  ): Promise<{ filename: string; buffer: Buffer }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/fs/archive`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ paths }),
      },
    );
    if (!res.ok) throw new Error(await res.text());
    const buffer = Buffer.from(await res.arrayBuffer());
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match?.[1] ? decodeURIComponent(match[1]) : "archive.tar.gz";
    return { filename, buffer };
  }

  async extractArchive(
    agentId: string,
    archivePath: string,
    destination?: string,
  ): Promise<{ destination: string; ok: true }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/fs/extract`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ path: archivePath, destination }),
      },
    );
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as { destination: string; ok: true };
  }

  async rename(
    agentId: string,
    oldPath: string,
    newPath: string,
  ): Promise<{ ok: true; path: string }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/fs/rename`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ oldPath, newPath }),
      },
    );
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as { ok: true; path: string };
  }

  async exportMigration(
    agentId: string,
    body: {
      sourceNodeId: string;
      excludePatterns?: string[];
      includePatterns?: string[];
    },
  ): Promise<{ archive: Buffer; manifest: MigrationManifest; archiveSha256: string }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/migration/export`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(await res.text());
    const sha = res.headers.get("x-archive-sha256") ?? "";
    const manifestHeader = res.headers.get("x-migration-manifest");
    const archive = Buffer.from(await res.arrayBuffer());
    let manifest: MigrationManifest;
    if (manifestHeader) {
      manifest = JSON.parse(Buffer.from(manifestHeader, "base64url").toString("utf8")) as MigrationManifest;
    } else {
      manifest = {
        version: 1,
        agentId,
        exportedAt: new Date().toISOString(),
        sourceNodeId: body.sourceNodeId,
        compression: "gzip",
        excludePatterns: body.excludePatterns ?? [],
        files: [],
        totalBytes: archive.length,
        fileCount: 0,
      };
    }
    return { archive, manifest, archiveSha256: sha };
  }

  async importMigration(
    agentId: string,
    archive: Buffer,
    opts?: { expectedSha256?: string; atomic?: boolean },
  ): Promise<{ ok: true; fileCount: number; workspaceRoot: string }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/migration/import`,
      {
        method: "POST",
        headers: this.headers({
          "Content-Type": "application/octet-stream",
          ...(opts?.expectedSha256 ? { "X-Archive-Sha256": opts.expectedSha256 } : {}),
          ...(opts?.atomic === false ? { "X-Atomic": "0" } : {}),
        }),
        body: archive,
      },
    );
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as { ok: true; fileCount: number; workspaceRoot: string };
  }

  /** 在远程 Runner 上启动 Cloudflare Quick Tunnel */
  async startExposure(input: {
    exposureId: string;
    agentId: string;
    port: number;
    provider?: string;
    protocol?: "http" | "https" | "tcp";
    ttlMinutes?: number;
  }): Promise<{ publicUrl: string; relayHost: string; relayPort: number }> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/exposures`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `startExposure failed (${res.status})`);
    }
    return (await res.json()) as {
      publicUrl: string;
      relayHost: string;
      relayPort: number;
    };
  }

  async stopExposure(exposureId: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/exposures/${encodeURIComponent(exposureId)}`,
      { method: "DELETE", headers: this.headers() },
    );
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw new Error(text || `stopExposure failed (${res.status})`);
    }
  }

  /** Build a WorkspaceFs that proxies all ops to this Runner for one agent. */
  workspaceFs(agentId: string): WorkspaceFs {
    const client = this;
    return {
      async stat(path: string) {
        const s = await client.statDetailed(agentId, path);
        return {
          path: s.path,
          type: s.isDir ? ("dir" as const) : ("file" as const),
          size: s.size,
          mtime: s.modTime,
        };
      },
      async statDetailed(path: string) {
        return client.statDetailed(agentId, path);
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
        return {
          path: t.path,
          content: t.content,
          truncated: false,
          totalLines: lines.length,
        };
      },
      async readText(path: string) {
        return client.readText(agentId, path);
      },
      async write(path: string, content: string) {
        const r = await client.writeText(agentId, path, content);
        return { path: r.path, bytes: Buffer.byteLength(content, "utf8") };
      },
      async writeText(path: string, content: string, expectedRevision?: string | null) {
        return client.writeText(agentId, path, content, expectedRevision);
      },
      async edit(path: string, oldText: string, newText: string) {
        const cur = await client.readText(agentId, path);
        if (!cur.content.includes(oldText)) throw new Error("old_text not found in file");
        const updated = cur.content.replace(oldText, newText);
        await client.writeText(agentId, path, updated);
        return { path: cur.path, ok: true as const };
      },
      async mkdir(path: string) {
        const r = await client.mkdir(agentId, path);
        return { path: r.path };
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
          await client.statDetailed(agentId, path);
          return true;
        } catch {
          return false;
        }
      },
      async readBytes(path: string) {
        const file = await client.downloadBytes(agentId, path);
        return { path, ...file };
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

  private async statDetailed(agentId: string, path: string): Promise<WorkspaceFsEntry> {
    const url = new URL(`${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/fs`);
    url.searchParams.set("path", path || "/");
    const res = await this.fetchImpl(url, { headers: this.headers() });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as WorkspaceFsEntry;
  }
}
