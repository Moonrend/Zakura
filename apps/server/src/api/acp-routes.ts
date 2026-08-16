/**
 * ACP profile 配置与运行时控制。
 */
import type { Hono } from "hono";
import {
  isValidAcpProfileId,
  parseAcpAgentConfig,
  parseAcpAgentSetup,
  parseAcpPermissionPolicy,
} from "@zakura/shared";
import type { AppVariables } from "./routes.js";
import type { AgentService } from "../services/agents.js";
import {
  acpConfigResponse,
  agentAcpConfigError,
  provisionAcpZakuraRoutes,
  readAgentAcpConfig,
  saveAgentAcpConfig,
} from "../services/acp/config.js";
import type { AcpSessionService } from "../services/acp/session.js";

export function registerAcpRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: {
    agentService: AgentService;
    acp?: AcpSessionService | null;
    publicBaseUrl: string;
  },
) {
  const { agentService, acp, publicBaseUrl } = deps;

  app.get("/api/agents/:id/acp/config", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    // Older ACP settings may already select the Zakura provider but predate
    // per-Agent Gateway key provisioning. Repair that state on read so an
    // existing configuration cannot launch Hermes/Kimi without Authorization.
    const provisioned = await provisionAcpConfigIfNeeded(
      agentService,
      session.tenantId,
      agent,
      publicBaseUrl,
    );
    return c.json(acpConfigResponse(provisioned, agentAcpConfigError(agent)));
  });

  app.put("/api/agents/:id/acp/config", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const body = await c.req.json<unknown>().catch(() => ({}));
    const parsed = parseAcpAgentConfig({ acp: body });
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const o = body as Record<string, unknown>;
      if (o.permissionPolicy !== undefined) {
        parsed.permissionPolicy = parseAcpPermissionPolicy(o.permissionPolicy);
      }
    }
    for (const id of Object.keys(parsed.agents)) {
      if (!isValidAcpProfileId(id)) {
        return c.json({ error: `无效的 ACP profile id: ${id}` }, 400);
      }
    }
    let saved = await saveAgentAcpConfig(agentService, session.tenantId, agent, parsed);
    saved = await provisionAcpZakuraRoutes(
      agentService,
      session.tenantId,
      agent,
      saved,
      publicBaseUrl,
    );
    return c.json(acpConfigResponse(saved));
  });

  app.put("/api/agents/:id/acp/agents/:profileId", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const profileId = c.req.param("profileId");
    if (!isValidAcpProfileId(profileId)) {
      return c.json({ error: "无效的 ACP profile id" }, 400);
    }
    const body = await c.req.json<unknown>().catch(() => ({}));
    const current = readAgentAcpConfig(agent);
    current.agents[profileId] = parseAcpAgentSetup(profileId, body);
    let saved = await saveAgentAcpConfig(agentService, session.tenantId, agent, current);
    saved = await provisionAcpZakuraRoutes(
      agentService,
      session.tenantId,
      agent,
      saved,
      publicBaseUrl,
    );
    return c.json(acpConfigResponse(saved));
  });

  app.delete("/api/agents/:id/acp/agents/:profileId", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const current = readAgentAcpConfig(agent);
    delete current.agents[c.req.param("profileId")];
    const saved = await saveAgentAcpConfig(agentService, session.tenantId, agent, current);
    return c.json(acpConfigResponse(saved));
  });

  app.post("/api/agents/:id/acp/agents/:profileId/probe", async (c) => {
    const session = c.get("session")!;
    if (!acp) return c.json({ error: "ACP 未启用" }, 400);
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    try {
      const result = await acp.probe(agent, c.req.param("profileId"));
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/agents/:id/acp/agents/:profileId/install", async (c) => {
    const session = c.get("session")!;
    if (!acp) return c.json({ error: "ACP 未启用" }, 400);
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    try {
      const result = await acp.install(agent, c.req.param("profileId"));
      return c.json(result, result.ok ? 200 : 400);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/agents/:id/sessions/:sid/acp-runtime", async (c) => {
    const session = c.get("session")!;
    if (!acp) return c.json({ error: "ACP 未启用" }, 400);
    try {
      const status = await acp.runtimeStatus(
        session.tenantId,
        c.req.param("id"),
        c.req.param("sid"),
      );
      return c.json(status);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/agents/:id/acp/draft", async (c) => {
    const session = c.get("session")!;
    if (!acp) return c.json({ error: "ACP 未启用" }, 400);
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const body: { profileId?: string; project?: string | null } = await c.req
      .json<{ profileId?: string; project?: string | null }>()
      .catch(() => ({} as { profileId?: string; project?: string | null }));
    if (!body.profileId || !isValidAcpProfileId(body.profileId)) {
      return c.json({ error: "profileId 必填或无效" }, 400);
    }
    try {
      return c.json(await acp.prepareDraft({
        tenantId: session.tenantId,
        agentId: agent.id,
        profileId: body.profileId,
        project: body.project,
      }));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/agents/:id/sessions/:sid/acp/permission", async (c) => {
    const session = c.get("session")!;
    if (!acp) return c.json({ error: "ACP 未启用" }, 400);
    const body = await c.req.json<{ requestId?: string; optionId?: string; cancelled?: boolean }>();
    if (!body.requestId) return c.json({ error: "requestId 必填" }, 400);
    try {
      await acp.resolvePermission(session.tenantId, c.req.param("id"), c.req.param("sid"), {
        requestId: body.requestId,
        optionId: body.optionId,
        cancelled: body.cancelled === true,
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/agents/:id/sessions/:sid/acp/elicitation", async (c) => {
    const session = c.get("session")!;
    if (!acp) return c.json({ error: "ACP 未启用" }, 400);
    const body = await c.req.json<{
      requestId?: string;
      cancelled?: boolean;
      content?: unknown;
    }>();
    if (!body.requestId) return c.json({ error: "requestId 必填" }, 400);
    try {
      await acp.resolveElicitation(session.tenantId, c.req.param("id"), c.req.param("sid"), {
        requestId: body.requestId,
        cancelled: body.cancelled === true,
        content: body.content,
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.patch("/api/agents/:id/sessions/:sid/acp-runtime/mode", async (c) => {
    const session = c.get("session")!;
    if (!acp) return c.json({ error: "ACP 未启用" }, 400);
    const body = await c.req.json<{ modeId?: string }>();
    if (!body.modeId?.trim()) return c.json({ error: "modeId 必填" }, 400);
    try {
      const status = await acp.setMode(
        session.tenantId,
        c.req.param("id"),
        c.req.param("sid"),
        body.modeId.trim(),
      );
      return c.json(status);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.patch("/api/agents/:id/sessions/:sid/acp-runtime/model", async (c) => {
    const session = c.get("session")!;
    if (!acp) return c.json({ error: "ACP 未启用" }, 400);
    const body = await c.req.json<{ modelId?: string }>();
    if (!body.modelId?.trim()) return c.json({ error: "modelId 必填" }, 400);
    try {
      const status = await acp.setModel(
        session.tenantId,
        c.req.param("id"),
        c.req.param("sid"),
        body.modelId.trim(),
      );
      return c.json(status);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.patch("/api/agents/:id/sessions/:sid/acp-runtime/config", async (c) => {
    const session = c.get("session")!;
    if (!acp) return c.json({ error: "ACP 未启用" }, 400);
    const body = await c.req.json<{ configId?: string; value?: string | boolean }>();
    if (!body.configId?.trim()) return c.json({ error: "configId 必填" }, 400);
    if (body.value === undefined || (typeof body.value !== "string" && typeof body.value !== "boolean")) {
      return c.json({ error: "value 必填" }, 400);
    }
    try {
      const status = await acp.setConfigOption(
        session.tenantId,
        c.req.param("id"),
        c.req.param("sid"),
        body.configId.trim(),
        typeof body.value === "string" ? body.value.trim() : body.value,
      );
      return c.json(status);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/agents/:id/sessions/:sid/acp/authenticate", async (c) => {
    const session = c.get("session")!;
    if (!acp) return c.json({ error: "ACP 未启用" }, 400);
    if (!(await agentService.get(session.tenantId, c.req.param("id")))) {
      return c.json({ error: "Agent not found" }, 404);
    }
    const body = await c.req.json<{ methodId?: string }>();
    if (!body.methodId?.trim()) return c.json({ error: "methodId 必填" }, 400);
    try {
      const status = await acp.authenticate(c.req.param("sid"), body.methodId.trim());
      return c.json(status);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/agents/:id/sessions/:sid/acp/logout", async (c) => {
    const session = c.get("session")!;
    if (!acp) return c.json({ error: "ACP 未启用" }, 400);
    if (!(await agentService.get(session.tenantId, c.req.param("id")))) {
      return c.json({ error: "Agent not found" }, 404);
    }
    try {
      await acp.logout(c.req.param("sid"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/agents/:id/acp/agents/:profileId/oauth/device/start", async (c) => {
    const session = c.get("session")!;
    if (!acp) return c.json({ error: "ACP 未启用" }, 400);
    if (c.req.param("profileId") !== "codex") {
      return c.json({ error: "仅 Codex 支持设备码登录" }, 400);
    }
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    try {
      return c.json(await acp.deviceAuth.start(agent));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/agents/:id/acp/agents/:profileId/oauth/device/poll", async (c) => {
    const session = c.get("session")!;
    if (!acp) return c.json({ error: "ACP 未启用" }, 400);
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const body = await c.req.json<{ loginId?: string }>();
    if (!body.loginId) return c.json({ error: "loginId 必填" }, 400);
    try {
      return c.json(await acp.deviceAuth.poll(agent, body.loginId));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/agents/:id/acp/agents/:profileId/oauth/device/cancel", async (c) => {
    const session = c.get("session")!;
    if (!acp) return c.json({ error: "ACP 未启用" }, 400);
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const body = await c.req.json<{ loginId?: string }>();
    if (!body.loginId) return c.json({ error: "loginId 必填" }, 400);
    try {
      return c.json(acp.deviceAuth.cancel(agent, body.loginId));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });
}

async function provisionAcpConfigIfNeeded(
  agentService: AgentService,
  tenantId: string,
  agent: NonNullable<Awaited<ReturnType<AgentService["get"]>>>,
  publicBaseUrl: string,
) {
  return provisionAcpZakuraRoutes(
    agentService,
    tenantId,
    agent,
    readAgentAcpConfig(agent),
    publicBaseUrl,
  );
}
