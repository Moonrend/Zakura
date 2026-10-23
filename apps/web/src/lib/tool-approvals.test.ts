import assert from "node:assert/strict";
import test from "node:test";
import type { CloudAgentEvent } from "@zakura/shared";
import { pendingToolApprovals } from "./tool-approvals";

function event(type: CloudAgentEvent["type"], seq: number, payload: Record<string, unknown>, runId: string | null = "run"): CloudAgentEvent {
  return { id: `event-${seq}`, sessionId: "session", runId, seq, type, payload, createdAt: "2026-10-23T00:00:00Z" } as CloudAgentEvent;
}

const request = (id: string, seq = 1, extra = {}) => event("tool_approval_request", seq, { requestId: id, toolName: "shell_exec", argumentsJson: "{}", ...extra });

test("floating approvals show only unresolved requests and ignore replayed requests", () => {
  for (const decision of ["approved", "denied", "timeout", "cancelled"]) {
    const events = [request("one"), event("tool_approval_resolved", 2, { requestId: "one", decision }), request("one", 3), request("two", 4)];
    assert.deepEqual(pendingToolApprovals(events).map(item => item.requestId), ["two"]);
  }
});

test("automatic Jev decisions never appear while their resolution event is in transit", () => {
  for (const reason of ["ai_decision", "ai_auto"]) {
    assert.deepEqual(pendingToolApprovals([request("auto", 1, { reason, ai: { decision: "allow", confidence: 0.95 } })]), []);
  }
  assert.equal(pendingToolApprovals([request("review", 1, { reason: "ai_low_confidence", ai: { decision: "allow", confidence: 0.6 } })]).length, 1);
});

test("expired and finished-run requests do not reopen, runless ACP requests remain available", () => {
  const now = Date.parse("2026-10-23T00:00:00Z");
  assert.deepEqual(pendingToolApprovals([request("expired", 1, { expiresAt: "2026-10-22T23:59:59Z" })], now), []);
  assert.equal(pendingToolApprovals([request("future", 1, { expiresAt: "2026-10-23T00:01:00Z" })], now).length, 1);
  assert.deepEqual(pendingToolApprovals([request("done"), event("run_end", 2, {})]), []);
  assert.equal(pendingToolApprovals([event("tool_approval_request", 1, { requestId: "callback", toolName: "fs/read_text_file" }, null), event("run_end", 2, {})]).length, 1);
});

test("parallel pending requests preserve order and duplicate events do not duplicate cards", () => {
  assert.deepEqual(pendingToolApprovals([request("one"), request("one", 2), request("two", 3)]).map(item => item.requestId), ["one", "two"]);
});
