/**
 * Agent Routine：定时（cron）与事件（listener）触发云端对话。
 * cron 进程内轮询 due 行；listener 由 webhook / Slack 入站命中。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { log, recordPlatformFault } from "@zakura/core";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import {
  describeListener,
  matchRoutineListener,
  parseRoutineListener,
  RoutineListenerError,
  shouldAutoStopListener,
  summarizeInbound,
  type RoutineInboundEvent,
  type RoutineListener,
} from "@zakura/shared";
import type { Db } from "../db/client.js";
import {
  agentAutomationRuns,
  agentSchedules,
  agents,
  newId,
  type AgentAutomationRun,
  type AgentSchedule,
} from "../db/schema.js";
import {
  assertValidSchedulePattern,
  CronParseError,
  nextRunAfter,
  splitCronTimezone,
} from "./cron-next.js";

const TICK_MS = 20_000;
const CLAIM_BATCH = 20;

export type AutomationTrigger = {
  tenantId: string;
  agentId: string;
  kind: "schedule" | "heartbeat" | "listener";
  scheduleId?: string;
  scheduleName?: string;
  prompt: string;
  title: string;
};

export type AutomationRunner = {
  startAutomationTurn: (input: {
    tenantId: string;
    agentId: string;
    prompt: string;
    title: string;
    kind: "schedule" | "heartbeat" | "listener";
    scheduleId?: string;
    scheduleName?: string;
    project?: string | null;
    eventSummary?: string;
  }) => Promise<{ sessionId: string; runId: string }>;
};

function parseListenerJson(raw: string): RoutineListener | null {
  const t = raw.trim();
  if (!t || t === "{}") return null;
  try {
    return parseRoutineListener(JSON.parse(t));
  } catch {
    return null;
  }
}

function newWebhookSecret(): string {
  return randomBytes(24).toString("base64url");
}

function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  try {
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function verifyGithubHmac(secret: string, rawBody: string, signature: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return secretsEqual(expected, signature.trim());
}

function scheduleDto(row: AgentSchedule, publicBaseUrl?: string) {
  const listener = parseListenerJson(row.listenerJson);
  const base = (publicBaseUrl ?? "").replace(/\/$/, "");
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    description: row.description,
    triggerKind: (row.triggerKind === "listener" ? "listener" : "cron") as "cron" | "listener",
    pattern: row.pattern,
    listener,
    listenerSummary: listener ? describeListener(listener) : null,
    webhookUrl:
      row.triggerKind === "listener" && base
        ? `${base}/api/routines/${row.id}/hook`
        : null,
    hasWebhookSecret: Boolean(row.webhookSecret),
    prompt: row.prompt,
    project: row.project,
    enabled: row.enabled,
    maxRuns: row.maxRuns,
    runCount: row.runCount,
    timezone: row.timezone,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function runDto(row: AgentAutomationRun) {
  return {
    id: row.id,
    agentId: row.agentId,
    kind: row.kind,
    scheduleId: row.scheduleId,
    sessionId: row.sessionId,
    cloudRunId: row.cloudRunId,
    status: row.status,
    prompt: row.prompt,
    resultText: row.resultText,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class AgentAutomationService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private runner: AutomationRunner | null = null;

  constructor(
    private readonly db: Db,
    private readonly opts?: { publicBaseUrl?: string },
  ) {}

  private dto(row: AgentSchedule) {
    return scheduleDto(row, this.opts?.publicBaseUrl);
  }

  setRunner(runner: AutomationRunner | null): void {
    this.runner = runner;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // boot 后稍等再扫，避免与 migrate 抢
    setTimeout(() => void this.tick(), 3_000);
    log.info("boot.automation_scheduler", { poll_sec: 20 });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── schedules CRUD ────────────────────────────────────────────

  async listSchedules(tenantId: string, agentId: string): Promise<ReturnType<typeof scheduleDto>[]> {
    const rows = await this.db
      .select()
      .from(agentSchedules)
      .where(and(eq(agentSchedules.tenantId, tenantId), eq(agentSchedules.agentId, agentId)))
      .orderBy(desc(agentSchedules.updatedAt));
    return rows.map((row) => this.dto(row));
  }

  async getSchedule(
    tenantId: string,
    agentId: string,
    scheduleId: string,
  ): Promise<AgentSchedule | null> {
    const row = await this.db.query.agentSchedules.findFirst({
      where: and(
        eq(agentSchedules.id, scheduleId),
        eq(agentSchedules.tenantId, tenantId),
        eq(agentSchedules.agentId, agentId),
      ),
    });
    return row ?? null;
  }

  async createSchedule(
    tenantId: string,
    agentId: string,
    input: {
      name: string;
      description?: string;
      triggerKind?: "cron" | "listener";
      pattern?: string;
      listener?: unknown;
      prompt: string;
      project?: string | null;
      enabled?: boolean;
      maxRuns?: number | null;
      timezone?: string;
    },
  ): Promise<ReturnType<typeof scheduleDto>> {
    const name = input.name.trim();
    const prompt = input.prompt.trim();
    if (!name) throw new Error("name is required");
    if (!prompt) throw new Error("prompt is required");

    const agent = await this.db.query.agents.findFirst({
      where: and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)),
    });
    if (!agent) throw new Error("Agent not found");

    const triggerKind: "cron" | "listener" =
      input.triggerKind === "listener" || input.listener ? "listener" : "cron";
    if (triggerKind === "cron" && input.listener) {
      throw new Error("cron 与 listener 不能同时配置");
    }

    let pattern = (input.pattern ?? "").trim();
    let timezone = (input.timezone ?? "UTC").trim() || "UTC";
    let listenerJson = "{}";
    let webhookSecret: string | null = null;
    let nextRunAt: Date | null = null;
    const enabled = input.enabled !== false;
    const now = new Date();

    if (triggerKind === "listener") {
      const listener = parseRoutineListener(input.listener);
      listenerJson = JSON.stringify(listener);
      webhookSecret = newWebhookSecret();
      pattern = "";
    } else {
      if (!pattern) throw new Error("pattern is required");
      const split = splitCronTimezone(pattern);
      if (split.timezone) timezone = split.timezone;
      assertValidSchedulePattern(pattern);
      nextRunAt = enabled ? nextRunAfter(pattern, now, { timezone }) : null;
    }

    const id = newId();
    await this.db.insert(agentSchedules).values({
      id,
      tenantId,
      agentId,
      name,
      description: (input.description ?? "").trim(),
      triggerKind,
      pattern,
      listenerJson,
      webhookSecret,
      prompt,
      project: input.project ?? null,
      enabled,
      maxRuns:
        typeof input.maxRuns === "number" && input.maxRuns > 0
          ? Math.floor(input.maxRuns)
          : null,
      runCount: 0,
      timezone,
      nextRunAt,
      createdAt: now,
      updatedAt: now,
    });
    const row = await this.getSchedule(tenantId, agentId, id);
    if (!row) throw new Error("create schedule failed");
    return this.dto(row);
  }

  async updateSchedule(
    tenantId: string,
    agentId: string,
    scheduleId: string,
    patch: {
      name?: string;
      description?: string;
      triggerKind?: "cron" | "listener";
      pattern?: string;
      listener?: unknown;
      prompt?: string;
      project?: string | null;
      enabled?: boolean;
      maxRuns?: number | null;
      timezone?: string;
    },
  ): Promise<ReturnType<typeof scheduleDto> | null> {
    const existing = await this.getSchedule(tenantId, agentId, scheduleId);
    if (!existing) return null;

    const triggerKind: "cron" | "listener" =
      patch.triggerKind ??
      (patch.listener !== undefined
        ? "listener"
        : existing.triggerKind === "listener"
          ? "listener"
          : "cron");
    if (triggerKind === "cron" && patch.listener) {
      throw new Error("cron 与 listener 不能同时配置");
    }

    const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled;
    const now = new Date();
    let pattern = patch.pattern !== undefined ? patch.pattern.trim() : existing.pattern;
    let timezone =
      patch.timezone !== undefined ? patch.timezone.trim() || "UTC" : existing.timezone;
    let listenerJson = existing.listenerJson;
    let webhookSecret = existing.webhookSecret;
    let nextRunAt = existing.nextRunAt;

    if (triggerKind === "listener") {
      if (patch.listener !== undefined) {
        listenerJson = JSON.stringify(parseRoutineListener(patch.listener));
      } else if (!parseListenerJson(existing.listenerJson)) {
        throw new Error("listener 不能为空");
      }
      pattern = "";
      nextRunAt = null;
      if (!webhookSecret) webhookSecret = newWebhookSecret();
    } else {
      listenerJson = "{}";
      if (!pattern) throw new Error("pattern is required");
      const split = splitCronTimezone(pattern);
      if (split.timezone) timezone = split.timezone;
      if (patch.pattern !== undefined) assertValidSchedulePattern(pattern);
      if (
        patch.pattern !== undefined ||
        patch.enabled !== undefined ||
        patch.timezone !== undefined ||
        existing.triggerKind === "listener"
      ) {
        nextRunAt = enabled
          ? nextRunAfter(pattern, now, { lastRunAt: existing.lastRunAt, timezone })
          : null;
      }
    }

    await this.db
      .update(agentSchedules)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() || existing.name } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description.trim() }
          : {}),
        triggerKind,
        pattern,
        listenerJson,
        webhookSecret,
        ...(patch.prompt !== undefined ? { prompt: patch.prompt.trim() || existing.prompt } : {}),
        ...(patch.project !== undefined ? { project: patch.project } : {}),
        ...(patch.enabled !== undefined ? { enabled } : {}),
        ...(patch.maxRuns !== undefined
          ? {
              maxRuns:
                typeof patch.maxRuns === "number" && patch.maxRuns > 0
                  ? Math.floor(patch.maxRuns)
                  : null,
            }
          : {}),
        timezone,
        nextRunAt,
        updatedAt: now,
      })
      .where(eq(agentSchedules.id, scheduleId));

    const row = await this.getSchedule(tenantId, agentId, scheduleId);
    return row ? this.dto(row) : null;
  }

  async revealWebhookSecret(
    tenantId: string,
    agentId: string,
    scheduleId: string,
  ): Promise<string | null> {
    const row = await this.getSchedule(tenantId, agentId, scheduleId);
    return row?.webhookSecret ?? null;
  }

  async deleteSchedule(tenantId: string, agentId: string, scheduleId: string): Promise<boolean> {
    const existing = await this.getSchedule(tenantId, agentId, scheduleId);
    if (!existing) return false;
    await this.db.delete(agentSchedules).where(eq(agentSchedules.id, scheduleId));
    return true;
  }

  // ── runs / manual trigger ─────────────────────────────────────

  async listRuns(
    tenantId: string,
    agentId: string,
    opts?: { limit?: number; kind?: "schedule" | "heartbeat" },
  ) {
    const limit = Math.min(Math.max(opts?.limit ?? 30, 1), 100);
    const rows = await this.db
      .select()
      .from(agentAutomationRuns)
      .where(
        and(
          eq(agentAutomationRuns.tenantId, tenantId),
          eq(agentAutomationRuns.agentId, agentId),
          ...(opts?.kind ? [eq(agentAutomationRuns.kind, opts.kind)] : []),
        ),
      )
      .orderBy(desc(agentAutomationRuns.createdAt))
      .limit(limit);
    return rows.map(runDto);
  }

  /** 手动立即跑一次 schedule（不推进 next_run_at 周期逻辑之外的「额外」触发） */
  async runScheduleNow(tenantId: string, agentId: string, scheduleId: string) {
    const row = await this.getSchedule(tenantId, agentId, scheduleId);
    if (!row) throw new Error("schedule not found");
    return this.fireSchedule(row, { manual: true });
  }

  // ── poll loop ─────────────────────────────────────────────────

  async tick(): Promise<{ schedules: number }> {
    if (this.ticking) return { schedules: 0 };
    if (!this.runner) return { schedules: 0 };
    this.ticking = true;
    let schedules = 0;
    try {
      schedules = await this.claimAndFireSchedules();
    } catch (err) {
      recordPlatformFault("automation.tick", err, { subsystem: "automation" });
    } finally {
      this.ticking = false;
    }
    return { schedules };
  }

  private async claimAndFireSchedules(): Promise<number> {
    const now = new Date();
    const due = await this.db
      .select()
      .from(agentSchedules)
      .where(
        and(
          eq(agentSchedules.enabled, true),
          lte(agentSchedules.nextRunAt, now),
        ),
      )
      .orderBy(asc(agentSchedules.nextRunAt))
      .limit(CLAIM_BATCH);

    let n = 0;
    for (const row of due) {
      if (row.triggerKind === "listener") continue;
      if (row.maxRuns != null && row.runCount >= row.maxRuns) {
        await this.db
          .update(agentSchedules)
          .set({
            enabled: false,
            nextRunAt: null,
            lastStatus: "completed",
            lastError: "max_runs reached",
            updatedAt: new Date(),
          })
          .where(eq(agentSchedules.id, row.id));
        continue;
      }
      // claim：把 next 推到将来，避免并发 tick 双发
      let next: Date;
      try {
        next = nextRunAfter(row.pattern, now, { lastRunAt: now, timezone: row.timezone });
      } catch (err) {
        await this.db
          .update(agentSchedules)
          .set({
            enabled: false,
            lastStatus: "failed",
            lastError: err instanceof Error ? err.message : String(err),
            updatedAt: new Date(),
          })
          .where(eq(agentSchedules.id, row.id));
        continue;
      }
      const claimed = await this.db
        .update(agentSchedules)
        .set({
          nextRunAt: next,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentSchedules.id, row.id),
            eq(agentSchedules.enabled, true),
            // 仍是 due 的那一版（next_run_at 未变）
            row.nextRunAt
              ? eq(agentSchedules.nextRunAt, row.nextRunAt)
              : sql`${agentSchedules.nextRunAt} is null`,
          ),
        )
        .returning();
      if (!claimed.length) continue;

      void this.fireSchedule({ ...row, nextRunAt: next }, { manual: false }).catch((err: unknown) => {
        recordPlatformFault("automation.fire", err, { subsystem: "automation" });
      });
      n += 1;
    }
    return n;
  }

  private async fireSchedule(
    row: AgentSchedule,
    opts: { manual: boolean; eventSummary?: string; inbound?: RoutineInboundEvent },
  ): Promise<ReturnType<typeof runDto>> {
    if (!this.runner) throw new Error("automation runner not configured");
    const isListener = row.triggerKind === "listener";
    const logId = newId();
    const now = new Date();
    await this.db.insert(agentAutomationRuns).values({
      id: logId,
      tenantId: row.tenantId,
      agentId: row.agentId,
      kind: isListener ? "listener" : "schedule",
      scheduleId: row.id,
      status: "running",
      prompt: row.prompt,
      startedAt: now,
      createdAt: now,
    });

    try {
      const title = `${isListener ? "事件" : "定时"}：${row.name}`.slice(0, 80);
      const { sessionId, runId } = await this.runner.startAutomationTurn({
        tenantId: row.tenantId,
        agentId: row.agentId,
        prompt: row.prompt,
        title,
        kind: isListener ? "listener" : "schedule",
        scheduleId: row.id,
        scheduleName: row.name,
        project: row.project,
        ...(opts.eventSummary ? { eventSummary: opts.eventSummary } : {}),
      });
      await this.db
        .update(agentAutomationRuns)
        .set({
          status: "completed",
          sessionId,
          cloudRunId: runId,
          completedAt: new Date(),
          resultText: `started session ${sessionId}`,
        })
        .where(eq(agentAutomationRuns.id, logId));

      const disable =
        !opts.manual &&
        ((row.maxRuns != null && row.runCount + 1 >= row.maxRuns) ||
          (opts.inbound &&
            (() => {
              const listener = parseListenerJson(row.listenerJson);
              return listener ? shouldAutoStopListener(listener, opts.inbound!) : false;
            })()));

      await this.db
        .update(agentSchedules)
        .set({
          runCount: sql`${agentSchedules.runCount} + 1`,
          lastRunAt: new Date(),
          lastStatus: "ok",
          lastError: null,
          ...(disable ? { enabled: false, nextRunAt: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(agentSchedules.id, row.id));

      const log = await this.db.query.agentAutomationRuns.findFirst({
        where: eq(agentAutomationRuns.id, logId),
      });
      return runDto(log!);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .update(agentAutomationRuns)
        .set({
          status: "failed",
          error: message,
          completedAt: new Date(),
        })
        .where(eq(agentAutomationRuns.id, logId));
      await this.db
        .update(agentSchedules)
        .set({
          lastRunAt: new Date(),
          lastStatus: "failed",
          lastError: message.slice(0, 500),
          updatedAt: new Date(),
        })
        .where(eq(agentSchedules.id, row.id));
      throw err;
    }
  }

  /**
   * Slack 等已接入的入站消息：扫该 agent 的 listener routine。
   * 命中则另开 system 会话执行任务说明（与频道对话独立）。
   */
  async matchInbound(
    tenantId: string,
    agentId: string,
    ev: RoutineInboundEvent,
  ): Promise<number> {
    const rows = await this.db
      .select()
      .from(agentSchedules)
      .where(
        and(
          eq(agentSchedules.tenantId, tenantId),
          eq(agentSchedules.agentId, agentId),
          eq(agentSchedules.enabled, true),
          eq(agentSchedules.triggerKind, "listener"),
        ),
      );
    let n = 0;
    for (const row of rows) {
      const listener = parseListenerJson(row.listenerJson);
      if (!listener || !matchRoutineListener(listener, ev)) continue;
      if (row.maxRuns != null && row.runCount >= row.maxRuns) continue;
      void this.fireSchedule(row, {
        manual: false,
        eventSummary: summarizeInbound(ev),
        inbound: ev,
      }).catch((err: unknown) => {
        recordPlatformFault("automation.listener", err, { subsystem: "automation" });
      });
      n += 1;
    }
    return n;
  }

  /** 公开 webhook：验签后按这条 routine 的 listener 过滤并触发 */
  async handleWebhook(
    scheduleId: string,
    input: {
      secret?: string | null;
      authorized?: boolean;
      githubSignature?: string | null;
      rawBody?: string | null;
      events: RoutineInboundEvent[];
    },
  ): Promise<{ ok: true; matched: number } | { ok: false; error: string; status: 401 | 404 | 400 }> {
    const row = await this.db.query.agentSchedules.findFirst({
      where: eq(agentSchedules.id, scheduleId),
    });
    if (!row || row.triggerKind !== "listener") {
      return { ok: false, error: "not found", status: 404 };
    }
    const authed =
      input.authorized === true ||
      Boolean(row.webhookSecret && input.secret && secretsEqual(row.webhookSecret, input.secret)) ||
      Boolean(
        row.webhookSecret &&
          input.githubSignature &&
          input.rawBody != null &&
          verifyGithubHmac(row.webhookSecret, input.rawBody, input.githubSignature),
      );
    if (!authed) return { ok: false, error: "unauthorized", status: 401 };
    if (!row.enabled) return { ok: true, matched: 0 };
    const listener = parseListenerJson(row.listenerJson);
    if (!listener) return { ok: false, error: "invalid listener", status: 400 };
    const hits = input.events.filter((ev) => matchRoutineListener(listener, ev));
    // webhook 源：空 events 也视为一次触发（外部系统随便 POST）
    const toFire =
      hits.length > 0
        ? hits
        : listener.source === "webhook"
          ? [{ source: "webhook" as const, type: "post" }]
          : [];
    for (const ev of toFire.slice(0, 1)) {
      await this.fireSchedule(row, {
        manual: false,
        eventSummary: summarizeInbound(ev),
        inbound: ev,
      });
    }
    return { ok: true, matched: toFire.length };
  }
}

export { CronParseError, RoutineListenerError };
