/**
 * ACP profile 配置与运行时控制。
 */
import type { Hono } from "hono";
import {
  acpAgentById,
  acpImageAtVersion,
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
import type { AcpRegistryService } from "../services/acp/registry.js";

export function registerAcpRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: {
    agentService: AgentService;
    acp?: AcpSessionService | null;
    acpRegistry?: AcpRegistryService;
    publicBaseUrl: string;
  },
) {
  const { agentService, acp, acpRegistry, publicBaseUrl } = deps;

  /**
   * Browse the upstream ACP registry.
   *
   * Adapters are no longer limited to the set baked into the workspace image — the
   * catalogue is data fetched from the registry, so newly published agents show up
   * without an image release or a code change.
   */
  app.get("/api/acp/registry", async (c) => {
    if (!acpRegistry) return c.json({ error: "ACP 注册表未启用" }, 503);
    const force = c.req.query("refresh") === "1";
    try {
      const entries = await acpRegistry.catalog({ force });
      return c.json({
        agents: entries,
        // Distinguish "registry unreachable" from "registry says nothing": an empty
        // catalogue must not read as "no agents exist".
        stale: entries.length === 0,
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err), agents: [] },
        502,
      );
    }
  });

  /** Installed adapters for one agent: versions, disk usage, available updates. */
  app.get("/api/agents/:id/acp/adapters", async (c) => {
    if (!acpRegistry) return c.json({ error: "ACP 注册表未启用" }, 503);
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const force = c.req.query("refresh") === "1";
    try {
      return c.json({ adapters: await acpRegistry.status(agent, { force }) });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err), adapters: [] },
        502,
      );
    }
  });

  /** Install / update one adapter now, instead of lazily at first launch. */
  app.post("/api/agents/:id/acp/adapters/:registryId/install", async (c) => {
    if (!acpRegistry) return c.json({ error: "ACP 注册表未启用" }, 503);
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    try {
      const result = await acpRegistry.ensureInstalled(agent, c.req.param("registryId"));
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  /**
   * Uninstall an adapter, or one specific version via `?version=`.
   *
   * GC cannot express this: it always keeps a survivor per adapter, so a user who
   * installed the wrong agent would otherwise have no way to reclaim that disk.
   */
  app.delete("/api/agents/:id/acp/adapters/:registryId", async (c) => {
    if (!acpRegistry) return c.json({ error: "ACP 注册表未启用" }, 503);
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    try {
      const version = c.req.query("version") || undefined;
      const result = await acpRegistry.uninstall(agent, c.req.param("registryId"), version);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  /**
   * Reclaim disk: drop every adapter version except the currently pinned one.
   * Without this an adapter update would leave its predecessor behind forever.
   */
  app.post("/api/agents/:id/acp/adapters/gc", async (c) => {
    if (!acpRegistry) return c.json({ error: "ACP 注册表未启用" }, 503);
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    try {
      return c.json(await acpRegistry.collectGarbage(agent));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  /**
   * Adopt a newer container image tag for one adapter.
   *
   * Container adapters run the tag baked into the build-time snapshot, so a
   * registry release would otherwise be unreachable until the host is rebuilt.
   * Persisting a pin lets the next session pull the new image immediately.
   * Sending no version clears the pin, which is the rollback path back to the
   * shipped default.
   */
  app.post("/api/agents/:id/acp/adapters/:registryId/adopt", async (c) => {
    if (!acpRegistry) return c.json({ error: "ACP 注册表未启用" }, 503);
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);

    const registryId = c.req.param("registryId");
    const curated = acpAgentById(registryId);
    if (!curated) return c.json({ error: "该适配器不是容器适配器" }, 400);

    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const raw = (body as { version?: unknown }).version;
    const version = typeof raw === "string" ? raw.trim() : "";

    // Only versions the registry actually publishes are adoptable; an arbitrary
    // string would resolve to an image tag that cannot be pulled.
    if (version && version !== curated.version) {
      return c.json({ error: `注册表未发布版本 ${version}` }, 400);
    }

    const config = readAgentAcpConfig(agent);
    const setup = config.agents[curated.profileId];
    if (!setup) return c.json({ error: "该适配器尚未配置" }, 400);

    const next = {
      ...config,
      agents: {
        ...config.agents,
        [curated.profileId]: version
          ? { ...setup, pinnedVersion: version }
          : (({ pinnedVersion: _drop, ...rest }) => rest)(setup),
      },
    };
    await saveAgentAcpConfig(agentService, session.tenantId, agent, next);

    return c.json({
      id: registryId,
      pinnedVersion: version || null,
      image: acpImageAtVersion(registryId, version || curated.version),
    });
  });

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
      // `version` lets the UI ask for a specific release. Without it "更新"
      // just re-resolved the shipped version and pulled the same image again,
      // reporting success while nothing changed.
      const version = c.req.query("version") || undefined;
      const result = await acp.install(agent, c.req.param("profileId"), { version });
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
