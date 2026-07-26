import type { Hono } from "hono";
import { PathJailError, type WorkspaceFs } from "@zakura/core";
import type { AgentService } from "../services/agents.js";
import type { ServerWorkspaceFsProvider } from "../services/workspace-fs-provider.js";

type SessionVars = {
  session?: { userId: string; tenantId: string; email: string; role: string };
};

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

async function resolveAgentFs(
  agentService: AgentService,
  fsProvider: ServerWorkspaceFsProvider,
  tenantId: string,
  agentId: string,
  requireFs = true,
): Promise<
  | null
  | { agent: NonNullable<Awaited<ReturnType<AgentService["get"]>>>; denied: true }
  | {
      agent: NonNullable<Awaited<ReturnType<AgentService["get"]>>>;
      denied: false;
      fs: WorkspaceFs;
    }
> {
  const agent = await agentService.get(tenantId, agentId);
  if (!agent) return null;
  if (requireFs && !agent.enableFs) {
    return { agent, denied: true as const };
  }
  const fs = await fsProvider.forAgentBinding({
    id: agent.id,
    tenantId: agent.tenantId,
    runtimeNodeId: agent.runtimeNodeId,
  });
  return { agent, fs, denied: false as const };
}

/**
 * Agent workspace filesystem HTTP API.
 * 所有操作统一经 WorkspaceFsProvider，本机与远程 Runner 共用同一接口。
 */
export function registerAgentFsRoutes(
  app: Hono<{ Variables: SessionVars }>,
  agentService: AgentService,
  fsProvider: ServerWorkspaceFsProvider,
) {
  app.get("/api/agents/:id/fs", async (c) => {
    const session = c.get("session")!;
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    const path = c.req.query("path") || "/";
    try {
      return c.json(await resolved.fs.statDetailed(path));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.get("/api/agents/:id/fs/list", async (c) => {
    const session = c.get("session")!;
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    const path = c.req.query("path") || "/";
    try {
      return c.json(await resolved.fs.listDetailed(path));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.get("/api/agents/:id/fs/read", async (c) => {
    const session = c.get("session")!;
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    const path = c.req.query("path");
    if (!path?.trim()) return c.json({ error: "path is required" }, 400);
    try {
      return c.json(await resolved.fs.readText(path));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.get("/api/agents/:id/fs/download", async (c) => {
    const session = c.get("session")!;
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    const path = c.req.query("path");
    if (!path?.trim()) return c.json({ error: "path is required" }, 400);
    try {
      const file = await resolved.fs.readBytes(path);
      return new Response(file.data, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(file.size),
          "Content-Disposition": `attachment; filename="${encodeURIComponent(file.name)}"`,
        },
      });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/api/agents/:id/fs/archive", async (c) => {
    const session = c.get("session")!;
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    const body = await c.req.json<{ paths?: string[] }>().catch(() => ({} as { paths?: string[] }));
    const paths = body.paths ?? [];
    try {
      const { filename, buffer } = await resolved.fs.archive(paths);
      return new Response(buffer, {
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
        },
      });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/api/agents/:id/fs/write", async (c) => {
    const session = c.get("session")!;
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    const body = await c.req.json<{
      path?: string;
      content?: string;
      expectedRevision?: string;
    }>();
    if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);
    try {
      return c.json(
        await resolved.fs.writeText(body.path, body.content ?? "", body.expectedRevision),
      );
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/api/agents/:id/fs/upload", async (c) => {
    const session = c.get("session")!;
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);

    try {
      const form = await c.req.parseBody();
      const destPath = String(form.path ?? "").trim();
      if (!destPath) return c.json({ error: "path is required" }, 400);
      const file = form.file;
      if (!file || typeof file === "string") {
        return c.json({ error: "file is required" }, 400);
      }
      const data = Buffer.from(await file.arrayBuffer());
      return c.json(await resolved.fs.writeBytes(destPath, data));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/api/agents/:id/fs/mkdir", async (c) => {
    const session = c.get("session")!;
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    const body = await c.req.json<{ path?: string }>();
    if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);
    try {
      return c.json(await resolved.fs.mkdirApi(body.path));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/api/agents/:id/fs/delete", async (c) => {
    const session = c.get("session")!;
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    const body = await c.req.json<{ path?: string; recursive?: boolean }>();
    if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);
    try {
      return c.json(await resolved.fs.deleteApi(body.path, Boolean(body.recursive)));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/api/agents/:id/fs/rename", async (c) => {
    const session = c.get("session")!;
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    const body = await c.req.json<{ oldPath?: string; newPath?: string }>();
    if (!body.oldPath?.trim() || !body.newPath?.trim()) {
      return c.json({ error: "oldPath and newPath are required" }, 400);
    }
    try {
      return c.json(await resolved.fs.renameApi(body.oldPath, body.newPath));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/api/agents/:id/fs/extract", async (c) => {
    const session = c.get("session")!;
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    const body = await c.req.json<{ path?: string; destination?: string }>();
    if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);
    try {
      return c.json(await resolved.fs.extract(body.path, body.destination));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });
}
