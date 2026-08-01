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
