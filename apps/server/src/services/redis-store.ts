/**
 * Redis 热数据（对齐 Memoh session_runtime 思路）：
 * 活状态/近期事件/鉴权与工具缓存进 Redis；Postgres 仍是权威持久化。
 */
import type { CloudAgentEvent } from "@zakura/shared";
import { getRedis, isRedisEnabled, requireRedis, REDIS_KEYS, type ZakuraRedis } from "./redis.js";

export const REDIS_TTL = {
  /** 会话元数据 / 事件环（Memoh state_ttl 同量级） */
  session: 24 * 60 * 60,
  /** Run 快照 */
  run: 6 * 60 * 60,
  /** API Key 鉴权结果 */
  auth: 30,
  /** Agent 工具列表短缓存（热路径命中优先；配置变更后最多 5min 过期） */
  tools: 300,
  /** Gateway clientSessionKey → sessionId */
  gwClient: 24 * 60 * 60,
} as const;

/** 每个会话在 Redis 里保留的最近事件条数 */
export const EVENT_RING_MAX = 500;

export type SessionMetaRedis = {
  tenantId: string;
  agentId: string;
  lastSeq: number;
  activeRunId?: string | null;
  status?: string;
};

export type RunSnapshotRedis = {
  runId: string;
  sessionId: string;
  status: string;
  updatedAt: string;
};

export async function redisGetJson<T>(key: string): Promise<T | null> {
  const redis = await getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function redisSetJson(
  key: string,
  value: unknown,
  ttlSec: number,
): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), { EX: ttlSec });
  } catch (err) {
    console.warn("[redis] setJson failed:", err instanceof Error ? err.message : err);
  }
}

export async function redisDel(...keys: string[]): Promise<void> {
  const redis = await getRedis();
  if (!redis || keys.length === 0) return;
  try {
    await redis.del(keys);
  } catch {
    /* ignore */
  }
}

/** 写入会话元数据（跨实例可读，替代纯进程内 Map） */
export async function writeSessionMeta(sessionId: string, meta: SessionMetaRedis): Promise<void> {
  await redisSetJson(REDIS_KEYS.meta(sessionId), meta, REDIS_TTL.session);
}

export async function readSessionMeta(sessionId: string): Promise<SessionMetaRedis | null> {
  return redisGetJson<SessionMetaRedis>(REDIS_KEYS.meta(sessionId));
}

export async function writeRunSnapshot(snap: RunSnapshotRedis): Promise<void> {
  await redisSetJson(REDIS_KEYS.run(snap.runId), snap, REDIS_TTL.run);
}

export async function readRunSnapshot(runId: string): Promise<RunSnapshotRedis | null> {
  return redisGetJson<RunSnapshotRedis>(REDIS_KEYS.run(runId));
}

/**
 * 事件环：RPUSH + LTRIM，供 SSE 续传 / listEvents 热读，减少打 Postgres。
 * 与 pending（待落库 delta）分离：环里是已对外可见的完整事件。
 */
export function enqueueEventRing(
  redis: ZakuraRedis,
  sessionId: string,
  event: CloudAgentEvent,
): void {
  const key = REDIS_KEYS.events(sessionId);
  void redis
    .multi()
    .rPush(key, JSON.stringify(event))
    .lTrim(key, -EVENT_RING_MAX, -1)
    .expire(key, REDIS_TTL.session)
    .exec()
    .catch((err) => console.warn("[redis] event ring push failed:", err));
}

/** 从事件环按 afterSeq 读取；覆盖不全时返回 null，调用方回退 DB */
export async function readEventRing(
  sessionId: string,
  opts?: { afterSeq?: number; limit?: number },
): Promise<CloudAgentEvent[] | null> {
  if (!isRedisEnabled()) return null;
  const redis = await getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.lRange(REDIS_KEYS.events(sessionId), 0, -1);
    if (raw.length === 0) return null;
    const afterSeq = opts?.afterSeq ?? 0;
    const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 2000);
    const events: CloudAgentEvent[] = [];
    for (const s of raw) {
      try {
        const ev = JSON.parse(s) as CloudAgentEvent;
        if (ev.seq > afterSeq) events.push(ev);
      } catch {
        /* skip */
      }
    }
    if (events.length === 0) {
      // 环里最新 seq 已 <= afterSeq：完整追上，返回空数组（非 miss）
      try {
        const last = JSON.parse(raw[raw.length - 1]!) as CloudAgentEvent;
        if (last.seq <= afterSeq) return [];
      } catch {
        /* fall through */
      }
      return null;
    }
    // 若请求 afterSeq+1 但环最旧仍大于 afterSeq+1，说明有空洞 → 回退 DB
    const oldest = events[0]!.seq;
    if (afterSeq > 0 && oldest > afterSeq + 1) return null;
    events.sort((a, b) => a.seq - b.seq);
    return events.slice(0, limit);
  } catch {
    return null;
  }
}

export async function writeGwClientSession(
  agentId: string,
  clientKey: string,
  sessionId: string,
): Promise<void> {
  await redisSetJson(REDIS_KEYS.gwClient(agentId, clientKey), { sessionId }, REDIS_TTL.gwClient);
}

export async function readGwClientSession(
  agentId: string,
  clientKey: string,
): Promise<string | null> {
  const hit = await redisGetJson<{ sessionId?: string }>(REDIS_KEYS.gwClient(agentId, clientKey));
  return hit?.sessionId?.trim() || null;
}

/** 确保 Redis 可用时预连（启动用） */
export async function ensureRedisReady(): Promise<void> {
  if (!isRedisEnabled()) return;
  await requireRedis();
}
