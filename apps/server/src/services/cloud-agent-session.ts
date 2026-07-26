/**
 * Cloud Agent 持久会话存储 + 进程内 fan-out。
 * 事件先落库再广播，断线客户端按 afterSeq 续传即可追上。
 */
import { and, asc, desc, eq, exists, gt, ilike, inArray, or, sql } from "drizzle-orm";
import type {
  CloudAgentEvent,
  CloudAgentEventPayload,
  CloudAgentEventType,
  CloudAgentSessionKind,
  CloudAgentSessionOrigin,
} from "@zakura/shared";
import type { Db } from "../db/client.js";
import {
  cloudAgentEvents,
  cloudAgentRuns,
  cloudAgentSessions,
  newId,
  type CloudAgentRun,
  type CloudAgentSession,
} from "../db/schema.js";

type SessionListener = (event: CloudAgentEvent) => void;

function parsePayload(raw: string): CloudAgentEventPayload {
  try {
    return JSON.parse(raw) as CloudAgentEventPayload;
  } catch {
    return {} as CloudAgentEventPayload;
  }
}

function toEvent(row: typeof cloudAgentEvents.$inferSelect): CloudAgentEvent {
  return {
    id: row.id,
    sessionId: row.sessionId,
    seq: row.seq,
    type: row.type as CloudAgentEventType,
    runId: row.runId,
    payload: parsePayload(row.payloadJson),
    createdAt: row.createdAt.toISOString(),
  };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

/** 从事件 payload 中截取命中查询词附近的文本片段 */
export function extractSnippet(payloadJson: string, query: string, radius = 40): string | null {
  let content = "";
  try {
    const p = JSON.parse(payloadJson) as { content?: unknown };
    content = typeof p.content === "string" ? p.content : "";
  } catch {
    return null;
  }
  if (!content) return null;
  const idx = content.toLowerCase().indexOf(query.trim().toLowerCase());
  if (idx < 0) return content.slice(0, radius * 2) + (content.length > radius * 2 ? "…" : "");
  const start = Math.max(0, idx - radius);
  const end = Math.min(content.length, idx + query.length + radius);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

const SEARCHABLE_EVENT_TYPES = ["user_message", "assistant_message"] as const;

export type CloudSessionSearchHit = {
  session: CloudAgentSession;
  /** 命中消息的上下文摘录（标题命中时可能为 null） */
  snippet: string | null;
};

/** 会话类型过滤：缺省只看 chat（聊天界面的默认视图）；"all" = 全部类型 */
export type SessionKindFilter = CloudAgentSessionKind[] | "all";

function kindCondition(kinds: SessionKindFilter | undefined) {
  if (kinds === "all") return [];
  const list = kinds && kinds.length > 0 ? kinds : (["chat"] as CloudAgentSessionKind[]);
  return [inArray(cloudAgentSessions.kind, list)];
}

export class CloudAgentSessionStore {
  /** sessionId → listeners */
  private readonly listeners = new Map<string, Set<SessionListener>>();
  /** pg_trgm 可用性（惰性探测；PGlite/无权限时回退 ILIKE） */
  private trgmReady: Promise<boolean> | null = null;

  constructor(private readonly db: Db) {}

  private ensureTrgm(): Promise<boolean> {
    if (!this.trgmReady) {
      this.trgmReady = this.db
        .execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`)
        .then(() => true)
        .catch(() => false);
    }
    return this.trgmReady;
  }

  /**
   * 会话搜索：标题 + 消息内容 ILIKE 子串匹配（对中英文都稳定），
   * pg_trgm 可用时叠加标题模糊匹配（容忍拼写偏差）。按最近更新排序。
   */
  async searchSessions(
    tenantId: string,
    query: string,
    opts?: { agentId?: string; limit?: number; kinds?: SessionKindFilter },
  ): Promise<CloudSessionSearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 50);
    const pattern = `%${escapeLike(q)}%`;
    const trgmOk = await this.ensureTrgm();

    const eventMatch = this.db
      .select({ one: sql`1` })
      .from(cloudAgentEvents)
      .where(
        and(
          eq(cloudAgentEvents.sessionId, cloudAgentSessions.id),
          inArray(cloudAgentEvents.type, [...SEARCHABLE_EVENT_TYPES]),
          ilike(cloudAgentEvents.payloadJson, pattern),
        ),
      );

    const matchCond = trgmOk
      ? or(
          ilike(cloudAgentSessions.title, pattern),
          sql`similarity(${cloudAgentSessions.title}, ${q}) > 0.2`,
          exists(eventMatch),
        )
      : or(ilike(cloudAgentSessions.title, pattern), exists(eventMatch));

    const rows = await this.db
      .select()
      .from(cloudAgentSessions)
      .where(
        and(
          eq(cloudAgentSessions.tenantId, tenantId),
          eq(cloudAgentSessions.status, "active"),
          ...(opts?.agentId ? [eq(cloudAgentSessions.agentId, opts.agentId)] : []),
          ...kindCondition(opts?.kinds),
          matchCond,
        ),
      )
      .orderBy(desc(cloudAgentSessions.updatedAt))
      .limit(limit);

    const hits: CloudSessionSearchHit[] = [];
    for (const session of rows) {
      const [ev] = await this.db
        .select({ payloadJson: cloudAgentEvents.payloadJson })
        .from(cloudAgentEvents)
        .where(
          and(
            eq(cloudAgentEvents.sessionId, session.id),
            inArray(cloudAgentEvents.type, [...SEARCHABLE_EVENT_TYPES]),
            ilike(cloudAgentEvents.payloadJson, pattern),
          ),
        )
        .orderBy(desc(cloudAgentEvents.seq))
        .limit(1);
      hits.push({ session, snippet: ev ? extractSnippet(ev.payloadJson, q) : null });
    }
    return hits;
  }

  subscribe(sessionId: string, listener: SessionListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(sessionId);
    };
  }

  private emit(event: CloudAgentEvent) {
    const set = this.listeners.get(event.sessionId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch (err) {
        console.warn("[cloud-agent] listener error:", err);
      }
    }
  }

  async createSession(input: {
    tenantId: string;
    agentId: string;
    title?: string;
    createdByUserId?: string | null;
    /** 会话类型标记；缺省 chat。子代理/委派/系统调用产生的对话用对应类型 */
    kind?: CloudAgentSessionKind;
    /** 来源链接（父会话/父 Run/调用方 Agent），非 chat 会话应尽量填写 */
    origin?: CloudAgentSessionOrigin;
  }): Promise<CloudAgentSession> {
    const id = newId();
    const now = new Date();
    await this.db.insert(cloudAgentSessions).values({
      id,
      tenantId: input.tenantId,
      agentId: input.agentId,
      title: input.title?.trim() || "新对话",
      status: "active",
      kind: input.kind ?? "chat",
      originJson: JSON.stringify(input.origin ?? {}),
      createdByUserId: input.createdByUserId ?? null,
      lastSeq: 0,
      activeRunId: null,
      createdAt: now,
      updatedAt: now,
    });
    const row = await this.getSession(input.tenantId, input.agentId, id);
    if (!row) throw new Error("创建会话失败");
    return row;
  }

  async listSessions(
    tenantId: string,
    agentId: string,
    opts?: { limit?: number; includeArchived?: boolean; kinds?: SessionKindFilter },
  ): Promise<CloudAgentSession[]> {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const cond = and(
      eq(cloudAgentSessions.tenantId, tenantId),
      eq(cloudAgentSessions.agentId, agentId),
      ...(opts?.includeArchived ? [] : [eq(cloudAgentSessions.status, "active")]),
      ...kindCondition(opts?.kinds),
    );
    const rows = await this.db
      .select()
      .from(cloudAgentSessions)
      .where(cond)
      .orderBy(desc(cloudAgentSessions.updatedAt))
      .limit(limit);
    return rows;
  }

  async getSession(
    tenantId: string,
    agentId: string,
    sessionId: string,
  ): Promise<CloudAgentSession | null> {
    const row = await this.db.query.cloudAgentSessions.findFirst({
      where: and(
        eq(cloudAgentSessions.id, sessionId),
        eq(cloudAgentSessions.tenantId, tenantId),
        eq(cloudAgentSessions.agentId, agentId),
      ),
    });
    return row ?? null;
  }

  async updateSession(
    tenantId: string,
    agentId: string,
    sessionId: string,
    patch: {
      title?: string;
      status?: "active" | "archived";
      /** 重新打类型标记（如把一段 chat 归档为 system） */
      kind?: CloudAgentSessionKind;
    },
  ): Promise<CloudAgentSession | null> {
    const existing = await this.getSession(tenantId, agentId, sessionId);
    if (!existing) return null;
    await this.db
      .update(cloudAgentSessions)
      .set({
        ...(patch.title !== undefined ? { title: patch.title.trim() || existing.title } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        updatedAt: new Date(),
      })
      .where(eq(cloudAgentSessions.id, sessionId));
    return this.getSession(tenantId, agentId, sessionId);
  }

  async deleteSession(tenantId: string, agentId: string, sessionId: string): Promise<boolean> {
    const existing = await this.getSession(tenantId, agentId, sessionId);
    if (!existing) return false;
    await this.db.delete(cloudAgentSessions).where(eq(cloudAgentSessions.id, sessionId));
    this.listeners.delete(sessionId);
    return true;
  }

  /** 追加事件并 fan-out；seq 在事务内递增 */
  async appendEvent(input: {
    sessionId: string;
    type: CloudAgentEventType;
    runId?: string | null;
    payload: CloudAgentEventPayload;
  }): Promise<CloudAgentEvent> {
    const eventId = newId();
    const now = new Date();

    const event = await this.db.transaction(async (tx) => {
      const session = await tx.query.cloudAgentSessions.findFirst({
        where: eq(cloudAgentSessions.id, input.sessionId),
      });
      if (!session) throw new Error("会话不存在");
      const seq = session.lastSeq + 1;
      await tx.insert(cloudAgentEvents).values({
        id: eventId,
        sessionId: input.sessionId,
        seq,
        type: input.type,
        runId: input.runId ?? null,
        payloadJson: JSON.stringify(input.payload),
        createdAt: now,
      });
      await tx
        .update(cloudAgentSessions)
        .set({ lastSeq: seq, updatedAt: now })
        .where(eq(cloudAgentSessions.id, input.sessionId));
      return {
        id: eventId,
        sessionId: input.sessionId,
        seq,
        type: input.type,
        runId: input.runId ?? null,
        payload: input.payload,
        createdAt: now.toISOString(),
      } satisfies CloudAgentEvent;
    });

    this.emit(event);
    return event;
  }

  async listEvents(
    sessionId: string,
    opts?: { afterSeq?: number; limit?: number },
  ): Promise<CloudAgentEvent[]> {
    const afterSeq = opts?.afterSeq ?? 0;
    const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 2000);
    const rows = await this.db
      .select()
      .from(cloudAgentEvents)
      .where(
        and(eq(cloudAgentEvents.sessionId, sessionId), gt(cloudAgentEvents.seq, afterSeq)),
      )
      .orderBy(asc(cloudAgentEvents.seq))
      .limit(limit);
    return rows.map(toEvent);
  }

  async createRun(sessionId: string): Promise<CloudAgentRun> {
    const id = newId();
    const now = new Date();
    await this.db.insert(cloudAgentRuns).values({
      id,
      sessionId,
      status: "queued",
      cancelRequested: false,
      createdAt: now,
    });
    await this.db
      .update(cloudAgentSessions)
      .set({ activeRunId: id, updatedAt: now })
      .where(eq(cloudAgentSessions.id, sessionId));
    const row = await this.db.query.cloudAgentRuns.findFirst({
      where: eq(cloudAgentRuns.id, id),
    });
    if (!row) throw new Error("创建 Run 失败");
    return row;
  }

  async getRun(runId: string): Promise<CloudAgentRun | null> {
    return (
      (await this.db.query.cloudAgentRuns.findFirst({
        where: eq(cloudAgentRuns.id, runId),
      })) ?? null
    );
  }

  async markRunStarted(runId: string): Promise<void> {
    await this.db
      .update(cloudAgentRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(cloudAgentRuns.id, runId));
  }

  async requestCancel(sessionId: string, runId?: string | null): Promise<boolean> {
    const session = await this.db.query.cloudAgentSessions.findFirst({
      where: eq(cloudAgentSessions.id, sessionId),
    });
    if (!session) return false;
    const targetId = runId || session.activeRunId;
    if (!targetId) return false;
    const run = await this.getRun(targetId);
    if (!run || run.sessionId !== sessionId) return false;
    if (run.status === "completed" || run.status === "cancelled" || run.status === "failed") {
      return false;
    }
    await this.db
      .update(cloudAgentRuns)
      .set({ cancelRequested: true })
      .where(eq(cloudAgentRuns.id, targetId));
    return true;
  }

  async isCancelRequested(runId: string): Promise<boolean> {
    const run = await this.getRun(runId);
    return Boolean(run?.cancelRequested);
  }

  async finishRun(
    sessionId: string,
    runId: string,
    status: "completed" | "cancelled" | "failed",
    error?: string,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .update(cloudAgentRuns)
      .set({
        status,
        error: error ?? null,
        completedAt: now,
      })
      .where(eq(cloudAgentRuns.id, runId));
    await this.db
      .update(cloudAgentSessions)
      .set({
        activeRunId: null,
        updatedAt: now,
      })
      .where(and(eq(cloudAgentSessions.id, sessionId), eq(cloudAgentSessions.activeRunId, runId)));
  }
}
