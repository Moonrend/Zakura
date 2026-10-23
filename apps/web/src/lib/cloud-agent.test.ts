import assert from "node:assert/strict";
import test from "node:test";
import type { CloudAgentEvent } from "@zakura/shared";
import { buildConversationTurns, buildGatewayConversationTurns, eventsToTimeline, resolveToolApproval, listCloudSessions, getCloudSession } from "./cloud-agent";

function event(type: CloudAgentEvent["type"], seq: number, payload: Record<string, unknown>): CloudAgentEvent {
  return { id: `event-${seq}`, sessionId: "session", runId: "run", seq, type, payload, createdAt: "2026-10-18T00:00:00Z" } as CloudAgentEvent;
}

test("bot replies and message wrappers replay separately without duplicate answers", () => {
  const events = [
    event("user_message", 1, { messageId: "user", content: "Hello", context: { prefix: "Sender: Ada", suffix: "Reply in bot" } }),
    event("run_start", 2, { replyToMessageId: "user" }),
    event("assistant_delta", 3, { messageId: "answer", delta: "Hi" }),
    event("assistant_message", 4, { messageId: "answer", content: "Hi" }),
    event("bot_message", 5, { messageId: "sent", sourceMessageId: "answer", content: "Hi", platform: "zakurabot", botName: "Scout" }),
  ];
  const turn = buildConversationTurns(events)[0]!;
  assert.equal(turn.message.content, "Hello");
  const user = turn.items.find(item => item.kind === "user");
  assert.deepEqual(user?.context, { prefix: "Sender: Ada", suffix: "Reply in bot" });
  assert.equal(turn.items.filter(item => item.kind === "assistant").length, 0);
  assert.equal(turn.items.filter(item => item.kind === "bot").length, 1);
  assert.equal(turn.items.find(item => item.kind === "bot")?.content, "Hi");
  const legacy = eventsToTimeline([event("user_message", 1, { content: "Plain text" })]);
  assert.equal(legacy[0]?.kind, "user");
  if (legacy[0]?.kind === "user") assert.equal(legacy[0].context, undefined);
});

test("delivered bot tools collapse into their message while failed sends stay visible", () => {
  const items = eventsToTimeline([
    event("tool_call_start", 1, { toolCallId: "sent", name: "chat_reply" }),
    event("bot_message", 2, { messageId: "bot", toolCallId: "sent", content: "Hello", platform: "zakurabot" }),
    event("tool_call_result", 3, { toolCallId: "sent", result: { sent: true } }),
    event("tool_call_start", 4, { toolCallId: "failed", name: "chat_reply" }),
    event("tool_call_result", 5, { toolCallId: "failed", isError: true, result: "Connection unavailable" }),
  ]);
  assert.equal(items.filter(item => item.kind === "bot").length, 1);
  assert.equal(items.filter(item => item.kind === "tool").length, 1);
  assert.equal(items.find(item => item.kind === "tool")?.id, "failed");
});

test("standard and ACP unified approvals replay through the same card", () => {
  for (const toolName of ["re_shell_exec", "acp:edit"]) {
    const items = eventsToTimeline([
      event("tool_approval_request", 1, { requestId: "request", toolCallId: "tool", toolName, argumentsJson: '{"command":"git status"}', reason: "policy_ask" }),
      event("tool_approval_resolved", 2, { requestId: "request", decision: "approved", decidedBy: "user" }),
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "tool_approval");
    if (items[0]?.kind !== "tool_approval") return;
    assert.equal(items[0].argumentsJson, '{"command":"git status"}');
    assert.equal(items[0].resolved?.decision, "approved");
  }
});

test("legacy permission events remain readable but do not duplicate unified cards", () => {
  for (const reverse of [false, true]) {
    const legacy = event("permission_request", reverse ? 2 : 1, { requestId: "request", title: "Edit", options: [] });
    const unified = event("tool_approval_request", reverse ? 1 : 2, { requestId: "request", toolName: "edit", argumentsJson: "{}" });
    const items = eventsToTimeline(reverse ? [unified, legacy] : [legacy, unified]);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "tool_approval");
  }
  const history = eventsToTimeline([event("permission_request", 1, { requestId: "old", options: [{ optionId: "once", kind: "allow_once", name: "允许" }] }), event("permission_resolved", 2, { requestId: "old", outcome: "selected", optionId: "once" })]);
  assert.equal(history[0]?.kind, "permission");
});

