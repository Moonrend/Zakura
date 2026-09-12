import { REDIS_KEYS } from "../redis.js";
import { getRedis } from "../redis.js";

const FAIL_LIMIT = 8;
const WINDOW_SEC = 15 * 60;
const memory = new Map<string, { count: number; resetAt: number }>();

function key(email: string, ip: string | null): string {
  return `${email.trim().toLowerCase()}|${ip ?? "unknown"}`;
}

export async function loginThrottleHit(email: string, ip: string | null): Promise<{ blocked: boolean; remaining: number }> {
  const id = key(email, ip);
  const redis = await getRedis().catch(() => null);
  if (redis) {
    const redisKey = REDIS_KEYS.loginFail(id);
    const count = await redis.incr(redisKey);
    if (count === 1) await redis.expire(redisKey, WINDOW_SEC);
    return { blocked: count > FAIL_LIMIT, remaining: Math.max(0, FAIL_LIMIT - count) };
  }
  const now = Date.now();
  const cur = memory.get(id);
  if (!cur || cur.resetAt < now) {
    memory.set(id, { count: 1, resetAt: now + WINDOW_SEC * 1000 });
    return { blocked: false, remaining: FAIL_LIMIT - 1 };
  }
  cur.count += 1;
  return { blocked: cur.count > FAIL_LIMIT, remaining: Math.max(0, FAIL_LIMIT - cur.count) };
}

export async function loginThrottleClear(email: string, ip: string | null): Promise<void> {
  const id = key(email, ip);
  const redis = await getRedis().catch(() => null);
  if (redis) {
    await redis.del(REDIS_KEYS.loginFail(id));
    return;
  }
  memory.delete(id);
}
