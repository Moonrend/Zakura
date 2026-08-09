/**
 * Cloud Agent 持久会话存储 + fan-out。
 *
 * Redis 默认强制开启（地址见 REDIS_URL，默认 redis://127.0.0.1:6379）：
 * 序号走 INCR，实时 PUBLISH，高频 delta 先推送再异步批落库。
 * 仅当 REDIS_URL=off 时回退为「每事件同步写库 + 进程内 fan-out」。
 */
import { and, asc, desc, eq, exists, gt, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type {
  CloudAgentEvent,
  CloudAgentEventPayload,
  CloudAgentEventType,
  CloudAgentQueuedMessage,
  CloudAgentSessionKind,
  CloudAgentSessionOrigin,
} from "@zakura/shared";
import type { Db } from "../db/client.js";
import {
  cloudAgentEvents,
  cloudAgentRuns,
  cloudAgentSessions,
  newId,
  users,
  type CloudAgentRun,
  type CloudAgentSession,
} from "../db/schema.js";
import { platformEvents } from "./platform-events.js";
import {
  REDIS_KEYS,
  createRedisSubscriber,
  getRedis,
  isRedisEnabled,
  requireRedis,
  type ZakuraRedis,
} from "./redis.js";
import {
  enqueueEventRing,
  clipEventWindow,
  readEventRing,
  writeRunSnapshot,
  writeSessionMeta,
} from "./redis-store.js";

type SessionListener = (event: CloudAgentEvent) => void;

/** 高频增量：可异步落库；其余事件仍同步落库以保证工具/终态可读 */
const ASYNC_EVENT_TYPES = new Set<CloudAgentEventType>([
  "assistant_delta",
  "reasoning_delta",
]);

type PendingRow = {
  event: CloudAgentEvent;
  tenantId: string;
  agentId: string;
};

/** 区分本进程 PUBLISH，避免本地 emit + Redis 回环双推 */
const INSTANCE_ID = newId();

type RedisFanoutMessage = {
  from: string;
  event: CloudAgentEvent;
};

/** 会改变侧栏会话列表（标题/顺序/活跃态）的事件 */
const SIDEBAR_TOUCH_TYPES = new Set<CloudAgentEventType>([
  "user_message",
  "assistant_message",
  "run_end",
  "run_error",
  "session_update",
]);

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

/** 队列快照的 Redis 存活时长：足够跨天续用，又不会永久漏存 */
const QUEUE_TTL_SECONDS = 7 * 24 * 60 * 60;

function normalizeQueuedMessage(item: CloudAgentQueuedMessage): CloudAgentQueuedMessage {
  return {
    messageId: item.messageId,
    content: item.content ?? "",
    attachments: item.attachments ?? [],
    mode: item.mode === "queue" ? "queue" : "steer",
    ...(item.interrupt ? { interrupt: true } : {}),
    createdAt: item.createdAt || new Date().toISOString(),
  };
}

type CancelFanoutMessage = {
  from: string;
  runId: string;
};

export class CloudAgentSessionStore {
  /** sessionId → listeners */
  private readonly listeners = new Map<string, Set<SessionListener>>();
  /** pg_trgm 可用性（惰性探测；PGlite/无权限时回退 ILIKE） */
  private trgmReady: Promise<boolean> | null = null;
  /** sessionId → 异步落库链（保序） */
  private readonly persistChains = new Map<string, Promise<unknown>>();
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Redis 订阅客户端（与命令客户端分离） */
  private subClient: ZakuraRedis | null = null;
  private subReady: Promise<ZakuraRedis | null> | null = null;
  /** channel → refcount of local listeners using Redis fan-in */
  private readonly remoteRef = new Map<string, { count: number; unsub: () => Promise<void> }>();
  /** 会话元数据缓存：避免每个 delta 查库 */
  private readonly sessionMeta = new Map<
    string,
    { tenantId: string; agentId: string; lastSeq: number; seqSeeded: boolean }
  >();
  /** REDIS_URL=off 时的进程内会话队列 */
  private readonly memQueues = new Map<string, CloudAgentQueuedMessage[]>();
  /** REDIS_URL=off：立即发送待开跑的下一条 */
  private readonly memQueueNext = new Map<string, CloudAgentQueuedMessage>();
  /** sessionId → 队列读改写串行链（本实例内避免并发丢更新） */
  private readonly queueChains = new Map<string, Promise<unknown>>();
  /** 已收到取消信号的 Run（本地快速判定，免打 DB） */
  private readonly cancelledRuns = new Set<string>();
  /** runId → 取消回调（loop 注册，收到信号立即 abort 上游流） */
  private readonly cancelListeners = new Map<string, Set<() => void>>();
  /** 全局取消频道订阅（懒启动，跨实例即时传导） */
  private cancelSubReady: Promise<void> | null = null;

  constructor(private readonly db: Db) {}

  /** 供 Run 启动时预热：元数据 + Redis seq，避免首个 delta 踩 DB */
  async warmSession(sessionId: string, hint?: { tenantId: string; agentId: string; lastSeq: number }) {
    if (hint) {
      this.sessionMeta.set(sessionId, {
        tenantId: hint.tenantId,
        agentId: hint.agentId,
        lastSeq: hint.lastSeq,
        seqSeeded: this.sessionMeta.get(sessionId)?.seqSeeded ?? false,
      });
    } else if (!this.sessionMeta.has(sessionId)) {
      const row = await this.db.query.cloudAgentSessions.findFirst({
        where: eq(cloudAgentSessions.id, sessionId),
        columns: { tenantId: true, agentId: true, lastSeq: true, activeRunId: true, status: true },
      });
      if (row) {
        this.sessionMeta.set(sessionId, {
          tenantId: row.tenantId,
          agentId: row.agentId,
          lastSeq: row.lastSeq,
          seqSeeded: false,
        });
        void writeSessionMeta(sessionId, {
          tenantId: row.tenantId,
          agentId: row.agentId,
          lastSeq: row.lastSeq,
          activeRunId: row.activeRunId,
          status: row.status,
        });
      }
    }
    if (!isRedisEnabled()) return;
    const meta = this.sessionMeta.get(sessionId);
    if (!meta) return;
    void writeSessionMeta(sessionId, {
      tenantId: meta.tenantId,
      agentId: meta.agentId,
      lastSeq: meta.lastSeq,
    });
    if (meta.seqSeeded) return;
    const redis = await requireRedis();
    await this.raiseRedisSeqFloor(redis, sessionId, meta.lastSeq);
    meta.seqSeeded = true;
  }

  private rememberMeta(
    sessionId: string,
    meta: { tenantId: string; agentId: string; lastSeq?: number },
  ) {
    const prev = this.sessionMeta.get(sessionId);
    const next = {
      tenantId: meta.tenantId,
      agentId: meta.agentId,
      lastSeq: meta.lastSeq ?? prev?.lastSeq ?? 0,
      seqSeeded: prev?.seqSeeded ?? false,
    };
    this.sessionMeta.set(sessionId, next);
    void writeSessionMeta(sessionId, {
      tenantId: next.tenantId,
      agentId: next.agentId,
      lastSeq: next.lastSeq,
    });
  }

  /** 事件对外可见后写入 Redis 环 + 刷新 meta（Memoh 式活状态） */
  private async mirrorEventToRedis(
    redis: ZakuraRedis | null,
    event: CloudAgentEvent,
    meta: { tenantId: string; agentId: string },
  ) {
    // 同步事件必须等环写完：executeRun 紧接着 listEvents 读环，否则会丢刚落库的 user_message
    if (redis) await enqueueEventRing(redis, event.sessionId, event);
    void writeSessionMeta(event.sessionId, {
      tenantId: meta.tenantId,
      agentId: meta.agentId,
      lastSeq: event.seq,
    });
    if (event.runId && (event.type === "run_start" || event.type === "run_status" || event.type === "run_end")) {
      const status =
        event.type === "run_end"
          ? String((event.payload as { status?: string }).status ?? "ended")
          : event.type === "run_status"
            ? String((event.payload as { status?: string }).status ?? "running")
            : "running";
      void writeRunSnapshot({
        runId: event.runId,
        sessionId: event.sessionId,
        status,
        updatedAt: event.createdAt,
      });
    }
  }

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
    void this.ensureRedisSubscription(sessionId);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) {
        this.listeners.delete(sessionId);
        void this.releaseRedisSubscription(sessionId);
      }
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

  private async ensureSubClient(): Promise<ZakuraRedis | null> {
    if (this.subClient?.isOpen) return this.subClient;
    if (!this.subReady) {
      this.subReady = createRedisSubscriber().then((c) => {
        this.subClient = c;
        return c;
      });
    }
    return this.subReady;
  }

  private async ensureRedisSubscription(sessionId: string): Promise<void> {
    const existing = this.remoteRef.get(sessionId);
    if (existing) {
      existing.count += 1;
      return;
    }
    const sub = await this.ensureSubClient();
    if (!sub) return;
    const channel = REDIS_KEYS.channel(sessionId);
    const onMessage = (message: string) => {
      try {
        const msg = JSON.parse(message) as RedisFanoutMessage;
        if (msg.from === INSTANCE_ID) return;
        this.emit(msg.event);
      } catch (err) {
        console.warn("[cloud-agent] redis message parse failed:", err);
      }
    };
    await sub.subscribe(channel, onMessage);
    this.remoteRef.set(sessionId, {
      count: 1,
      unsub: async () => {
        try {
          await sub.unsubscribe(channel);
        } catch {
          /* ignore */
        }
      },
    });
  }

  private async releaseRedisSubscription(sessionId: string): Promise<void> {
    const entry = this.remoteRef.get(sessionId);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    this.remoteRef.delete(sessionId);
    await entry.unsub();
  }

  /**
   * 把 Redis seq 抬到 >= floor（只升不降）。
   * ponytail: SET NX 无法修复 Redis 从旧快照恢复后落后于 Postgres 的情况。
   */
  private async raiseRedisSeqFloor(
    redis: ZakuraRedis,
    sessionId: string,
    floor: number,
  ): Promise<void> {
    if (floor < 0) return;
    const key = REDIS_KEYS.seq(sessionId);
    // 原子：cur < floor 才 SET，避免并发 INCR 被回写压低
    await redis.eval(
      `local cur = tonumber(redis.call('GET', KEYS[1]) or '-1')
       local floor = tonumber(ARGV[1])
       if cur < floor then redis.call('SET', KEYS[1], floor) end
       return 0`,
      { keys: [key], arguments: [String(floor)] },
    );
  }

  /** Redis INCR；落后时按 DB/进程高水位抬升后再 +1 */
  private async nextSeqRedis(redis: ZakuraRedis, sessionId: string): Promise<number> {
    const key = REDIS_KEYS.seq(sessionId);
    let meta = this.sessionMeta.get(sessionId);
    if (!meta?.seqSeeded) {
      const row = await this.db.query.cloudAgentSessions.findFirst({
        where: eq(cloudAgentSessions.id, sessionId),
        columns: { lastSeq: true, tenantId: true, agentId: true },
      });
      if (!row) throw new Error("会话不存在");
      const floor = Math.max(meta?.lastSeq ?? 0, row.lastSeq);
      await this.raiseRedisSeqFloor(redis, sessionId, floor);
      if (!meta) {
        meta = {
          tenantId: row.tenantId,
          agentId: row.agentId,
          lastSeq: floor,
          seqSeeded: true,
        };
        this.sessionMeta.set(sessionId, meta);
      } else {
        meta.lastSeq = floor;
        meta.seqSeeded = true;
      }
    } else {
      // 同进程已观测到的高水位：Redis 回滚时仍能抬回去
      await this.raiseRedisSeqFloor(redis, sessionId, meta.lastSeq);
    }
    const seq = await redis.incr(key);
    const m = this.sessionMeta.get(sessionId);
    if (m) m.lastSeq = seq;
    return seq;
  }

  /** 唯一约束冲突时：按 DB last_seq 重新抬升 Redis 后再分配 */
  private async nextSeqRedisAfterConflict(
    redis: ZakuraRedis,
    sessionId: string,
  ): Promise<number> {
    const row = await this.db.query.cloudAgentSessions.findFirst({
      where: eq(cloudAgentSessions.id, sessionId),
      columns: { lastSeq: true, tenantId: true, agentId: true },
    });
    if (!row) throw new Error("会话不存在");
    const meta = this.sessionMeta.get(sessionId);
    const floor = Math.max(meta?.lastSeq ?? 0, row.lastSeq);
    await this.raiseRedisSeqFloor(redis, sessionId, floor);
    if (meta) {
      meta.lastSeq = floor;
      meta.seqSeeded = true;
    } else {
      this.sessionMeta.set(sessionId, {
        tenantId: row.tenantId,
        agentId: row.agentId,
        lastSeq: floor,
        seqSeeded: true,
      });
    }
    const seq = await redis.incr(REDIS_KEYS.seq(sessionId));
    const m = this.sessionMeta.get(sessionId);
    if (m) m.lastSeq = seq;
    return seq;
  }

  private isSeqUniqueViolation(err: unknown): boolean {
    const messages: string[] = [];
    let cur: unknown = err;
    for (let i = 0; i < 6 && cur; i++) {
      if (cur instanceof Error) {
        messages.push(cur.message);
        cur = cur.cause;
        continue;
      }
      if (cur && typeof cur === "object" && "message" in cur) {
        messages.push(String((cur as { message: unknown }).message));
      }
      break;
    }
    const text = messages.join("\n");
    return (
      text.includes("cloud_agent_events_session_seq") ||
      (text.includes("duplicate key") && text.includes("session_seq")) ||
      (text.includes("unique") && text.includes("session_seq"))
    );
  }

  private schedulePersistFlush(sessionId: string): void {
    if (this.flushTimers.has(sessionId)) return;
    this.flushTimers.set(
      sessionId,
      setTimeout(() => {
        this.flushTimers.delete(sessionId);
        void this.flushPending(sessionId);
      }, 80),
    );
  }

  /** 把 Redis pending 列表批写入 Postgres（保序；失败重试入队） */
  async flushPending(sessionId: string): Promise<void> {
    const prev = this.persistChains.get(sessionId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        const redis = await getRedis();
        if (!redis) return;
        const key = REDIS_KEYS.pending(sessionId);
        // 一次拿走当前全部 pending，避免与新 push 交错丢数据
        const raw = await redis.lRange(key, 0, -1);
        if (raw.length === 0) return;
        await redis.lTrim(key, raw.length, -1);

        const rows: PendingRow[] = [];
        for (const s of raw) {
          try {
            rows.push(JSON.parse(s) as PendingRow);
          } catch {
            /* skip corrupt */
          }
        }
        if (rows.length === 0) return;

        try {
          await this.db.transaction(async (tx) => {
            await tx
              .insert(cloudAgentEvents)
              .values(
                rows.map(({ event }) => ({
                  id: event.id,
                  sessionId: event.sessionId,
                  seq: event.seq,
                  type: event.type,
                  runId: event.runId,
                  payloadJson: JSON.stringify(event.payload),
                  createdAt: new Date(event.createdAt),
                })),
              )
              .onConflictDoNothing();
            const maxSeq = Math.max(...rows.map((r) => r.event.seq));
            const touchSidebar = rows.some((r) => SIDEBAR_TOUCH_TYPES.has(r.event.type));
            await tx
              .update(cloudAgentSessions)
              .set({
                lastSeq: sql`greatest(${cloudAgentSessions.lastSeq}, ${maxSeq})`,
                ...(touchSidebar ? { updatedAt: new Date() } : {}),
              })
              .where(eq(cloudAgentSessions.id, sessionId));
          });
        } catch (err) {
          console.warn("[cloud-agent] pending flush failed, re-queue:", err);
          // ponytail: 整批重入队；升级路径可按条去重 / 死信
          if (rows.length) {
            await redis.rPush(
              key,
              rows.map((r) => JSON.stringify(r)),
            );
          }
        }
      });
    this.persistChains.set(sessionId, next);
    await next;
  }

  private async publishRedis(redis: ZakuraRedis, event: CloudAgentEvent): Promise<void> {
    try {
      const msg: RedisFanoutMessage = { from: INSTANCE_ID, event };
      await redis.publish(REDIS_KEYS.channel(event.sessionId), JSON.stringify(msg));
    } catch (err) {
      console.warn("[cloud-agent] redis publish failed:", err);
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
    this.rememberMeta(id, {
      tenantId: input.tenantId,
      agentId: input.agentId,
      lastSeq: 0,
    });
    platformEvents.publish(input.tenantId, {
      type: "cloud_session_changed",
      agentId: input.agentId,
      sessionId: id,
      reason: "created",
    });
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

  async listGatewaySessions(
    tenantId: string,
    agentId: string,
    opts?: { limit?: number; includeArchived?: boolean },
  ): Promise<CloudAgentSession[]> {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const cond = and(
      eq(cloudAgentSessions.tenantId, tenantId),
      eq(cloudAgentSessions.agentId, agentId),
      ilike(cloudAgentSessions.originJson, '%"channel":"openai-gateway"%'),
      ...(opts?.includeArchived ? [] : [eq(cloudAgentSessions.status, "active")]),
    );
    return this.db
      .select()
      .from(cloudAgentSessions)
      .where(cond)
      .orderBy(desc(cloudAgentSessions.updatedAt))
      .limit(limit);
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

  /** 会话创建者注册邮箱（系统通知 / 危机支持收件人） */
  async resolveSessionOwnerEmail(
    tenantId: string,
    agentId: string,
    sessionId: string,
  ): Promise<string | null> {
    const session = await this.getSession(tenantId, agentId, sessionId);
    if (!session?.createdByUserId) return null;
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, session.createdByUserId),
      columns: { email: true },
    });
    const email = user?.email?.trim();
    return email || null;
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
    if (hasSessionMetadataPatch) {
      platformEvents.publish(tenantId, {
        type: "cloud_session_changed",
        agentId,
        sessionId,
        reason: "updated",
      });
    }
    return this.getSession(tenantId, agentId, sessionId);
  }

  async deleteSession(tenantId: string, agentId: string, sessionId: string): Promise<boolean> {
    const existing = await this.getSession(tenantId, agentId, sessionId);
    if (!existing) return false;
    await this.flushPending(sessionId);
    await this.db.delete(cloudAgentSessions).where(eq(cloudAgentSessions.id, sessionId));
    this.listeners.delete(sessionId);
    this.sessionMeta.delete(sessionId);
    this.memQueues.delete(sessionId);
    this.memQueueNext.delete(sessionId);
    this.queueChains.delete(sessionId);
    void this.releaseRedisSubscription(sessionId);
    const redis = await getRedis();
    if (redis) {
      try {
        await redis.del([
          REDIS_KEYS.seq(sessionId),
          REDIS_KEYS.pending(sessionId),
          REDIS_KEYS.events(sessionId),
          REDIS_KEYS.meta(sessionId),
          REDIS_KEYS.queue(sessionId),
          REDIS_KEYS.queueNext(sessionId),
        ]);
      } catch {
        /* ignore */
      }
    }
    platformEvents.publish(tenantId, {
      type: "cloud_session_changed",
      agentId,
      sessionId,
      reason: "updated",
    });
    return true;
  }

  /**
   * 追加事件并 fan-out。
   * Redis 开启（默认）：INCR 分配 seq；delta 先 PUBLISH 再异步批落库，其它类型同步落库。
   * REDIS_URL=off：seq 经 last_seq 原子 +1，事务落库后再进程内广播。
   */
  async appendEvent(input: {
    sessionId: string;
    type: CloudAgentEventType;
    runId?: string | null;
    payload: CloudAgentEventPayload;
  }): Promise<CloudAgentEvent> {
    if (isRedisEnabled()) {
      const redis = await requireRedis();
      return this.appendEventRedis(redis, input);
    }
    return this.appendEventDb(input);
  }

  private async appendEventRedis(
    redis: ZakuraRedis,
    input: {
      sessionId: string;
      type: CloudAgentEventType;
      runId?: string | null;
      payload: CloudAgentEventPayload;
    },
  ): Promise<CloudAgentEvent> {
    const asyncOk = ASYNC_EVENT_TYPES.has(input.type);
    if (!asyncOk) {
      // 终态/工具事件前先把 delta 刷进 DB，避免回放缺段
      await this.flushPending(input.sessionId);
    }

    const eventId = newId();
    const now = new Date();
    const seq = await this.nextSeqRedis(redis, input.sessionId);
    let event: CloudAgentEvent = {
      id: eventId,
      sessionId: input.sessionId,
      seq,
      type: input.type,
      runId: input.runId ?? null,
      payload: input.payload,
      createdAt: now.toISOString(),
    };

    let meta = this.sessionMeta.get(input.sessionId);
    if (!meta) {
      const session = await this.db.query.cloudAgentSessions.findFirst({
        where: eq(cloudAgentSessions.id, input.sessionId),
        columns: { tenantId: true, agentId: true, lastSeq: true },
      });
      if (!session) throw new Error("会话不存在");
      meta = {
        tenantId: session.tenantId,
        agentId: session.agentId,
        lastSeq: seq,
        seqSeeded: true,
      };
      this.sessionMeta.set(input.sessionId, meta);
    } else {
      meta.lastSeq = seq;
    }

    if (asyncOk) {
      // 热路径：先本地 emit（同进程 SSE 立刻看到思考/正文），再异步 pending + pub/sub + 事件环
      this.emit(event);
      const pending: PendingRow = {
        event,
        tenantId: meta.tenantId,
        agentId: meta.agentId,
      };
      void redis
        .multi()
        .rPush(REDIS_KEYS.pending(input.sessionId), JSON.stringify(pending))
        .rPush(REDIS_KEYS.events(input.sessionId), JSON.stringify(event))
        .lTrim(REDIS_KEYS.events(input.sessionId), -500, -1)
        .expire(REDIS_KEYS.events(input.sessionId), 24 * 60 * 60)
        .publish(
          REDIS_KEYS.channel(input.sessionId),
          JSON.stringify({ from: INSTANCE_ID, event } satisfies RedisFanoutMessage),
        )
        .exec()
        .catch((err) => console.warn("[cloud-agent] redis delta fanout failed:", err));
      void writeSessionMeta(input.sessionId, {
        tenantId: meta.tenantId,
        agentId: meta.agentId,
        lastSeq: seq,
      });
      this.schedulePersistFlush(input.sessionId);
      return event;
    }

    const persist = async (e: CloudAgentEvent) => {
      await this.db.transaction(async (tx) => {
        await tx.insert(cloudAgentEvents).values({
          id: e.id,
          sessionId: e.sessionId,
          seq: e.seq,
          type: e.type,
          runId: e.runId,
          payloadJson: JSON.stringify(e.payload),
          createdAt: new Date(e.createdAt),
        });
        await tx
          .update(cloudAgentSessions)
          .set({
            lastSeq: sql`greatest(${cloudAgentSessions.lastSeq}, ${e.seq})`,
            updatedAt: new Date(e.createdAt),
          })
          .where(eq(cloudAgentSessions.id, e.sessionId));
      });
    };

    try {
      await persist(event);
    } catch (err) {
      if (!this.isSeqUniqueViolation(err)) throw err;
      // Redis 落后于 Postgres：抬升后换号重试一次
      console.warn(
        `[cloud-agent] seq conflict session=${input.sessionId} seq=${seq}, resync from db`,
      );
      const retrySeq = await this.nextSeqRedisAfterConflict(redis, input.sessionId);
      event = { ...event, seq: retrySeq };
      meta.lastSeq = retrySeq;
      await persist(event);
    }

    this.emit(event);
    await this.mirrorEventToRedis(redis, event, meta);
    void this.publishRedis(redis, event);
    if (SIDEBAR_TOUCH_TYPES.has(input.type)) {
      platformEvents.publish(meta.tenantId, {
        type: "cloud_session_changed",
        agentId: meta.agentId,
        sessionId: input.sessionId,
        reason: "updated",
      });
    }
    return event;
  }

  private async appendEventDb(input: {
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
        event: {
          id: eventId,
          sessionId: input.sessionId,
          seq,
          type: input.type,
          runId: input.runId ?? null,
          payload: input.payload,
          createdAt: now.toISOString(),
        } satisfies CloudAgentEvent,
        tenantId: allocated.tenantId,
        agentId: allocated.agentId,
      };
    });

    this.emit(event.event);
    if (isRedisEnabled()) {
      void getRedis().then((redis) => {
        if (redis) void this.mirrorEventToRedis(redis, event.event, event);
      });
    }
    if (SIDEBAR_TOUCH_TYPES.has(input.type)) {
      platformEvents.publish(event.tenantId, {
        type: "cloud_session_changed",
        agentId: event.agentId,
        sessionId: input.sessionId,
        reason: "updated",
      });
    }
    return event.event;
  }

  /**
   * 批量写入事件（Fork 拷贝用）：单事务按序分配 seq，跳过逐条锁开销。
   * 调用方应保证 session 尚无事件（或自行处理 seq 衔接）。
   */
  async appendEventsBulk(
    sessionId: string,
    events: Array<{
      type: CloudAgentEventType;
      runId?: string | null;
      payload: CloudAgentEventPayload;
    }>,
  ): Promise<number> {
    if (events.length === 0) return 0;
    const now = new Date();
    const rows = events.map((ev, i) => ({
      id: newId(),
      sessionId,
      seq: i + 1,
      type: ev.type,
      runId: ev.runId ?? null,
      payloadJson: JSON.stringify(ev.payload),
      createdAt: now,
    }));

    const session = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(cloudAgentSessions)
        .set({ lastSeq: rows.length, updatedAt: now })
        .where(eq(cloudAgentSessions.id, sessionId))
        .returning();
      if (!updated) throw new Error("会话不存在");
      // 分块插入，避免超大会话参数上限
      const chunk = 200;
      for (let i = 0; i < rows.length; i += chunk) {
        await tx.insert(cloudAgentEvents).values(rows.slice(i, i + chunk));
      }
      return updated;
    });

    this.rememberMeta(sessionId, {
      tenantId: session.tenantId,
      agentId: session.agentId,
      lastSeq: rows.length,
    });
    if (isRedisEnabled()) {
      // 播种 Redis seq，避免后续 append 从 0 冲突
      void getRedis().then(async (redis) => {
        if (!redis) return;
        try {
          await redis.set(REDIS_KEYS.seq(sessionId), String(rows.length), { NX: true });
          const meta = this.sessionMeta.get(sessionId);
          if (meta) meta.seqSeeded = true;
        } catch {
          /* ignore */
        }
      });
    }
    platformEvents.publish(session.tenantId, {
      type: "cloud_session_changed",
      agentId: session.agentId,
      sessionId,
      reason: "updated",
    });
    return rows.length;
  }

  async listEvents(
    sessionId: string,
    opts?: { afterSeq?: number; limit?: number; skipFlush?: boolean },
  ): Promise<CloudAgentEvent[]> {
    // 续传前尽量刷完本进程 pending（热路径可 skipFlush 以抢首字）
    if (!opts?.skipFlush) await this.flushPending(sessionId);

    const afterSeq = opts?.afterSeq ?? 0;
    const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 2000);
    const expectedLast = this.sessionMeta.get(sessionId)?.lastSeq;

    // 优先读 Redis 事件环（Memoh 式活状态）；空洞 / 落后于本进程已分配 seq 再回退 Postgres
    const fromRing = await readEventRing(sessionId, { afterSeq, limit });
    if (fromRing) {
      const redis = await getRedis();
      let merged = fromRing;
      if (redis) {
        try {
          const raw = await redis.lRange(REDIS_KEYS.pending(sessionId), 0, -1);
          if (raw.length > 0) {
            const seen = new Set(fromRing.map((e) => e.seq));
            merged = [...fromRing];
            for (const s of raw) {
              try {
                const ev = (JSON.parse(s) as PendingRow).event;
                if (ev.seq > afterSeq && !seen.has(ev.seq)) {
                  seen.add(ev.seq);
                  merged.push(ev);
                }
              } catch {
                /* skip */
              }
            }
            merged.sort((a, b) => a.seq - b.seq);
          }
        } catch {
          merged = fromRing;
        }
      }
      const newest = merged.length > 0 ? merged[merged.length - 1]!.seq : 0;
      // 同步事件刚写完、环推送尚未可见时 newest < expectedLast → 回退 DB
      if (expectedLast == null || newest >= expectedLast || afterSeq > 0) {
        return clipEventWindow(merged, limit, afterSeq);
      }
    }

    // afterSeq>0：按序续传下一页；否则取最新 limit 条（再翻成升序）
    const rows =
      afterSeq > 0
        ? await this.db
            .select()
            .from(cloudAgentEvents)
            .where(
              and(eq(cloudAgentEvents.sessionId, sessionId), gt(cloudAgentEvents.seq, afterSeq)),
            )
            .orderBy(asc(cloudAgentEvents.seq))
            .limit(limit)
        : (
            await this.db
              .select()
              .from(cloudAgentEvents)
              .where(eq(cloudAgentEvents.sessionId, sessionId))
              .orderBy(desc(cloudAgentEvents.seq))
              .limit(limit)
          ).reverse();
    const fromDb = rows.map(toEvent);

    const redis = await getRedis();
    if (!redis) return fromDb;

    let pending: CloudAgentEvent[] = [];
    try {
      const raw = await redis.lRange(REDIS_KEYS.pending(sessionId), 0, -1);
      pending = raw
        .map((s) => {
          try {
            return (JSON.parse(s) as PendingRow).event;
          } catch {
            return null;
          }
        })
        .filter((e): e is CloudAgentEvent => !!e && e.seq > afterSeq);
    } catch {
      return fromDb;
    }

    if (pending.length === 0) return fromDb;

    const seen = new Set(fromDb.map((e) => e.seq));
    const merged = [...fromDb];
    for (const e of pending) {
      if (seen.has(e.seq)) continue;
      seen.add(e.seq);
      merged.push(e);
    }
    merged.sort((a, b) => a.seq - b.seq);
    return clipEventWindow(merged, limit, afterSeq);
  }

  /**
   * 模型上下文投影专用（对齐 OpenCode / Memoh）：
   * - 读 Postgres 权威事件流，不走 Redis 热环（热环只服务 SSE）
   * - 返回 afterSeq 之后的**全部**事件（分页），不做条数尾窗截断
   * - 上下文体积由上层用字符/token 预算 + compaction 管理
   */
  async listEventsForChain(
    sessionId: string,
    opts?: { afterSeq?: number },
  ): Promise<CloudAgentEvent[]> {
    await this.flushPending(sessionId);
    const afterSeq = opts?.afterSeq ?? 0;
    const pageSize = 500;
    // ponytail: 极端兜底；正常会话靠 context_compacted 切边界，不应摸到此上限
    const hardCap = 50_000;
    const out: CloudAgentEvent[] = [];
    let cursor = afterSeq;
    for (;;) {
      const rows = await this.db
        .select()
        .from(cloudAgentEvents)
        .where(
          and(eq(cloudAgentEvents.sessionId, sessionId), gt(cloudAgentEvents.seq, cursor)),
        )
        .orderBy(asc(cloudAgentEvents.seq))
        .limit(pageSize);
      if (rows.length === 0) break;
      for (const row of rows) out.push(toEvent(row));
      cursor = rows[rows.length - 1]!.seq;
      if (rows.length < pageSize) break;
      if (out.length >= hardCap) {
        console.warn(
          `[cloud-agent] listEventsForChain hit hardCap=${hardCap} session=${sessionId} afterSeq=${afterSeq}`,
        );
        break;
      }
    }
    return out;
  }

  /** 最近一次上下文压缩事件（摘要在 payload.summary） */
  async getLastCompaction(sessionId: string): Promise<CloudAgentEvent | null> {
    const rows = await this.db
      .select()
      .from(cloudAgentEvents)
      .where(
        and(
          eq(cloudAgentEvents.sessionId, sessionId),
          eq(cloudAgentEvents.type, "context_compacted"),
        ),
      )
      .orderBy(desc(cloudAgentEvents.seq))
      .limit(1);
    return rows[0] ? toEvent(rows[0]) : null;
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
    const meta = this.sessionMeta.get(sessionId);
    if (meta) {
      void writeSessionMeta(sessionId, {
        tenantId: meta.tenantId,
        agentId: meta.agentId,
        lastSeq: meta.lastSeq,
        activeRunId: id,
      });
    }
    void writeRunSnapshot({
      runId: id,
      sessionId,
      status: "queued",
      updatedAt: now.toISOString(),
    });
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
    const run = await this.getRun(runId);
    if (run) {
      void writeRunSnapshot({
        runId,
        sessionId: run.sessionId,
        status: "running",
        updatedAt: new Date().toISOString(),
      });
    }
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
    // 即时传导：本进程直接触发监听器；跨实例经全局频道广播（DB 标记只作兜底轮询）
    this.fireRunCancel(targetId);
    if (isRedisEnabled()) {
      void getRedis().then((redis) => {
        if (!redis) return;
        const msg: CancelFanoutMessage = { from: INSTANCE_ID, runId: targetId };
        return redis.publish(REDIS_KEYS.cancelChannel, JSON.stringify(msg));
      }).catch((err) => console.warn("[cloud-agent] cancel publish failed:", err));
    }
    return true;
  }

  async isCancelRequested(runId: string): Promise<boolean> {
    if (this.cancelledRuns.has(runId)) return true;
    const run = await this.getRun(runId);
    return Boolean(run?.cancelRequested);
  }

  /**
   * 注册 Run 取消监听（loop 用于即时 abort 上游流与放弃慢工具等待）。
   * 已处于取消态则同步触发一次；返回注销函数。
   */
  onRunCancel(runId: string, listener: () => void): () => void {
    if (this.cancelledRuns.has(runId)) {
      try {
        listener();
      } catch {
        /* ignore */
      }
      return () => {};
    }
    let set = this.cancelListeners.get(runId);
    if (!set) {
      set = new Set();
      this.cancelListeners.set(runId, set);
    }
    set.add(listener);
    void this.ensureCancelSubscription();
    return () => {
      const cur = this.cancelListeners.get(runId);
      cur?.delete(listener);
      if (cur && cur.size === 0) this.cancelListeners.delete(runId);
    };
  }

  private fireRunCancel(runId: string): void {
    this.cancelledRuns.add(runId);
    const set = this.cancelListeners.get(runId);
    if (!set) return;
    this.cancelListeners.delete(runId);
    for (const fn of set) {
      try {
        fn();
      } catch (err) {
        console.warn("[cloud-agent] cancel listener error:", err);
      }
    }
  }

  /** 订阅全局取消频道（一次即可）；其它实例 requestCancel 时本实例的 loop 也能即时收到 */
  private ensureCancelSubscription(): Promise<void> {
    if (!isRedisEnabled()) return Promise.resolve();
    if (!this.cancelSubReady) {
      this.cancelSubReady = (async () => {
        const sub = await this.ensureSubClient();
        if (!sub) return;
        await sub.subscribe(REDIS_KEYS.cancelChannel, (message: string) => {
          try {
            const msg = JSON.parse(message) as CancelFanoutMessage;
            if (msg.from === INSTANCE_ID) return;
            if (typeof msg.runId === "string" && msg.runId) this.fireRunCancel(msg.runId);
          } catch {
            /* ignore malformed */
          }
        });
      })().catch((err) => {
        this.cancelSubReady = null;
        console.warn("[cloud-agent] cancel channel subscribe failed:", err);
      }) as Promise<void>;
    }
    return this.cancelSubReady;
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
    // 会话队列跨 Run 存续（服务端权威）；只清理该 Run 的取消状态
    this.cancelledRuns.delete(runId);
    this.cancelListeners.delete(runId);
  }

  // —— 会话级后续消息队列（服务端权威，跨设备同步） ——
  // 对齐 Codex：mode=steer 项由 loop 在下一工具批后注入当前 Run；
  // Run 结束后由 runtime 按 FIFO 一次取一条开新回合。每次变更广播 queue_update 快照。

  private async readQueueItems(sessionId: string): Promise<CloudAgentQueuedMessage[]> {
    if (isRedisEnabled()) {
      const redis = await getRedis();
      if (redis) {
        try {
          const raw = await redis.get(REDIS_KEYS.queue(sessionId));
          if (!raw) return [];
          const parsed = JSON.parse(raw) as unknown;
          if (!Array.isArray(parsed)) return [];
          return (parsed as CloudAgentQueuedMessage[])
            .filter((i) => i && typeof i.messageId === "string")
            .map(normalizeQueuedMessage);
        } catch {
          return [];
        }
      }
    }
    return this.memQueues.get(sessionId) ?? [];
  }

  private async writeQueueItems(
    sessionId: string,
    items: CloudAgentQueuedMessage[],
  ): Promise<void> {
    if (isRedisEnabled()) {
      const redis = await getRedis();
      if (redis) {
        try {
          if (items.length === 0) await redis.del(REDIS_KEYS.queue(sessionId));
          else {
            await redis.set(REDIS_KEYS.queue(sessionId), JSON.stringify(items), {
              EX: QUEUE_TTL_SECONDS,
            });
          }
          return;
        } catch (err) {
          console.warn("[cloud-agent] queue write failed:", err);
        }
      }
    }
    if (items.length === 0) this.memQueues.delete(sessionId);
    else this.memQueues.set(sessionId, items);
  }

  /** 串行化同会话的队列读改写；跨实例的罕见交错由快照广播收敛 */
  private mutateQueue<T>(
    sessionId: string,
    fn: (items: CloudAgentQueuedMessage[]) => { items: CloudAgentQueuedMessage[]; result: T },
  ): Promise<T> {
    const prev = this.queueChains.get(sessionId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        const current = await this.readQueueItems(sessionId);
        const { items, result } = fn([...current]);
        await this.writeQueueItems(sessionId, items);
        return result;
      });
    this.queueChains.set(sessionId, next);
    return next;
  }

  async listQueued(sessionId: string): Promise<CloudAgentQueuedMessage[]> {
    return this.readQueueItems(sessionId);
  }

  /** 全量快照广播（持久事件，SSE/断点续传天然覆盖多设备） */
  async publishQueueSnapshot(sessionId: string): Promise<void> {
    try {
      const items = await this.readQueueItems(sessionId);
      await this.appendEvent({
        sessionId,
        type: "queue_update",
        runId: null,
        payload: { items },
      });
    } catch (err) {
      console.warn("[cloud-agent] queue snapshot publish failed:", err);
    }
  }

  async enqueueQueued(
    sessionId: string,
    item: CloudAgentQueuedMessage,
  ): Promise<CloudAgentQueuedMessage[]> {
    const snapshot = await this.mutateQueue(sessionId, (items) => {
      const next = [...items.filter((i) => i.messageId !== item.messageId), normalizeQueuedMessage(item)];
      return { items: next, result: next };
    });
    await this.publishQueueSnapshot(sessionId);
    return snapshot;
  }

  async updateQueued(
    sessionId: string,
    messageId: string,
    patch: { content?: string },
  ): Promise<CloudAgentQueuedMessage | null> {
    const hit = await this.mutateQueue(sessionId, (items) => {
      let found: CloudAgentQueuedMessage | null = null;
      const next = items.map((i) => {
        if (i.messageId !== messageId) return i;
        found = { ...i, ...(patch.content !== undefined ? { content: patch.content } : {}) };
        return found;
      });
      return { items: next, result: found };
    });
    if (hit) await this.publishQueueSnapshot(sessionId);
    return hit;
  }

  async removeQueued(
    sessionId: string,
    messageId: string,
  ): Promise<CloudAgentQueuedMessage | null> {
    const hit = await this.mutateQueue(sessionId, (items) => {
      const found = items.find((i) => i.messageId === messageId) ?? null;
      return { items: items.filter((i) => i.messageId !== messageId), result: found };
    });
    if (hit) await this.publishQueueSnapshot(sessionId);
    return hit;
  }

  /** 引导：标记 interrupt 并移到队头（随后由调用方取消当前 Run / 触发出队） */
  async promoteQueued(
    sessionId: string,
    messageId: string,
  ): Promise<CloudAgentQueuedMessage | null> {
    const hit = await this.mutateQueue(sessionId, (items) => {
      const found = items.find((i) => i.messageId === messageId);
      if (!found) return { items, result: null };
      const promoted: CloudAgentQueuedMessage = { ...found, interrupt: true };
      return {
        items: [promoted, ...items.filter((i) => i.messageId !== messageId)],
        result: promoted,
      };
    });
    if (hit) await this.publishQueueSnapshot(sessionId);
    return hit;
  }

  /**
   * 立即发送：从队列摘出该条，写入 queue-next（取消收尾后优先开跑）。
   * 其它排队消息不动；队列快照立刻不含该条，UI 可马上消失。
   */
  async claimQueuedForImmediate(
    sessionId: string,
    messageId: string,
  ): Promise<CloudAgentQueuedMessage | null> {
    const hit = await this.mutateQueue(sessionId, (items) => {
      const found = items.find((i) => i.messageId === messageId);
      if (!found) return { items, result: null };
      return {
        items: items.filter((i) => i.messageId !== messageId),
        result: { ...found, interrupt: true },
      };
    });
    if (!hit) return null;
    await this.writeQueueNext(sessionId, hit);
    await this.publishQueueSnapshot(sessionId);
    return hit;
  }

  /** 取出立即发送待办（一次性）；没有则 null */
  async takeQueueNext(sessionId: string): Promise<CloudAgentQueuedMessage | null> {
    if (isRedisEnabled()) {
      const redis = await getRedis();
      if (redis) {
        try {
          const key = REDIS_KEYS.queueNext(sessionId);
          const raw = await redis.get(key);
          if (!raw) return null;
          await redis.del(key);
          const parsed = JSON.parse(raw) as CloudAgentQueuedMessage;
          if (!parsed?.messageId) return null;
          return normalizeQueuedMessage(parsed);
        } catch (err) {
          console.warn("[cloud-agent] queue-next read failed:", err);
          return null;
        }
      }
    }
    const hit = this.memQueueNext.get(sessionId) ?? null;
    if (hit) this.memQueueNext.delete(sessionId);
    return hit;
  }

  private async writeQueueNext(
    sessionId: string,
    item: CloudAgentQueuedMessage,
  ): Promise<void> {
    if (isRedisEnabled()) {
      const redis = await getRedis();
      if (redis) {
        try {
          await redis.set(REDIS_KEYS.queueNext(sessionId), JSON.stringify(item), {
            EX: QUEUE_TTL_SECONDS,
          });
          return;
        } catch (err) {
          console.warn("[cloud-agent] queue-next write failed:", err);
        }
      }
    }
    this.memQueueNext.set(sessionId, item);
  }

  /** FIFO 取队头（Run 结束后由服务端开下一回合） */
  async takeNextQueued(sessionId: string): Promise<CloudAgentQueuedMessage | null> {
    const hit = await this.mutateQueue(sessionId, (items) => {
      const [head, ...rest] = items;
      return { items: head ? rest : items, result: head ?? null };
    });
    if (hit) await this.publishQueueSnapshot(sessionId);
    return hit;
  }

  /** 出队后 startTurn 竞争失败时放回队头（不丢消息） */
  async requeueFront(sessionId: string, item: CloudAgentQueuedMessage): Promise<void> {
    await this.mutateQueue(sessionId, (items) => ({
      items: [normalizeQueuedMessage(item), ...items.filter((i) => i.messageId !== item.messageId)],
      result: null,
    }));
    await this.publishQueueSnapshot(sessionId);
  }

  /** 取出全部 mode=steer 项（loop 在工具批后注入当前 Run），FIFO */
  async drainSteerQueued(sessionId: string): Promise<CloudAgentQueuedMessage[]> {
    const drained = await this.mutateQueue(sessionId, (items) => ({
      items: items.filter((i) => i.mode !== "steer"),
      result: items.filter((i) => i.mode === "steer"),
    }));
    if (drained.length > 0) await this.publishQueueSnapshot(sessionId);
    return drained;
  }
}
