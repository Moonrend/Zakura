/**
 * Redis key helpers（Memoh 风格热数据前缀）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { REDIS_KEYS, isRedisEnabled, redisUrlFromEnv } from "../src/services/redis.js";
import { EVENT_RING_MAX, REDIS_TTL } from "../src/services/redis-store.js";

describe("redis helpers", () => {
  it("builds stable key namespaces", () => {
    assert.equal(REDIS_KEYS.seq("s1"), "zakura:cloud:seq:s1");
    assert.equal(REDIS_KEYS.pending("s1"), "zakura:cloud:pending:s1");
    assert.equal(REDIS_KEYS.channel("s1"), "zakura:cloud:evt:s1");
    assert.equal(REDIS_KEYS.events("s1"), "zakura:cloud:events:s1");
    assert.equal(REDIS_KEYS.meta("s1"), "zakura:cloud:meta:s1");
    assert.equal(REDIS_KEYS.run("r1"), "zakura:cloud:run:r1");
    assert.equal(REDIS_KEYS.auth("abc"), "zakura:auth:key:abc");
    assert.equal(REDIS_KEYS.tools("a1"), "zakura:tools:agent:a1");
    assert.match(REDIS_KEYS.gwClient("a1", "ck"), /^zakura:gw:client:a1:/);
  });

  it("keeps Memoh-like TTLs", () => {
    assert.equal(REDIS_TTL.tools, 300);
    assert.equal(REDIS_TTL.auth, 30);
    assert.ok(REDIS_TTL.session >= 3600);
    assert.equal(EVENT_RING_MAX, 500);
  });

  it("defaults to localhost when REDIS_URL unset", () => {
    const prev = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    assert.equal(redisUrlFromEnv(), "redis://127.0.0.1:6379");
    assert.equal(isRedisEnabled(), true);
    process.env.REDIS_URL = "  ";
    assert.equal(redisUrlFromEnv(), "redis://127.0.0.1:6379");
    if (prev === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prev;
  });

  it("respects explicit REDIS_URL and off", () => {
    const prev = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://:secret@redis:6379/1";
    assert.equal(redisUrlFromEnv(), "redis://:secret@redis:6379/1");
    process.env.REDIS_URL = "off";
    assert.equal(redisUrlFromEnv(), null);
    assert.equal(isRedisEnabled(), false);
    if (prev === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prev;
  });
});
