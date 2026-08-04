/**
 * 技能 HTTP API：商店检索、来源解析预览、安装到 Agent、注册表与单 Agent 管理。
 */
import type { Hono } from "hono";
import type { SkillStoreId, SkillTokenScope } from "@zakura/shared";
import { DEFAULT_SKILL_STORE, SKILL_STORES } from "@zakura/shared";
import type { AgentService } from "../services/agents.js";
import { SkillSourceError, type SkillsService } from "../services/skills/index.js";
import { BUILTIN_SKILLS } from "../services/skills/builtin.js";

type SessionVars = {
  session?: {
    userId: string;
    tenantId: string;
    email: string;
    role: string;
    isPlatformAdmin?: boolean;
  };
};

/**
 * 平台令牌只有超管能配。多租户下必须是 isPlatformAdmin；
 * OSS 单租户没有超管概念，租户管理员即可。
 */
function canManagePlatformToken(
  session: NonNullable<SessionVars["session"]>,
  multiTenant: boolean,
): boolean {
  if (multiTenant) return session.isPlatformAdmin === true;
  return session.role === "owner" || session.role === "admin";
}

function errorResponse(err: unknown): { status: 400 | 404 | 502; body: { error: string } } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof SkillSourceError) {
    if (/不存在|未找到|未知/.test(message)) return { status: 404, body: { error: message } };
    return { status: 400, body: { error: message } };
  }
  if (/超时|网络错误|限流/.test(message)) return { status: 502, body: { error: message } };
  return { status: 400, body: { error: message } };
}

function parseStore(raw: string | undefined): SkillStoreId {
  return SKILL_STORES.some((s) => s.id === raw)
    ? (raw as SkillStoreId)
    : DEFAULT_SKILL_STORE;
}

