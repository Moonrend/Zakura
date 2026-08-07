/**
 * Redis：默认强制开启。地址只认 REDIS_URL（未设时默认 redis://127.0.0.1:6379）。
 * 显式 REDIS_URL=off|false|0 才关闭（本地无 Redis 的测试用）。
 *
 * 热数据布局（参考 Memoh session_runtime）：
 * - seq / pending / evt channel：流式序号、待落库、Pub/Sub
 * - events 环 / meta / run：近期事件与会话/Run 快照（少打 Postgres）
 * - auth / tools / gw client：鉴权与工具列表短 TTL 缓存
 */
import { createClient, type RedisClientType } from "redis";

export type ZakuraRedis = RedisClientType;

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

let client: ZakuraRedis | null = null;
let connecting: Promise<ZakuraRedis> | null = null;
let warned = false;

/** 解析地址；off 表示关闭，否则必有可用 URL */
export function redisUrlFromEnv(): string | null {
  const raw = process.env.REDIS_URL?.trim();
  if (raw === "off" || raw === "0" || raw === "false" || raw === "none") {
    return null;
  }
  return raw || DEFAULT_REDIS_URL;
}

export function isRedisEnabled(): boolean {
  return redisUrlFromEnv() !== null;
}

export async function getRedis(): Promise<ZakuraRedis | null> {
  const url = redisUrlFromEnv();
  if (!url) return null;
  return requireRedis();
}

/** 连接 Redis；失败抛错（强制开启，不静默回退） */
export async function requireRedis(): Promise<ZakuraRedis> {
  const url = redisUrlFromEnv();
  if (!url) {
    throw new Error("Redis 已关闭（REDIS_URL=off）；流式加速不可用");
  }
  if (client?.isOpen) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      const c = createClient({ url }) as ZakuraRedis;
      c.on("error", (err) => {
        if (!warned) {
          warned = true;
          console.warn("[redis] error:", err instanceof Error ? err.message : err);
        }
      });
      await c.connect();
      client = c;
      console.log(`[redis] connected (${url.replace(/:[^:@/]+@/, ":***@")})`);
      return c;
    } catch (err) {
      client = null;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Redis 连接失败（REDIS_URL=${url}）。请检查地址或设 REDIS_URL=off 显式关闭：${msg}`,
      );
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

/** 独立 subscriber（redis 客户端不能既发命令又 SUBSCRIBE） */
export async function createRedisSubscriber(): Promise<ZakuraRedis | null> {
  const url = redisUrlFromEnv();
  if (!url) return null;
  try {
    const c = createClient({ url }) as ZakuraRedis;
    c.on("error", (err) => {
      console.warn("[redis] subscriber error:", err instanceof Error ? err.message : err);
    });
    await c.connect();
    return c;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Redis subscriber 连接失败（REDIS_URL=${url}）：${msg}`);
  }
}

export async function closeRedis(): Promise<void> {
  const c = client;
  client = null;
  connecting = null;
  if (c?.isOpen) {
    try {
      await c.quit();
    } catch {
      /* ignore */
    }
  }
}

export const REDIS_KEYS = {
  seq: (sessionId: string) => `zakura:cloud:seq:${sessionId}`,
  pending: (sessionId: string) => `zakura:cloud:pending:${sessionId}`,
  channel: (sessionId: string) => `zakura:cloud:evt:${sessionId}`,
  /** 近期事件环（List，LTRIM 保活） */
  events: (sessionId: string) => `zakura:cloud:events:${sessionId}`,
  /** 会话元数据快照 */
  meta: (sessionId: string) => `zakura:cloud:meta:${sessionId}`,
  /** Run 状态快照 */
  run: (runId: string) => `zakura:cloud:run:${runId}`,
  /** API Key 鉴权缓存 */
  auth: (keyHash: string) => `zakura:auth:key:${keyHash}`,
  /** Agent 工具列表短缓存 */
  tools: (agentId: string) => `zakura:tools:agent:${agentId}`,
  /** Gateway clientSessionKey → sessionId */
  gwClient: (agentId: string, clientKey: string) =>
    `zakura:gw:client:${agentId}:${encodeURIComponent(clientKey)}`,
} as const;
