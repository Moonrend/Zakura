/**
 * Agent 定时任务 REST API。
 */
import type { Hono } from "hono";
import { parseProjectField } from "@zakura/shared";
import type { AppVariables } from "./routes.js";
import type { AgentService } from "../services/agents.js";
import type { AgentAutomationService } from "../services/agent-automation.js";
import { CronParseError } from "../services/cron-next.js";

export function registerAutomationRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: {
    agentService: AgentService;
    automation: AgentAutomationService;
  },
) {
  const { agentService, automation } = deps;

  async function requireAgent(tenantId: string, agentId: string) {
    return agentService.get(tenantId, agentId);
  }

  function errStatus(err: unknown): 400 | 404 {
    if (err instanceof CronParseError) return 400;
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(msg)) return 404;
    return 400;
  }

  // ── schedules ───────────────────────────────────────────────

  app.get("/api/agents/:id/schedules", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const schedules = await automation.listSchedules(session.tenantId, agent.id);
    return c.json({ schedules });
  });

  app.post("/api/agents/:id/schedules", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    type CreateBody = {
      name?: string;
      description?: string;
      pattern?: string;
      prompt?: string;
      project?: string | null;
      enabled?: boolean;
      maxRuns?: number | null;
      timezone?: string;
    };
    const body = (await c.req.json<CreateBody>().catch(() => ({} as CreateBody))) as CreateBody;
    const projectField = parseProjectField(body.project);
    if (body.project !== undefined && projectField.status === "invalid") {
      return c.json({ error: "无效的项目名" }, 400);
    }
    try {
      const schedule = await automation.createSchedule(session.tenantId, agent.id, {
        name: String(body.name ?? ""),
        description: body.description,
        pattern: String(body.pattern ?? ""),
        prompt: String(body.prompt ?? ""),
        ...(projectField.status === "ok" ? { project: projectField.slug } : {}),
        enabled: body.enabled,
        maxRuns: body.maxRuns,
        timezone: body.timezone,
      });
      return c.json({ schedule }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, errStatus(err));
    }
  });

  app.get("/api/agents/:id/schedules/:sid", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const row = await automation.getSchedule(session.tenantId, agent.id, c.req.param("sid"));
    if (!row) return c.json({ error: "Not found" }, 404);
    const schedules = await automation.listSchedules(session.tenantId, agent.id);
    const schedule = schedules.find((s) => s.id === row.id);
    return c.json({ schedule });
  });

  app.patch("/api/agents/:id/schedules/:sid", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    type PatchBody = {
      name?: string;
      description?: string;
      pattern?: string;
      prompt?: string;
      project?: string | null;
      enabled?: boolean;
      maxRuns?: number | null;
      timezone?: string;
    };
    const body = (await c.req.json<PatchBody>().catch(() => ({} as PatchBody))) as PatchBody;
    const projectField = parseProjectField(body.project);
    if (body.project !== undefined && projectField.status === "invalid") {
      return c.json({ error: "无效的项目名" }, 400);
    }
    try {
      const schedule = await automation.updateSchedule(
        session.tenantId,
        agent.id,
        c.req.param("sid"),
        {
          ...body,
          ...(projectField.status === "ok" ? { project: projectField.slug } : {}),
        },
      );
      if (!schedule) return c.json({ error: "Not found" }, 404);
      return c.json({ schedule });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, errStatus(err));
    }
  });

  app.delete("/api/agents/:id/schedules/:sid", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const ok = await automation.deleteSchedule(
      session.tenantId,
      agent.id,
      c.req.param("sid"),
    );
    if (!ok) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/api/agents/:id/schedules/:sid/run", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    try {
      const run = await automation.runScheduleNow(
        session.tenantId,
        agent.id,
        c.req.param("sid"),
      );
      return c.json({ run }, 202);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, errStatus(err));
    }
  });

  // ── audit log ───────────────────────────────────────────────

  app.get("/api/agents/:id/automation/runs", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const limitRaw = Number(c.req.query("limit") ?? "30");
    const runs = await automation.listRuns(session.tenantId, agent.id, {
      kind: "schedule",
      limit: Number.isFinite(limitRaw) ? limitRaw : 30,
    });
    return c.json({ runs });
  });
}
