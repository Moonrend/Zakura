/**
 * Agent 自动化：定时任务（cron / @every）。
 * 进程内轮询 due 行，claim 后创建 system 会话并 startTurn。
 */
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
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
} from "./cron-next.js";

const TICK_MS = 20_000;
const CLAIM_BATCH = 20;

export type AutomationTrigger = {
  tenantId: string;
  agentId: string;
  kind: "schedule" | "heartbeat";
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
    kind: "schedule" | "heartbeat";
    scheduleId?: string;
    scheduleName?: string;
  }) => Promise<{ sessionId: string; runId: string }>;
};

function scheduleDto(row: AgentSchedule) {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    description: row.description,
    pattern: row.pattern,
    prompt: row.prompt,
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

  constructor(private readonly db: Db) {}

  setRunner(runner: AutomationRunner | null): void {
    this.runner = runner;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // boot 后稍等再扫，避免与 migrate 抢
    setTimeout(() => void this.tick(), 3_000);
    console.log("[automation] scheduler started (poll 20s)");
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
    return rows.map(scheduleDto);
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
      pattern: string;
      prompt: string;
      enabled?: boolean;
      maxRuns?: number | null;
      timezone?: string;
    },
  ): Promise<ReturnType<typeof scheduleDto>> {
    const name = input.name.trim();
    const prompt = input.prompt.trim();
    const pattern = input.pattern.trim();
    if (!name) throw new Error("name is required");
    if (!prompt) throw new Error("prompt is required");
    assertValidSchedulePattern(pattern);

    const agent = await this.db.query.agents.findFirst({
      where: and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)),
    });
    if (!agent) throw new Error("Agent not found");

    const enabled = input.enabled !== false;
    const now = new Date();
    const nextRunAt = enabled ? nextRunAfter(pattern, now) : null;
    const id = newId();
    await this.db.insert(agentSchedules).values({
      id,
      tenantId,
      agentId,
      name,
      description: (input.description ?? "").trim(),
      pattern,
      prompt,
      enabled,
      maxRuns:
        typeof input.maxRuns === "number" && input.maxRuns > 0
          ? Math.floor(input.maxRuns)
          : null,
      runCount: 0,
      timezone: (input.timezone ?? "UTC").trim() || "UTC",
      nextRunAt,
      createdAt: now,
      updatedAt: now,
    });
    const row = await this.getSchedule(tenantId, agentId, id);
    if (!row) throw new Error("create schedule failed");
    return scheduleDto(row);
  }

  async updateSchedule(
    tenantId: string,
    agentId: string,
    scheduleId: string,
    patch: {
      name?: string;
      description?: string;
      pattern?: string;
      prompt?: string;
      enabled?: boolean;
      maxRuns?: number | null;
      timezone?: string;
    },
  ): Promise<ReturnType<typeof scheduleDto> | null> {
    const existing = await this.getSchedule(tenantId, agentId, scheduleId);
    if (!existing) return null;

    const pattern = patch.pattern !== undefined ? patch.pattern.trim() : existing.pattern;
    if (patch.pattern !== undefined) assertValidSchedulePattern(pattern);
    const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled;
    const now = new Date();
    let nextRunAt = existing.nextRunAt;
    if (patch.pattern !== undefined || patch.enabled !== undefined) {
      nextRunAt = enabled ? nextRunAfter(pattern, now, { lastRunAt: existing.lastRunAt }) : null;
    }

    await this.db
      .update(agentSchedules)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() || existing.name } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description.trim() }
          : {}),
        ...(patch.pattern !== undefined ? { pattern } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt.trim() || existing.prompt } : {}),
        ...(patch.enabled !== undefined ? { enabled } : {}),
        ...(patch.maxRuns !== undefined
          ? {
              maxRuns:
                typeof patch.maxRuns === "number" && patch.maxRuns > 0
                  ? Math.floor(patch.maxRuns)
                  : null,
            }
          : {}),
        ...(patch.timezone !== undefined
          ? { timezone: patch.timezone.trim() || "UTC" }
          : {}),
        nextRunAt,
        updatedAt: now,
      })
      .where(eq(agentSchedules.id, scheduleId));

    const row = await this.getSchedule(tenantId, agentId, scheduleId);
    return row ? scheduleDto(row) : null;
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
      console.warn(
        "[automation] tick failed:",
        err instanceof Error ? err.message : err,
      );
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
        next = nextRunAfter(row.pattern, now, { lastRunAt: now });
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
        console.warn("[automation] schedule fire failed:", row.id, err);
      });
      n += 1;
    }
    return n;
  }

  private async fireSchedule(
    row: AgentSchedule,
    opts: { manual: boolean },
  ): Promise<ReturnType<typeof runDto>> {
    if (!this.runner) throw new Error("automation runner not configured");
    const logId = newId();
    const now = new Date();
    await this.db.insert(agentAutomationRuns).values({
      id: logId,
      tenantId: row.tenantId,
      agentId: row.agentId,
      kind: "schedule",
      scheduleId: row.id,
      status: "running",
      prompt: row.prompt,
      startedAt: now,
      createdAt: now,
    });

    try {
      const title = `定时：${row.name}`.slice(0, 80);
      const { sessionId, runId } = await this.runner.startAutomationTurn({
        tenantId: row.tenantId,
        agentId: row.agentId,
        prompt: row.prompt,
        title,
        kind: "schedule",
        scheduleId: row.id,
        scheduleName: row.name,
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
        row.maxRuns != null &&
        row.runCount + 1 >= row.maxRuns;

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
}

export { CronParseError };
