/**
 * 实例 tools 预缓存：热路径只读，不现场 tools/list
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { REDIS_KEYS } from "../src/services/redis.js";
import { REDIS_TTL } from "../src/services/redis-store.js";

describe("MCP instance tools pre-cache", () => {
  it("has dedicated redis key + long TTL for instance tools", () => {
    const key = REDIS_KEYS.instanceTools("inst-1");
    assert.equal(key, "zakura:tools:instance:inst-1");
    assert.ok(REDIS_TTL.instanceTools >= 3600);
    assert.ok(REDIS_TTL.instanceTools > REDIS_TTL.tools);
  });
});
