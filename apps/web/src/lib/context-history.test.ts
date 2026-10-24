import assert from "node:assert/strict";
import test from "node:test";
import type { CloudAgentEvent } from "@zakura/shared";
import { buildContextWindowInfo, latestCompaction } from "../components/chat/chat-helpers";
import { buildConversationTurns } from "./cloud-agent";

function event(type: CloudAgentEvent["type"], seq: number, payload: Record<string, unknown>, runId: string | null = "run"): CloudAgentEvent {
  return { id: `event-${seq}`, sessionId: "session", runId, seq, type, payload, createdAt: "2026-10-24T00:00:00Z" } as CloudAgentEvent;
}

test("failed compaction preserves measured context and successful checkpoint", () => {
  const events = [
    event("context_compacted", 1, { compacted: true, beforeTokens: 12000, afterTokens: 3000, summary: "checkpoint" }),
    event("run_log", 2, { data: { promptTokens: 4200 } }),
    event("context_compacted", 3, { compacted: false, failed: true, beforeTokens: 4200, afterTokens: 4200 }),
  ];
  const info = buildContextWindowInfo(events, undefined);
  assert.equal(latestCompaction(events)?.seq, 1);
  assert.equal(info.usedTokens, 4200);
  assert.equal(info.summaryCount, 1);
  assert.equal(info.lastSavedTokens, 9000);
  assert.equal(info.source, "measured");
});

test("checkpoint includes retained tail and supersedes old measured input", () => {
  const events = [
    event("run_log", 1, { data: { promptTokens: 50000 } }),
    event("context_compacted", 2, { compacted: true, beforeTokens: 50000, afterTokens: 8000, summary: "short summary" }),
  ];
  assert.equal(buildContextWindowInfo(events, undefined).usedTokens, 8000);
  assert.notEqual(buildContextWindowInfo(events, undefined).source, "measured");
  events.push(event("user_message", 3, { content: "new request" }));
  assert.ok(buildContextWindowInfo(events, undefined).usedTokens > 8000);
});

test("manual compaction belongs to its selected run variant", () => {
  const events = [
    event("user_message", 1, { messageId: "user", content: "work", parentRunId: null }),
    event("run_start", 2, { replyToMessageId: "user" }),
    event("assistant_message", 3, { content: "first answer" }),
    event("run_start", 4, { replyToMessageId: "user" }, "variant"),
    event("assistant_message", 5, { content: "second answer" }, "variant"),
    event("context_compacting", 6, { anchorRunId: "run", source: "manual" }, null),
    event("context_compacted", 7, { anchorRunId: "run", compacted: true, summary: "first checkpoint", source: "manual" }, null),
  ];
  const selected = buildConversationTurns(events, { variantByMessage: { user: "run" } });
  assert.equal(selected[0]?.items.filter((item) => item.kind === "compaction").length, 1);
  assert.equal(buildConversationTurns(events)[0]?.items.filter((item) => item.kind === "compaction").length, 0);
});
