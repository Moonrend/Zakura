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
import { log, recordPlatformFault } from "@zakura/core";

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
      const c = createClient({
        url,
        socket: { connectTimeout: 5_000 },
      }) as ZakuraRedis;
      c.on("error", (err) => {
        if (!warned) {
          warned = true;
          recordPlatformFault("redis.client", err, { dep: "redis" });
        }
      });
      await c.connect();
      client = c;
      log.info("dep.up", { dep: "redis" });
      return c;
    } catch (err) {
      client = null;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Redis 连接失败。请检查 REDIS_URL 或设 REDIS_URL=off 显式关闭：${msg}`,
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
    const c = createClient({
      url,
      socket: { connectTimeout: 5_000 },
    }) as ZakuraRedis;
    c.on("error", (err) => {
      recordPlatformFault("redis.subscriber", err, { dep: "redis" });
    });
    await c.connect();
    return c;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Redis subscriber 连接失败：${msg}`);
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
  /** 会话级后续消息队列（JSON 快照；steer/queue 两类条目） */
  queue: (sessionId: string) => `zakura:cloud:queue:${sessionId}`,
  /** 立即发送：取消收尾后优先开跑的下一条（从队列摘出） */
  queueNext: (sessionId: string) => `zakura:cloud:queue-next:${sessionId}`,
  /** Run 取消广播频道（全局单频道，跨实例即时掐流） */
  cancelChannel: "zakura:cloud:cancel",
  /** 平台事件跨实例 fan-out（按租户） */
  platformChannel: (tenantId: string) => `zakura:platform:evt:${tenantId}`,
  /** 平台事件跨实例 fan-out（host 级广播，所有租户可见） */
  platformChannelAll: "zakura:platform:evt:all",
  /** API Key 鉴权缓存 */
  auth: (keyHash: string) => `zakura:auth:key:${keyHash}`,
  /** Agent 工具列表短缓存 */
  tools: (agentId: string) => `zakura:tools:agent:${agentId}`,
  /** 单实例 MCP tools/list 预缓存（启动时写入，热路径只读） */
  instanceTools: (instanceId: string) => `zakura:tools:instance:${instanceId}`,
  /** Gateway clientSessionKey → sessionId */
  gwClient: (agentId: string, clientKey: string) =>
    `zakura:gw:client:${agentId}:${encodeURIComponent(clientKey)}`,
  /** 危机支持邮件冷却（按用户邮箱，24h） */
  crisisSupport: (userKey: string) =>
    `zakura:email:crisis-support:${encodeURIComponent(userKey)}`,
} as const;
