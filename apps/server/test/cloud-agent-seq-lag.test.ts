/**
 * Redis seq 只升不降：落后于 Postgres 时靠抬升，不能用 SET NX。
 * 本机无 Redis 则跳过。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "redis";

const REDIS_URL = process.env.REDIS_URL?.trim() || "redis://127.0.0.1:6379";

const RAISE_FLOOR = `local cur = tonumber(redis.call('GET', KEYS[1]) or '-1')
local floor = tonumber(ARGV[1])
if cur < floor then redis.call('SET', KEYS[1], floor) end
return 0`;

describe("redis seq floor raise", () => {
  it("raises when behind and never lowers", async (t) => {
    if (REDIS_URL === "off" || REDIS_URL === "0" || REDIS_URL === "false") {
      t.skip("REDIS_URL=off");
      return;
    }
    const redis = createClient({ url: REDIS_URL });
    try {
      await redis.connect();
    } catch {
      t.skip("Redis unavailable");
      return;
    }
    const key = `zakura:test:seq-floor:${Date.now()}`;
    try {
      await redis.set(key, "2");
      await redis.eval(RAISE_FLOOR, { keys: [key], arguments: ["10"] });
      assert.equal(await redis.get(key), "10");
      await redis.eval(RAISE_FLOOR, { keys: [key], arguments: ["5"] });
      assert.equal(await redis.get(key), "10");
      assert.equal(await redis.incr(key), 11);
    } finally {
      await redis.del(key);
      await redis.quit();
    }
  });
});
