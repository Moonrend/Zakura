import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { PathJailError, type WorkspaceFs } from "@zakura/core";
import {
  AGENT_PROJECTS_DIR,
  isSafeGitRemoteUrl,
  isValidProjectSlug,
  normalizeHooksByEvent,
  PROJECT_INSTRUCTION_FILES,
  projectRelativePath,
  projectSlugsFromList,
  projectWorkspacePath,
} from "@zakura/shared";
import type { Db } from "../db/client.js";
import { agentSchedules, cloudAgentSessions } from "../db/schema.js";
import type { AgentService } from "../services/agents.js";
import type { ServerWorkspaceFsProvider } from "../services/workspace-fs-provider.js";
import { platformEvents } from "../services/platform-events.js";
import {
  createProjectSkill,
  deleteProject,
  deleteProjectSkill,
  loadProjectConfig,
  ProjectFsError,
  readProjectSkillFile,
  renameProject,
  saveProjectHooks,
  saveProjectInstructions,
  saveProjectSkillFile,
} from "../services/project-config.js";

type SessionVars = {
  session?: { userId: string; tenantId: string; email: string; role: string };
};

/**
 * Rewrite absolute storage paths that leak out of Node's fs errors into their
 * `/workspace/...` equivalent.
 *
 * `ENOENT: … stat '/var/lib/zakura/agents/<id>/workspace/projects/x'` tells the
 * user nothing they can act on, exposes the deployment's layout, and — when a
 * model reads it — invites a retry against a host path that doesn't exist in the
 * sandbox.
 */
function scrubFsMessage(message: string): string {
  return message.replace(
    /(['"]?)((?:\/[^\s'"]*)?\/agents\/[A-Za-z0-9_-]+\/workspace)(\/[^\s'"]*)?\1?/g,
    (_all, _q, _root, rest) => `'/workspace${rest ?? ""}'`,
  );
}