test("replayed approval requests do not reopen resolved cards", () => {
  const items = eventsToTimeline([
    event("tool_approval_request", 1, { requestId: "request", toolName: "edit" }),
    event("tool_approval_resolved", 2, { requestId: "request", decision: "denied" }),
    event("tool_approval_request", 3, { requestId: "request", toolName: "edit" }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "tool_approval");
  if (items[0]?.kind === "tool_approval") assert.equal(items[0].resolved?.decision, "denied");
});

test("generated UI state replays by message, revision, block and selected run", () => {
  const snapshot = (quantity: number, revision: number, blockIndex = 0) => ({ messageId: "ui-a", blockIndex, catalogVersion: 1, contentHash: "hash", revision, state: { quantity } });
  const events = [
    event("user_message", 1, { messageId: "user", content: "calculator", parentRunId: null }),
    event("run_start", 2, { replyToMessageId: "user" }),
    event("assistant_message", 3, { messageId: "ui-a", content: "calculator A" }),
    { ...event("run_start", 4, { replyToMessageId: "user" }), runId: "variant" },
    { ...event("assistant_message", 5, { messageId: "ui-b", content: "calculator B" }), runId: "variant" },
    event("ui_state_updated", 6, snapshot(5, 2)),
    event("ui_state_updated", 7, snapshot(2, 1)),
    event("ui_state_updated", 8, snapshot(9, 1, 1)),
  ];
  const latest = buildConversationTurns(events)[0]!;
  assert.equal(latest.activeRunId, "variant");
  assert.equal(latest.items.find(item => item.kind === "assistant")?.uiStates, undefined);
  const selected = buildConversationTurns(events, { variantByMessage: { user: "run" } })[0]!;
  const ui = selected.items.find(item => item.kind === "assistant");
  assert.equal(ui?.kind, "assistant");
  if (ui?.kind !== "assistant") return;
  assert.equal(ui.uiStates?.[0]?.state.quantity, 5);
  assert.equal(ui.uiStates?.[1]?.state.quantity, 9);
  assert.equal(buildConversationTurns(events).length, 1);
  assert.equal(eventsToTimeline([...events, event("assistant_rollback", 9, { messageId: "ui-a" })]).filter(item => item.kind === "assistant" && item.id === "ui-a").length, 0);
});

test("forked UI state remains attached to its assistant without a run", () => {
  const events = [
    { ...event("user_message", 1, { messageId: "user", content: "calculator" }), runId: null },
    { ...event("assistant_message", 2, { messageId: "ui", content: "calculator" }), runId: null },
    { ...event("ui_state_updated", 3, { messageId: "ui", blockIndex: 0, catalogVersion: 1, contentHash: "hash", revision: 1, state: { quantity: 7 } }), runId: null },
  ];
  const turns = buildConversationTurns(events);
  assert.equal(turns.length, 1);
  const ui = turns[0]!.items.find(item => item.kind === "assistant");
  if (ui?.kind !== "assistant") throw new Error("UI missing");
  assert.equal(ui.uiStates?.[0]?.state.quantity, 7);
});

test("Gateway loops preserve every response, tool result and context across requests", () => {
  const turns = buildGatewayConversationTurns([
    event("context_sources", 1, { items: [{ kind: "other", title: "Instructions", content: "rules" }] }),
    event("user_message", 2, { messageId: "u1", content: "fix" }),
    event("run_start", 3, { replyToMessageId: "u1" }),
    event("assistant_delta", 4, { messageId: "a1", delta: "Checking" }),
    event("assistant_message", 5, { messageId: "a1", content: "Checking" }),
    event("tool_call_start", 6, { toolCallId: "call", name: "Read", arguments: "{}" }),
    event("run_end", 7, { status: "completed" }),
    { ...event("tool_call_result", 8, { toolCallId: "call", resultText: "found" }), runId: "next" },
    { ...event("assistant_message", 9, { messageId: "a2", content: "Fixed" }), runId: "next" },
    event("context_compacted", 10, { summary: "Tests fixed" }),
    event("user_message", 11, { messageId: "u2", content: "continue" }),
  ]);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0]!.items.filter(item => item.kind === "assistant").map(item => item.content), ["Checking", "Fixed"]);
  const tool = turns[0]!.items.find(item => item.kind === "tool");
  assert.equal(tool?.call.resultText, "found");
  assert.equal(tool?.call.status, "done");
  assert.ok(turns[0]!.items.some(item => item.kind === "sources"));
  assert.ok(turns[0]!.items.some(item => item.kind === "compaction"));
});

