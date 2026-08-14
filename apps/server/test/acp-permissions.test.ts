import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACP_BOUND_IDLE_MS,
  settleAll,
  shouldReapAcpRuntime,
  type PendingDecision,
} from "../src/services/acp/permissions.js";

describe("ACP permission cancel + idle reap", () => {
  it("resolves every pending request with the cancelled outcome", async () => {
    const map = new Map<string, PendingDecision<{ outcome: { outcome: string } }>>();
    const seen: string[] = [];
    map.set("p1", {
      resolve: (v) => seen.push(`p1:${v.outcome.outcome}`),
      reject: () => undefined,
    });
    map.set("p2", {
      resolve: (v) => seen.push(`p2:${v.outcome.outcome}`),
      reject: () => undefined,
    });
    const ids = settleAll(map, { outcome: { outcome: "cancelled" } });
    assert.deepEqual(ids.sort(), ["p1", "p2"]);
    assert.equal(map.size, 0);
    assert.deepEqual(seen.sort(), ["p1:cancelled", "p2:cancelled"]);
  });

  it("reaps idle bound runtimes but not an active prompt", () => {
    const now = 1_000_000;
    assert.equal(
      shouldReapAcpRuntime({ lastUsedAt: now - ACP_BOUND_IDLE_MS, runId: "r" }, now),
      false,
    );
    assert.equal(
      shouldReapAcpRuntime({ lastUsedAt: now - ACP_BOUND_IDLE_MS }, now),
      true,
    );
    assert.equal(
      shouldReapAcpRuntime({ lastUsedAt: now - 1000 }, now),
      false,
    );
  });
});
