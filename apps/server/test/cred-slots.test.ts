import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mergeSlots,
  normalizeSlots,
  pickSlotRoundRobin,
  redactSlot,
} from "../src/capabilities/cred-slots.js";

describe("cred slots", () => {
  it("normalizes legacy single-config into a slot", () => {
    const slots = normalizeSlots({
      enabled: true,
      apiKey: "sk-test",
      baseUrl: "https://example.com",
    });
    assert.equal(slots.length, 1);
    assert.equal(slots[0]!.apiKey, "sk-test");
    assert.equal(slots[0]!.baseUrl, "https://example.com");
  });

  it("round-robins across slots with scoped counter", () => {
    const slots = [
      { id: "a", apiKey: "1" },
      { id: "b", apiKey: "2" },
      { id: "c", apiKey: "3" },
    ];
    const scope = `test-rr-${Date.now()}`;
    assert.equal(pickSlotRoundRobin(scope, slots)?.id, "a");
    assert.equal(pickSlotRoundRobin(scope, slots)?.id, "b");
    assert.equal(pickSlotRoundRobin(scope, slots)?.id, "c");
    assert.equal(pickSlotRoundRobin(scope, slots)?.id, "a");
  });

  it("redacts api keys", () => {
    const pub = redactSlot({ id: "x", apiKey: "secret", baseUrl: "http://x" });
    assert.equal(pub.hasApiKey, true);
    assert.equal(pub.baseUrl, "http://x");
    assert.ok(!("apiKey" in pub));
  });

  it("merge keeps previous secret when incoming is empty", () => {
    const merged = mergeSlots(
      [{ id: "a", apiKey: "", baseUrl: "https://new" }],
      [{ id: "a", apiKey: "keep-me", baseUrl: "https://old" }],
    );
    assert.equal(merged[0]!.apiKey, "keep-me");
    assert.equal(merged[0]!.baseUrl, "https://new");
  });

  it("merge replaces secret when provided", () => {
    const merged = mergeSlots(
      [{ id: "a", apiKey: "new-key" }],
      [{ id: "a", apiKey: "old-key" }],
    );
    assert.equal(merged[0]!.apiKey, "new-key");
  });
});
