import { Hono } from "hono";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  LocalWorkspaceFs,
  PathJailError,
  exportWorkspace,
  importWorkspace,
} from "@zakura/core";
import type { RunnerAuthConfig } from "./auth.js";
import { requireRunnerAuth, tokenMatches, extractBearer } from "./auth.js";
import { collectHostInfo } from "./host-info.js";
import { RunnerDockerWorkspace } from "./docker-workspace.js";

export type RunnerConfig = {
  storageRoot: string;
  token: string;
  auth: RunnerAuthConfig;
  version: string;
  publicUrl?: string;
  serverUrl?: string;
  /** Prefer ZAKURA_RUNNER_PUBLIC_HOST for CDP/noVNC URLs */
  publicHost?: string;
};

function agentWorkspaceRoot(storageRoot: string, agentId: string): string {
  return join(storageRoot, "agents", agentId, "workspace");
}

function fsError(err: unknown): { status: 400 | 403 | 404 | 409 | 500; body: { error: string } } {
  if (err instanceof PathJailError) {
    return { status: 403, body: { error: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  if (
    err &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  ) {
    const status = (err as { status: number }).status;
    if (status === 409) return { status: 409, body: { error: message } };
  }
  if (code === "ENOENT" || message.includes("ENOENT") || message.includes("no such file")) {
    return { status: 404, body: { error: message } };
  }
  return { status: 400, body: { error: message } };
}

function getFs(storageRoot: string, agentId: string): LocalWorkspaceFs {
  const root = agentWorkspaceRoot(storageRoot, agentId);
  mkdirSync(root, { recursive: true });
  return new LocalWorkspaceFs(root);
}

export function createRunnerApp(cfg: RunnerConfig): Hono {
  const app = new Hono();
  const publicHost =
    cfg.publicHost ||
    process.env.ZAKURA_RUNNER_PUBLIC_HOST ||
    (() => {
      try {
        return cfg.publicUrl ? new URL(cfg.publicUrl).hostname : "127.0.0.1";
      } catch {
        return "127.0.0.1";
      }
    })();
  const dockerWs = new RunnerDockerWorkspace(cfg.storageRoot, publicHost);

  app.get("/health", (c) => c.json({ ok: true, service: "zakura-runner" }));

  app.get("/v1/ping", async (c) => {
    const hostInfo = collectHostInfo(cfg.storageRoot, cfg.publicUrl);
    const docker = await dockerWs.ping();
    return c.json({
      ok: true,
      version: cfg.version,
      storageRoot: cfg.storageRoot,
      hostInfo: {
        ...hostInfo,
        dockerVersion: docker.ok ? docker.version : hostInfo.dockerVersion,
      },
      docker,
    });
  });

  // All other /v1/* require auth
  app.use("/v1/*", requireRunnerAuth(cfg.auth));

  // --- Workspace lifecycle ---
  app.post("/v1/workspaces", async (c) => {
    type Body = {
      agentId?: string;
      agentSlug?: string;
      tenantSlug?: string;
      image?: string;
      network?: string;
      env?: Record<string, string>;
      labels?: Record<string, string>;
    };
    const body = (await c.req.json().catch(() => ({}))) as Body;
    if (!body.agentId?.trim() || !body.agentSlug?.trim()) {
      return c.json({ error: "agentId and agentSlug are required" }, 400);
    }
    try {
      const info = await dockerWs.start({
        agentId: body.agentId,
        agentSlug: body.agentSlug,
        tenantSlug: body.tenantSlug,
        image: body.image || "sunwuyuan/zakura-workspace-dev:debian",
        network: body.network,
        env: body.env,
        labels: body.labels,
      });
      return c.json({ workspace: info }, 201);
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status === 403 ? 403 : 500);
    }
  });

  app.get("/v1/workspaces/:agentId", async (c) => {
    try {
      const info = await dockerWs.findByAgent(c.req.param("agentId"));
      if (!info) return c.json({ workspace: null });
      return c.json({ workspace: info });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, 500);
    }
  });

  app.post("/v1/workspaces/:agentId/stop", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { remove?: boolean };
    try {
      await dockerWs.stop(c.req.param("agentId"), body.remove !== false);
      return c.json({ ok: true });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, 500);
    }
  });

  app.delete("/v1/workspaces/:agentId", async (c) => {
    try {
      await dockerWs.stop(c.req.param("agentId"), true);
      return c.json({ ok: true });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, 500);
    }
  });

  app.post("/v1/workspaces/:agentId/exec", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      command?: string[];
      workingDir?: string;
      env?: Record<string, string>;
    };
    if (!body.command?.length) return c.json({ error: "command is required" }, 400);
    try {
      const result = await dockerWs.exec(c.req.param("agentId"), body.command, {
        workingDir: body.workingDir,
        env: body.env,
      });
      return c.json(result);
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status === 404 ? 404 : 400);
    }
  });

  app.get("/v1/workspaces/:agentId/endpoints", async (c) => {
    try {
      const info = await dockerWs.findByAgent(c.req.param("agentId"));
      if (!info) return c.json({ error: "Not found" }, 404);
      return c.json({ endpoints: info.endpoints, status: info.status });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, 500);
    }
  });

  // --- FS ---
  app.get("/v1/agents/:agentId/fs", async (c) => {
    const fs = getFs(cfg.storageRoot, c.req.param("agentId"));
    const path = c.req.query("path") || "/";
    try {
      return c.json(await fs.statDetailed(path));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.get("/v1/agents/:agentId/fs/list", async (c) => {
    const fs = getFs(cfg.storageRoot, c.req.param("agentId"));
    const path = c.req.query("path") || "/";
    try {
      return c.json(await fs.listDetailed(path));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.get("/v1/agents/:agentId/fs/read", async (c) => {
    const fs = getFs(cfg.storageRoot, c.req.param("agentId"));
    const path = c.req.query("path");
    if (!path?.trim()) return c.json({ error: "path is required" }, 400);
    try {
      return c.json(await fs.readText(path));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/v1/agents/:agentId/fs/write", async (c) => {
    const fs = getFs(cfg.storageRoot, c.req.param("agentId"));
    type WriteBody = { path?: string; content?: string; expectedRevision?: string | null };
    const body = (await c.req.json().catch(() => ({}))) as WriteBody;
    if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);
    if (typeof body.content !== "string") return c.json({ error: "content is required" }, 400);
    try {
      return c.json(await fs.writeText(body.path, body.content, body.expectedRevision));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/v1/agents/:agentId/fs/mkdir", async (c) => {
    const fs = getFs(cfg.storageRoot, c.req.param("agentId"));
    const body = await c.req.json<{ path?: string }>().catch(() => ({} as { path?: string }));
    if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);
    try {
      return c.json(await fs.mkdirApi(body.path));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/v1/agents/:agentId/fs/delete", async (c) => {
    const fs = getFs(cfg.storageRoot, c.req.param("agentId"));
    const body = await c.req
      .json<{ path?: string; recursive?: boolean }>()
      .catch(() => ({} as { path?: string; recursive?: boolean }));
    if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);
    try {
      return c.json(await fs.deleteApi(body.path, body.recursive));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/v1/agents/:agentId/fs/edit", async (c) => {
    const fs = getFs(cfg.storageRoot, c.req.param("agentId"));
    const body = await c.req
      .json<{ path?: string; oldText?: string; newText?: string }>()
      .catch(() => ({} as { path?: string; oldText?: string; newText?: string }));
    if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);
    try {
      return c.json(await fs.edit(body.path, body.oldText ?? "", body.newText ?? ""));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  // --- Migration ---
  app.post("/v1/agents/:agentId/migration/export", async (c) => {
    const agentId = c.req.param("agentId");
    const body = await c.req
      .json<{
        sourceNodeId?: string;
        excludePatterns?: string[];
        includePatterns?: string[];
      }>()
      .catch(
        () =>
          ({} as {
            sourceNodeId?: string;
            excludePatterns?: string[];
            includePatterns?: string[];
          }),
      );
    const root = agentWorkspaceRoot(cfg.storageRoot, agentId);
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    try {
      const result = await exportWorkspace({
        agentId,
        sourceNodeId: body.sourceNodeId ?? "unknown",
        workspaceRoot: root,
        excludePatterns: body.excludePatterns,
        includePatterns: body.includePatterns,
      });
      const manifestB64 = Buffer.from(JSON.stringify(result.manifest), "utf8").toString(
        "base64url",
      );
      return new Response(result.archive, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(result.archive.length),
          "X-Archive-Sha256": result.archiveSha256,
          "X-Migration-Manifest": manifestB64,
        },
      });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/v1/agents/:agentId/migration/import", async (c) => {
    const agentId = c.req.param("agentId");
    const expectedSha = c.req.header("x-archive-sha256") ?? undefined;
    const atomic = c.req.header("x-atomic") !== "0";
    try {
      const buf = Buffer.from(await c.req.arrayBuffer());
      const root = agentWorkspaceRoot(cfg.storageRoot, agentId);
      const result = await importWorkspace({
        archive: buf,
        targetWorkspaceRoot: root,
        atomic,
        expectedSha256: expectedSha,
      });
      return c.json({
        ok: true as const,
        fileCount: result.fileCount,
        workspaceRoot: result.workspaceRoot,
      });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.get("/v1/agents/:agentId/workspace/usage", async (c) => {
    const agentId = c.req.param("agentId");
    const root = agentWorkspaceRoot(cfg.storageRoot, agentId);
    const fs = getFs(cfg.storageRoot, agentId);
    try {
      const listed = await fs.list(".", { recursive: true, limit: 500 });
      let bytes = 0;
      let files = 0;
      for (const e of listed.entries) {
        if (e.type === "file") {
          files++;
          bytes += e.size ?? 0;
        }
      }
      return c.json({ bytesUsed: bytes, fileCount: files, path: root });
    } catch {
      return c.json({ bytesUsed: 0, fileCount: 0, path: root });
    }
  });

  // Auth probe helper used by tests
  app.get("/v1/auth-check", (c) => {
    const raw = extractBearer(c.req.header("authorization"));
    if (!tokenMatches(raw, cfg.auth)) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ ok: true });
  });

  return app;
}

export { agentWorkspaceRoot };