function fsError(err: unknown): { status: 400 | 403 | 404 | 409 | 500 | 503; body: { error: string } } {
  if (err instanceof PathJailError) {
    return { status: 403, body: { error: scrubFsMessage(err.message) } };
  }
  const message = scrubFsMessage(err instanceof Error ? err.message : String(err));
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
  // 节点掉线 / 排空 / 未注册 / 鉴权失效：503 让前端提示迁移，而非裸 500
  if (/当前离线|正在排空|尚未完成注册|鉴权信息失效|节点已不存在|需要远程运行节点/.test(message)) {
    return { status: 503, body: { error: message } };
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
  db: Db,
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

  app.get("/api/agents/:id/projects", async (c) => {
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
      const projects = await listWorkspaceProjects(resolved.fs);
      return c.json({ projects });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/api/agents/:id/projects", async (c) => {
    const session = c.get("session")!;
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    const body = await c.req
      .json<{ name?: string; gitUrl?: string }>()
      .catch(() => ({} as { name?: string; gitUrl?: string }));
    const name = (body.name ?? "").trim();
    if (!isValidProjectSlug(name)) {
      return c.json({ error: "无效的项目名（字母数字开头，可含 . _ -）" }, 400);
    }
    const gitUrl = typeof body.gitUrl === "string" ? body.gitUrl.trim() : "";
    if (gitUrl && !isSafeGitRemoteUrl(gitUrl)) {
      return c.json({ error: "gitUrl 仅支持 https:// 或 git@host:path" }, 400);
    }
    const rel = projectRelativePath(name);
    try {
      if (await resolved.fs.exists(rel)) {
        return c.json({ error: "项目已存在" }, 409);
      }
      if (!(await resolved.fs.exists(AGENT_PROJECTS_DIR))) {
        await resolved.fs.mkdir(AGENT_PROJECTS_DIR);
      }
      await resolved.fs.mkdir(rel);
      platformEvents.publish(resolved.agent.tenantId, {
        type: "agent_fs_changed",
        agentId: resolved.agent.id,
        path: `/${rel}`,
      });
      let cloneError: string | undefined;
      if (gitUrl) {
        try {
          const dest = projectWorkspacePath(name);
          const started = await agentService.workspace.startShellJob(
            resolved.agent,
            ["git", "clone", "--depth", "1", "--", gitUrl, dest],
            { timeoutMs: 120_000 },
          );
          const snap = await agentService.workspace.waitShellJob(
            resolved.agent,
            started.jobId,
            120_000,
          );
          if (snap.exitCode !== 0) {
            cloneError =
              (snap.stderr || snap.stdout || `git clone exited ${snap.exitCode}`).slice(0, 800);
          }
        } catch (err) {
          cloneError = err instanceof Error ? err.message : String(err);
        }
      }
      return c.json(
        {
          project: { name, path: projectWorkspacePath(name) },
          ...(cloneError ? { cloneError } : {}),
        },
        201,
      );
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.patch("/api/agents/:id/projects/:slug", async (c) => {
    const session = c.get("session")!;
    const from = c.req.param("slug");
    if (!isValidProjectSlug(from)) return c.json({ error: "无效的项目名" }, 400);
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
    const to = (body.name ?? "").trim();
    try {
      const project = await renameProject(resolved.fs, from, to);
      if (from !== to) {
        await rebindProjectRefs(db, resolved.agent.tenantId, resolved.agent.id, from, to);
        platformEvents.publish(resolved.agent.tenantId, {
          type: "agent_fs_changed",
          agentId: resolved.agent.id,
          path: `/${projectRelativePath(from)}`,
        });
        platformEvents.publish(resolved.agent.tenantId, {
          type: "agent_fs_changed",
          agentId: resolved.agent.id,
          path: `/${projectRelativePath(to)}`,
        });
      }
      return c.json({ project });
    } catch (err) {
      if (err instanceof ProjectFsError) return c.json({ error: err.message }, err.status);
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.delete("/api/agents/:id/projects/:slug", async (c) => {
    const session = c.get("session")!;
    const slug = c.req.param("slug");
    if (!isValidProjectSlug(slug)) return c.json({ error: "无效的项目名" }, 400);
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    try {
      const deleted = await deleteProject(resolved.fs, slug);
      await rebindProjectRefs(db, resolved.agent.tenantId, resolved.agent.id, slug, null);
      if (deleted) {
        platformEvents.publish(resolved.agent.tenantId, {
          type: "agent_fs_changed",
          agentId: resolved.agent.id,
          path: `/${projectRelativePath(slug)}`,
        });
      }
      return c.json({ ok: true, deleted });
    } catch (err) {
      if (err instanceof ProjectFsError) return c.json({ error: err.message }, err.status);
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.get("/api/agents/:id/projects/:slug/config", async (c) => {
    const session = c.get("session")!;
    const slug = c.req.param("slug");
    if (!isValidProjectSlug(slug)) return c.json({ error: "无效的项目名" }, 400);
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    try {
      const config = await loadProjectConfig(resolved.fs, slug);
      return c.json({ config });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.put("/api/agents/:id/projects/:slug/instructions", async (c) => {
    const session = c.get("session")!;
    const slug = c.req.param("slug");
    if (!isValidProjectSlug(slug)) return c.json({ error: "无效的项目名" }, 400);
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    const body = await c.req
      .json<{ content?: string; file?: string }>()
      .catch(() => ({} as { content?: string; file?: string }));
    const file = PROJECT_INSTRUCTION_FILES.includes(
      body.file as (typeof PROJECT_INSTRUCTION_FILES)[number],
    )
      ? (body.file as (typeof PROJECT_INSTRUCTION_FILES)[number])
      : "AGENTS.md";
    try {
      if (!(await resolved.fs.exists(projectRelativePath(slug)))) {
        return c.json({ error: "项目目录不存在" }, 404);
      }
      const saved = await saveProjectInstructions(resolved.fs, slug, body.content ?? "", file);
      platformEvents.publish(resolved.agent.tenantId, {
        type: "agent_fs_changed",
        agentId: resolved.agent.id,
        path: saved.path,
      });
      const config = await loadProjectConfig(resolved.fs, slug);
      return c.json({ config, path: saved.path });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.put("/api/agents/:id/projects/:slug/hooks", async (c) => {
    const session = c.get("session")!;
    const slug = c.req.param("slug");
    if (!isValidProjectSlug(slug)) return c.json({ error: "无效的项目名" }, 400);
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    const body = await c.req
      .json<{ events?: unknown; file?: string | null }>()
      .catch(() => ({} as { events?: unknown; file?: string | null }));
    try {
      if (!(await resolved.fs.exists(projectRelativePath(slug)))) {
        return c.json({ error: "项目目录不存在" }, 404);
      }
      const events = normalizeHooksByEvent(body.events);
      const saved = await saveProjectHooks(resolved.fs, slug, events, body.file);
      platformEvents.publish(resolved.agent.tenantId, {
        type: "agent_fs_changed",
        agentId: resolved.agent.id,
        path: saved.path,
      });
      const config = await loadProjectConfig(resolved.fs, slug);
      return c.json({ config, path: saved.path });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/api/agents/:id/projects/:slug/skills", async (c) => {
    const session = c.get("session")!;
    const slug = c.req.param("slug");
    if (!isValidProjectSlug(slug)) return c.json({ error: "无效的项目名" }, 400);
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    const body = await c.req
      .json<{ name?: string; description?: string; body?: string }>()
      .catch(() => ({} as { name?: string; description?: string; body?: string }));
    try {
      if (!(await resolved.fs.exists(projectRelativePath(slug)))) {
        return c.json({ error: "项目目录不存在" }, 404);
      }
      const skill = await createProjectSkill(resolved.fs, slug, {
        name: body.name ?? "",
        description: body.description ?? "",
        body: body.body,
      });
      platformEvents.publish(resolved.agent.tenantId, {
        type: "agent_fs_changed",
        agentId: resolved.agent.id,
        path: skill.path,
      });
      const config = await loadProjectConfig(resolved.fs, slug);
      return c.json({ skill, config }, 201);
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.get("/api/agents/:id/projects/:slug/skills/:name/file", async (c) => {
    const session = c.get("session")!;
    const slug = c.req.param("slug");
    const name = c.req.param("name");
    if (!isValidProjectSlug(slug)) return c.json({ error: "无效的项目名" }, 400);
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    try {
      const file = await readProjectSkillFile(resolved.fs, slug, name, c.req.query("path"));
      if (!file) return c.json({ error: "技能不存在" }, 404);
      return c.json(file);
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.put("/api/agents/:id/projects/:slug/skills/:name", async (c) => {
    const session = c.get("session")!;
    const slug = c.req.param("slug");
    const name = c.req.param("name");
    if (!isValidProjectSlug(slug)) return c.json({ error: "无效的项目名" }, 400);
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    const body = await c.req.json<{ content?: string }>().catch(() => ({} as { content?: string }));
    if (typeof body.content !== "string") return c.json({ error: "content 必填" }, 400);
    try {
      const saved = await saveProjectSkillFile(resolved.fs, slug, name, body.content);
      platformEvents.publish(resolved.agent.tenantId, {
        type: "agent_fs_changed",
        agentId: resolved.agent.id,
        path: saved.path,
      });
      const config = await loadProjectConfig(resolved.fs, slug);
      return c.json({ config, path: saved.path });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.delete("/api/agents/:id/projects/:slug/skills/:name", async (c) => {
    const session = c.get("session")!;
    const slug = c.req.param("slug");
    const name = c.req.param("name");
    if (!isValidProjectSlug(slug)) return c.json({ error: "无效的项目名" }, 400);
    const resolved = await resolveAgentFs(
      agentService,
      fsProvider,
      session.tenantId,
      c.req.param("id"),
    );
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (resolved.denied) return c.json({ error: "Filesystem not enabled for this agent" }, 403);
    try {
      const ok = await deleteProjectSkill(resolved.fs, slug, name);
      if (!ok) return c.json({ error: "技能不存在" }, 404);
      platformEvents.publish(resolved.agent.tenantId, {
        type: "agent_fs_changed",
        agentId: resolved.agent.id,
        path: `/${projectRelativePath(slug)}/.agents/skills/${name}`,
      });
      const config = await loadProjectConfig(resolved.fs, slug);
      return c.json({ config });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });
}

async function listWorkspaceProjects(
  fs: WorkspaceFs,
): Promise<Array<{ name: string; path: string }>> {
  if (!(await fs.exists(AGENT_PROJECTS_DIR))) {
    await fs.mkdir(AGENT_PROJECTS_DIR);
    return [];
  }
  const listed = await fs.list(AGENT_PROJECTS_DIR);
  return projectSlugsFromList(listed.entries).map((name) => ({
    name,
    path: projectWorkspacePath(name),
  }));
}

/** 目录改名/删除后，会话与定时任务上的 slug 跟着改（含子代理）。 */
async function rebindProjectRefs(
  db: Db,
  tenantId: string,
  agentId: string,
  from: string,
  to: string | null,
) {
  const now = new Date();
  await db
    .update(cloudAgentSessions)
    .set({ project: to, updatedAt: now })
    .where(
      and(
        eq(cloudAgentSessions.tenantId, tenantId),
        eq(cloudAgentSessions.agentId, agentId),
        eq(cloudAgentSessions.project, from),
      ),
    );
  await db
    .update(agentSchedules)
    .set({ project: to, updatedAt: now })
    .where(
      and(
        eq(agentSchedules.tenantId, tenantId),
        eq(agentSchedules.agentId, agentId),
        eq(agentSchedules.project, from),
      ),
    );
}