test("Gateway final snapshots replace text flushed by a tool start", () => {
  const turns = buildGatewayConversationTurns([
    event("user_message", 1, { messageId: "u", content: "inspect" }),
    event("run_start", 2, { replyToMessageId: "u" }),
    event("assistant_delta", 3, { messageId: "a", delta: "Checking" }),
    event("tool_call_start", 4, { toolCallId: "call", name: "Read", arguments: '{"path":"file"}' }),
    event("assistant_message", 5, { messageId: "a", content: "Checking" }),
    event("run_end", 6, { status: "completed" }),
  ]);
  assert.equal(turns[0]?.items.filter(item => item.kind === "assistant").length, 1);
  assert.deepEqual(turns[0]?.items.map(item => item.kind), ["user", "assistant", "tool"]);
  assert.equal(turns[0]?.items.find(item => item.kind === "tool")?.call.arguments, '{"path":"file"}');
});

test("Gateway live responses retain their active run", () => {
  const events = [
    event("user_message", 1, { messageId: "user", content: "hello" }),
    event("run_start", 2, { replyToMessageId: "user" }),
    event("assistant_delta", 3, { messageId: "response", delta: "Live" }),
  ];
  assert.equal(buildGatewayConversationTurns(events)[0]?.activeRunId, "run");
  assert.equal(buildGatewayConversationTurns([...events, event("run_end", 4, { status: "completed" })])[0]?.activeRunId, null);
});

test("Gateway tail pages keep responses without a user anchor", () => {
  const response = event("assistant_message", 501, { messageId: "answer", content: "tail response" });
  const tail = buildGatewayConversationTurns([response]);
  assert.equal(tail.length, 1);
  assert.equal(tail[0]?.message.continue, true);
  assert.equal(tail[0]?.items[0]?.kind, "assistant");
  const withNext = buildGatewayConversationTurns([response, event("user_message", 502, { messageId: "next", content: "next turn" })]);
  assert.equal(withNext.length, 2);
  assert.equal(withNext[1]?.items.length, 1);
  const continuation = buildGatewayConversationTurns([event("user_message", 1, { messageId: "anchor", content: "客户端继续会话", continue: true }), response]);
  assert.equal(continuation[0]?.message.continue, true);
});

test("Gateway sessions use Space endpoints", async (t) => {
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown) => { paths.push(String(input)); return Response.json({ sessions: [], events: [] }); });
  await listCloudSessions("gateway:space", { limit: 200 });
  await getCloudSession("gateway:space", "session");
  assert.deepEqual(paths, ["/api/spaces/space/gateway/sessions?limit=200", "/api/spaces/space/gateway/sessions/session?afterSeq=0"]);
});

test("one-time decisions use the standard durable approval endpoint", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    assert.equal(String(input), "/api/agents/agent/sessions/session/approvals");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), { requestId: "request", decision: "approved", alwaysAllow: false });
    return Response.json({ ok: true });
  });
  await resolveToolApproval("agent", "session", { requestId: "request", decision: "approved", alwaysAllow: false });
});
