/**
 * Cloud Agent 持久会话存储 + 进程内 fan-out。
 * 事件先落库再广播，断线客户端按 afterSeq 续传即可追上。
 */
import { and, asc, desc, eq, exists, gt, ilike, inArray, isNull, or, sql } from "drizzle-orm";
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

/**
 * 标题模糊命中的最低相似度。
 * 0.2 太松（三四个字的标题里随便撞上一个三元组就进来），0.4 又会把
 * “部署脚步 → 部署脚本” 这类真正想要的错字命中挡掉。
 */
const TITLE_SIMILARITY_THRESHOLD = 0.3;

/**
 * drizzle 的 `execute()` 返回值随驱动而异：postgres-js 给的是类数组的 RowList，
 * PGlite 给的是 `{ rows: [...] }`。两种都得认。
 */
function rowCount(res: unknown): number {
  if (Array.isArray(res)) return res.length;
  const rows = (res as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows.length : 0;
}

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
      // 只探测，不建东西：扩展与 GIN 索引都由迁移（0026_session_search_trgm）
      // 在部署期建好。在请求路径里 CREATE INDEX 会锁住整张会话表的写入。
      this.trgmReady = this.db
        .execute(sql`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`)
        .then((res) => rowCount(res) > 0)
        .catch(() => false);
    }
    return this.trgmReady;
  }

  /**
   * 会话搜索。
   *
   * 标题走 pg_trgm 模糊匹配（`similarity` 取词级与整串的较大值），消息内容走
   * ILIKE 子串匹配——payload 是整条 JSON，对它做三元组相似度既慢又全是噪声。
   * 排序按「相关度优先、其次最近更新」：改名成 “部署脚本” 的会话，搜 “部署脚步”
   * 也能排在前面，而不是被一堆刚更新过的无关会话压下去。
   *
   * pg_trgm 不可用时（PGlite / 无 CREATE EXTENSION 权限）整体回退到纯 ILIKE。
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

    /**
     * 标题相关度 0–1。
     * `word_similarity(q, title)` 衡量「q 是否作为一个词出现在标题里」，
     * 对“长标题 + 短查询”比整串 similarity 友好得多；两者取大值兼顾两种形态。
     */
    const titleScore = trgmOk
      ? sql<number>`greatest(
          similarity(${cloudAgentSessions.title}, ${q}),
          word_similarity(${q}, ${cloudAgentSessions.title})
        )`
      : sql<number>`0`;

    /** 子串命中直接给满分，保证精确匹配永远排最前 */
    const rank = sql<number>`case when ${cloudAgentSessions.title} ilike ${pattern} then 1.0 else ${titleScore} end`;

    const matchCond = trgmOk
      ? or(
          ilike(cloudAgentSessions.title, pattern),
          sql`${titleScore} > ${TITLE_SIMILARITY_THRESHOLD}`,
          exists(eventMatch),
        )
      : or(ilike(cloudAgentSessions.title, pattern), exists(eventMatch));

    const rows = await this.db
      .select({ session: cloudAgentSessions, rank })
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
      .orderBy(desc(rank), desc(cloudAgentSessions.updatedAt))
      .limit(limit);

    const hits: CloudSessionSearchHit[] = [];
    for (const { session } of rows) {
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
    model?: string | null;
    modelRouteId?: string | null;
    reasoning?: string | null;
    draftText?: string;
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
      model: input.model?.trim() || null,
      modelRouteId: input.modelRouteId?.trim() || null,
      reasoning: input.reasoning?.trim() || null,
      draftText: input.draftText ?? "",
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
      model?: string | null;
      modelRouteId?: string | null;
      reasoning?: string | null;
      draftText?: string;
    },
  ): Promise<CloudAgentSession | null> {
    const existing = await this.getSession(tenantId, agentId, sessionId);
    if (!existing) return null;
    const hasSessionMetadataPatch =
      patch.title !== undefined || patch.status !== undefined || patch.kind !== undefined;
    await this.db
      .update(cloudAgentSessions)
      .set({
        ...(patch.title !== undefined ? { title: patch.title.trim() || existing.title } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        ...(patch.model !== undefined ? { model: patch.model?.trim() || null } : {}),
        ...(patch.modelRouteId !== undefined
          ? { modelRouteId: patch.modelRouteId?.trim() || null }
          : {}),
        ...(patch.reasoning !== undefined
          ? { reasoning: patch.reasoning?.trim() || null }
          : {}),
        ...(patch.draftText !== undefined ? { draftText: patch.draftText } : {}),
        ...(hasSessionMetadataPatch ? { updatedAt: new Date() } : {}),
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

  /**
   * 追加事件并 fan-out。
   * seq 通过 last_seq 原子 +1（UPDATE … RETURNING）分配，避免子代理并行
   * 写同一会话（如多路 onProgress / run_log）时读到相同 lastSeq 撞唯一约束。
   */
  async appendEvent(input: {
    sessionId: string;
    type: CloudAgentEventType;
    runId?: string | null;
    payload: CloudAgentEventPayload;
  }): Promise<CloudAgentEvent> {
    const eventId = newId();
    const now = new Date();

    const event = await this.db.transaction(async (tx) => {
      // 行级锁 + 原子递增：并发事务会串行化在同一 session 行上
      const [allocated] = await tx
        .update(cloudAgentSessions)
        .set({
          lastSeq: sql`${cloudAgentSessions.lastSeq} + 1`,
          updatedAt: now,
        })
        .where(eq(cloudAgentSessions.id, input.sessionId))
        .returning();
      if (!allocated) throw new Error("会话不存在");
      const seq = allocated.lastSeq;
      await tx.insert(cloudAgentEvents).values({
        id: eventId,
        sessionId: input.sessionId,
        seq,
        type: input.type,
        runId: input.runId ?? null,
        payloadJson: JSON.stringify(input.payload),
        createdAt: now,
      });
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
    // Claim the session before inserting the Run. The previous insert-then-update
    // sequence allowed concurrent requests to all pass the activeRunId check.
    const claimed = await this.db
      .update(cloudAgentSessions)
      .set({ activeRunId: id, updatedAt: now })
      .where(and(eq(cloudAgentSessions.id, sessionId), isNull(cloudAgentSessions.activeRunId)))
      .returning();
    if (claimed.length === 0) {
      throw new Error("当前会话已有进行中的 Run，请先等待或取消");
    }

    try {
      await this.db.insert(cloudAgentRuns).values({
        id,
        sessionId,
        status: "queued",
        cancelRequested: false,
        createdAt: now,
      });
    } catch (err) {
      await this.db
        .update(cloudAgentSessions)
        .set({ activeRunId: null, updatedAt: new Date() })
        .where(and(eq(cloudAgentSessions.id, sessionId), eq(cloudAgentSessions.activeRunId, id)));
      throw err;
    }
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

  /**
   * 恢复被进程中断的 Run（服务重启/崩溃）。
   * 内存里的 agent loop 随进程消失，但 DB 里的 Run 仍是 queued/running、
   * 会话仍挂着 activeRunId，UI 会永远显示「进行中」。启动时把它们标记为
   * failed 并补齐 run_error/run_end 事件，前端重连即可看到真实状态。
   * 返回恢复的 Run 数量。
   */
  async recoverInterruptedRuns(): Promise<number> {
    const stale = await this.db
      .select()
      .from(cloudAgentRuns)
      .where(inArray(cloudAgentRuns.status, ["queued", "running"]));
    if (stale.length === 0) return 0;

    const message = "服务重启，该运行已中断";
    for (const run of stale) {
      try {
        // 事件先落库：SSE 重连的客户端据此结束「进行中」状态
        await this.appendEvent({
          sessionId: run.sessionId,
          type: "run_error",
          runId: run.id,
          payload: { runId: run.id, message },
        });
        await this.appendEvent({
          sessionId: run.sessionId,
          type: "run_end",
          runId: run.id,
          payload: { runId: run.id, status: "failed" },
        });
      } catch (err) {
        // 会话已删除等：仍要把 Run 状态改掉，避免下次启动重复处理
        console.warn(`[cloud-agent] recover run ${run.id} event failed:`, err);
      }
      await this.finishRun(run.sessionId, run.id, "failed", message);
    }

    // 兜底：清理指向已不存在 Run 的 activeRunId（历史数据/异常删除）
    await this.db
      .update(cloudAgentSessions)
      .set({ activeRunId: null })
      .where(
        and(
          sql`${cloudAgentSessions.activeRunId} IS NOT NULL`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${cloudAgentRuns}
            WHERE ${cloudAgentRuns.id} = ${cloudAgentSessions.activeRunId}
              AND ${cloudAgentRuns.status} IN ('queued', 'running')
          )`,
        ),
      );
    return stale.length;
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