export function registerSkillRoutes(
  app: Hono<{ Variables: SessionVars }>,
  deps: { skills: SkillsService; agentService: AgentService; multiTenant?: boolean },
) {
  const { skills, agentService } = deps;
  const isPlatformAdmin = (session: NonNullable<SessionVars["session"]>) =>
    canManagePlatformToken(session, deps.multiTenant ?? false);

  /** 商店元信息 + 内置技能目录 */
  app.get("/api/skills/stores", (c) =>
    c.json({
      stores: SKILL_STORES,
      builtin: BUILTIN_SKILLS.map((s) => ({
        name: s.name,
        title: s.title,
        description: s.description,
        recommended: s.recommended ?? false,
        requires: s.requires ?? [],
        tags: s.tags ?? [],
      })),
    }),
  );

  /** 单商店检索（分页；repo= 时只浏览该仓库内的技能） */
  app.get("/api/skills/search", async (c) => {
    const session = c.get("session")!;
    const query = c.req.query("q") ?? "";
    const store = parseStore(c.req.query("store"));
    const repoSlug = c.req.query("repo") ?? undefined;
    const offset = Number.parseInt(c.req.query("offset") ?? "0", 10) || 0;
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "", 10);
    try {
      const page = await skills.search(session.tenantId, {
        query,
        store,
        repoSlug,
        offset,
        ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: limitRaw } : {}),
      });
      return c.json(page);
    } catch (err) {
      const e = errorResponse(err);
      return c.json(e.body, e.status);
    }
  });

  /** 已同步到平台的技能仓库（商店入口） */
  app.get("/api/skills/repos", async (c) => {
    try {
      return c.json({ repos: await skills.listRepos() });
    } catch (err) {
      const e = errorResponse(err);
      return c.json(e.body, e.status);
    }
  });

  /** 立即同步某个仓库到平台缓存 */
  app.post("/api/skills/repos/:owner/:repo/sync", async (c) => {
    const slug = `${c.req.param("owner")}/${c.req.param("repo")}`;
    try {
      const summary = await skills.syncRepo(slug);
      if (!summary) return c.json({ error: `同步失败：${slug}` }, 502);
      return c.json({ repo: summary });
    } catch (err) {
      const e = errorResponse(err);
      return c.json(e.body, e.status);
    }
  });

  /** 平台缓存概况 */
  app.get("/api/skills/cache", async (c) => {
    try {
      return c.json(await skills.cacheStatus());
    } catch (err) {
      const e = errorResponse(err);
      return c.json(e.body, e.status);
    }
  });

  // —— 自动更新 ——

  /** 自动更新开关 + 上次运行结果 + 当前待更新数量 */
  app.get("/api/skills/auto-update", async (c) => {
    const session = c.get("session")!;
    try {
      return c.json(await skills.autoUpdateStatus(session.tenantId));
    } catch (err) {
      const e = errorResponse(err);
      return c.json(e.body, e.status);
    }
  });

  app.put("/api/skills/auto-update", async (c) => {
    const session = c.get("session")!;
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled is required" }, 400);
    }
    try {
      return c.json(await skills.setAutoUpdate(session.tenantId, body.enabled));
    } catch (err) {
      const e = errorResponse(err);
      return c.json(e.body, e.status);
    }
  });

  /** 立即检查并更新（只更新各自开启了自动更新的第三方技能；内置始终同步） */
  app.post("/api/skills/check-updates", async (c) => {
    const session = c.get("session")!;
    try {
      const result = await skills.checkUpdatesNow(session.tenantId);
      const status = await skills.autoUpdateStatus(session.tenantId);
      return c.json({ result, status });
    } catch (err) {
      const e = errorResponse(err);
      return c.json(e.body, e.status);
    }
  });

  /** 单技能自动更新开关 */
  app.patch("/api/skills/:id/auto-update", async (c) => {
    const session = c.get("session")!;
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled is required" }, 400);
    }
    try {
      return c.json({
        skill: await skills.setSkillAutoUpdate(session.tenantId, c.req.param("id"), body.enabled),
      });
    } catch (err) {
      const e = errorResponse(err);
      return c.json(e.body, e.status);
    }
  });

  // —— 来源令牌 ——

  /** 列出可见令牌：租户自备的，加上（管理员可见的）平台默认 */
  app.get("/api/skills/tokens", async (c) => {
    const session = c.get("session")!;
    const isAdmin = isPlatformAdmin(session);
    try {
      const tokens = await skills.tokenStore.list(session.tenantId, isAdmin);
      return c.json({ tokens, canManagePlatform: isAdmin });
    } catch (err) {
      const e = errorResponse(err);
      return c.json(e.body, e.status);
    }
  });

  app.put("/api/skills/tokens/:provider", async (c) => {
    const session = c.get("session")!;
    const provider = c.req.param("provider") === "gitlab" ? "gitlab" : "github";
    const body = (await c.req.json().catch(() => ({}))) as {
      token?: string;
      label?: string;
      scope?: SkillTokenScope;
    };
    const scope: SkillTokenScope = body.scope === "platform" ? "platform" : "tenant";
    if (scope === "platform" && !isPlatformAdmin(session)) {
      return c.json({ error: "配置平台令牌需要平台管理员权限" }, 403);
    }
    if (!body.token?.trim()) return c.json({ error: "token is required" }, 400);
    try {
      const info = await skills.tokenStore.set({
        scope,
        tenantId: session.tenantId,
        provider,
        token: body.token,
        label: body.label,
      });
      return c.json({ token: info });
    } catch (err) {
      const e = errorResponse(err);
      return c.json(e.body, e.status);
    }
  });

  app.delete("/api/skills/tokens/:provider", async (c) => {
    const session = c.get("session")!;
    const provider = c.req.param("provider") === "gitlab" ? "gitlab" : "github";
    const scope: SkillTokenScope = c.req.query("scope") === "platform" ? "platform" : "tenant";
    if (scope === "platform" && !isPlatformAdmin(session)) {
      return c.json({ error: "配置平台令牌需要平台管理员权限" }, 403);
    }
    await skills.tokenStore.remove(scope, session.tenantId, provider);
    return c.json({ ok: true });
  });

  /** 解析来源并预览（支持整条 npx 命令） */
  app.post("/api/skills/resolve", async (c) => {
    const session = c.get("session")!;
    const body = (await c.req.json().catch(() => ({}))) as { source?: string };
    if (!body.source?.trim()) return c.json({ error: "source is required" }, 400);
    try {
      return c.json(await skills.resolve(session.tenantId, body.source));
    } catch (err) {
      const e = errorResponse(err);
      return c.json(e.body, e.status);
    }
  });

  /** 租户技能注册表 */
  app.get("/api/skills", async (c) => {
    const session = c.get("session")!;
    return c.json({ skills: await skills.list(session.tenantId) });
  });

  /** 安装：source 或 skillId，装到指定 Agent 或全部 Agent */
  app.post("/api/skills/install", async (c) => {
    const session = c.get("session")!;
    const body = (await c.req.json().catch(() => ({}))) as {
      source?: string;
      skillId?: string;
      names?: string[];
      agentIds?: string[];
      all?: boolean;
    };
    if (!body.source?.trim() && !body.skillId?.trim()) {
      return c.json({ error: "source 或 skillId 必填" }, 400);
    }
    if (!body.all && !body.agentIds?.length) {
      return c.json({ error: "请选择至少一个 Agent，或设置 all=true" }, 400);
    }
    try {
      const result = await skills.install(session.tenantId, {
        ...(body.source ? { source: body.source } : {}),
        ...(body.skillId ? { skillId: body.skillId } : {}),
        ...(body.names ? { names: body.names } : {}),
        ...(body.agentIds ? { agentIds: body.agentIds } : {}),
        ...(body.all ? { all: true } : {}),
      });
      return c.json(result, 201);
    } catch (err) {
      const e = errorResponse(err);
      return c.json(e.body, e.status);
    }
  });

  /** 技能详情（含文件内容，用于预览与编辑） */
  app.get("/api/skills/:id", async (c) => {
    const session = c.get("session")!;
    const found = await skills.get(session.tenantId, c.req.param("id"));
    if (!found) return c.json({ error: "Not found" }, 404);
    return c.json({ skill: found.record, files: found.files });
  });

  /** 从来源重新抓取并同步到已安装的 Agent */
  app.post("/api/skills/:id/update", async (c) => {
    const session = c.get("session")!;
    try {
      return c.json({ skill: await skills.update(session.tenantId, c.req.param("id")) });
    } catch (err) {
      const e = errorResponse(err);
      return c.json(e.body, e.status);
    }
  });

  /** 从注册表移除（同时从所有 Agent 卸载） */
  app.delete("/api/skills/:id", async (c) => {
    const session = c.get("session")!;
    const ok = await skills.remove(session.tenantId, c.req.param("id"));
    if (!ok) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  // —— 单个 Agent 视角 ——

  app.get("/api/agents/:id/skills", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const [installed, unregistered] = await Promise.all([
      skills.listForAgent(session.tenantId, agent.id),
      skills.discoverUnregistered(session.tenantId, agent),
    ]);
    return c.json({ skills: installed, unregistered });
  });

  /** 安装到这个 Agent（source 或已注册 skillId） */
  app.post("/api/agents/:id/skills", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      source?: string;
      skillId?: string;
      names?: string[];
      /** 把工作区里已有的技能目录登记进注册表 */
      workspacePath?: string;
    };
    try {
      if (body.workspacePath?.trim()) {
        const record = await skills.registerFromWorkspace(
          session.tenantId,
          agent,
          body.workspacePath,
        );
        return c.json({ skills: [record], installs: [], warnings: [] }, 201);
      }
      if (!body.source?.trim() && !body.skillId?.trim()) {
        return c.json({ error: "source / skillId / workspacePath 三选一" }, 400);
      }
      const result = await skills.install(session.tenantId, {
        ...(body.source ? { source: body.source } : {}),
        ...(body.skillId ? { skillId: body.skillId } : {}),
        ...(body.names ? { names: body.names } : {}),
        agentIds: [agent.id],
      });
      return c.json(result, 201);
    } catch (err) {
      const e = errorResponse(err);
      return c.json(e.body, e.status);
    }
  });

  /** 启用 / 停用（停用后不再注入系统提示，文件保留） */
  app.patch("/api/agents/:id/skills/:name", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled is required" }, 400);
    }
    const updated = await skills.setEnabled(
      session.tenantId,
      agent.id,
      c.req.param("name"),
      body.enabled,
    );
    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json({ skill: updated });
  });

  app.delete("/api/agents/:id/skills/:name", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const ok = await skills.uninstall(session.tenantId, agent.id, c.req.param("name"));
    if (!ok) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  /** 读取某个 Agent 上技能的文件内容（预览用） */
  app.get("/api/agents/:id/skills/:name/file", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const file = await skills.readSkillFile(
      session.tenantId,
      agent,
      c.req.param("name"),
      c.req.query("path") ?? undefined,
    );
    if (!file) return c.json({ error: "Not found" }, 404);
    return c.json(file);
  });
}
