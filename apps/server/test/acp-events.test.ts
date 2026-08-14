import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendAcpUpdate, extractAcpDiffs } from "../src/services/acp/events.js";
import type { CloudAgentSessionStore } from "../src/services/cloud-agent-session.js";

function fakeStore() {
  const events: Array<{ type: string; payload: unknown }> = [];
  const store = {
    appendEvent: async (input: { type: string; payload: unknown }) => {
      events.push({ type: input.type, payload: input.payload });
      return input;
    },
  } as unknown as CloudAgentSessionStore;
  return { store, events };
}

const ids = { assistantMessageId: "a1", thoughtMessageId: "t1" };

describe("ACP event mapping", () => {
  it("maps text chunks, thoughts, tools, and plan", async () => {
    const { store, events } = fakeStore();
    await appendAcpUpdate(
      store,
      "s",
      "r",
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      ids,
    );
    await appendAcpUpdate(
      store,
      "s",
      "r",
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think" } },
      ids,
    );
    await appendAcpUpdate(
      store,
      "s",
      "r",
      { sessionUpdate: "tool_call", toolCallId: "tc1", kind: "read", title: "Read", rawInput: { path: "a.ts" } },
      ids,
    );
    await appendAcpUpdate(
      store,
      "s",
      "r",
      { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed", rawOutput: "ok" },
      ids,
    );
    await appendAcpUpdate(
      store,
      "s",
      "r",
      { sessionUpdate: "plan", entries: [{ content: "step", status: "pending" }] },
      ids,
    );
    assert.deepEqual(
      events.map((e) => e.type),
      [
        "assistant_delta",
        "reasoning_delta",
        "tool_call_start",
        "tool_call_args",
        "tool_call_result",
        "acp_plan",
      ],
    );
    const start = events.find((e) => e.type === "tool_call_start")!.payload as {
      name?: string;
      title?: string;
    };
    assert.equal(start.name, "fs_read");
    assert.equal(start.title, "Read");
    const args = events.find((e) => e.type === "tool_call_args")!.payload as { arguments?: string };
    assert.match(args.arguments ?? "", /a\.ts/);
  });

  it("maps kind=other to title instead of other", async () => {
    const { store, events } = fakeStore();
    await appendAcpUpdate(
      store,
      "s",
      "r",
      {
        sessionUpdate: "tool_call",
        toolCallId: "g1",
        kind: "other",
        title: "Read src/app.ts",
        name: "read_file",
        rawInput: { file_path: "src/app.ts" },
      },
      ids,
    );
    const start = events[0]!.payload as { name?: string; title?: string };
    assert.equal(start.name, "read_file");
    assert.equal(start.title, "Read src/app.ts");
    const args = events[1]!.payload as { arguments?: string };
    assert.match(args.arguments ?? "", /"path":"src\/app.ts"/);
  });

  it("uses title when kind is other and no programmatic name", async () => {
    const { store, events } = fakeStore();
    await appendAcpUpdate(
      store,
      "s",
      "r",
      { sessionUpdate: "tool_call", toolCallId: "g2", kind: "other", title: "GoogleSearch" },
      ids,
    );
    assert.equal((events[0]!.payload as { name?: string }).name, "GoogleSearch");
  });

  it("maps usage, commands, and mode updates", async () => {
    const { store, events } = fakeStore();
    const usage = await appendAcpUpdate(
      store,
      "s",
      "r",
      { sessionUpdate: "usage_update", used: { inputTokens: 10, outputTokens: 2 } },
      ids,
    );
    assert.deepEqual(usage, {});
    const cmds = await appendAcpUpdate(
      store,
      "s",
      "r",
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "review", description: "Review diff" }],
      },
      ids,
    );
    assert.equal(cmds.commands?.[0]?.name, "review");
    const mode = await appendAcpUpdate(
      store,
      "s",
      "r",
      { sessionUpdate: "current_mode_update", currentModeId: "default" },
      ids,
    );
    assert.equal(mode.modeId, "default");
    assert.equal(events[0]?.type, "run_log");
    assert.equal((events[0]?.payload as { data?: { cost?: { inputTokens?: number } } }).data?.cost?.inputTokens, 10);
    assert.equal(events[1]?.type, "session_update");
    assert.equal(events[2]?.type, "session_update");
  });

  it("puts ACP diffs on tool_call_result", async () => {
    const { store, events } = fakeStore();
    assert.deepEqual(
      extractAcpDiffs([
        { type: "diff", path: "/workspace/a.ts", oldText: "a", newText: "b" },
        { type: "text", text: "ignore" },
      ]),
      [{ path: "/workspace/a.ts", oldText: "a", newText: "b" }],
    );
    await appendAcpUpdate(
      store,
      "s",
      "r",
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-diff",
        status: "completed",
        contentBlocks: [{ type: "diff", path: "/workspace/a.ts", newText: "export {}\n" }],
      },
      ids,
    );
    const result = events.find((e) => e.type === "tool_call_result");
    assert.ok(result);
    const payload = result!.payload as { diffs?: Array<{ path: string; newText: string }> };
    assert.equal(payload.diffs?.[0]?.path, "/workspace/a.ts");
    assert.match(payload.diffs?.[0]?.newText ?? "", /export/);
  });

  it("pins assistant deltas to the live message id", async () => {
    const { store, events } = fakeStore();
    await appendAcpUpdate(
      store,
      "s",
      "r",
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "agent-own-id",
        content: { type: "text", text: "hi" },
      },
      ids,
    );
    assert.equal((events[0]!.payload as { messageId?: string }).messageId, "a1");
  });

  it("returns config options from config_option_update", async () => {
    const { store, events } = fakeStore();
    const side = await appendAcpUpdate(
      store,
      "s",
      "r",
      {
        sessionUpdate: "config_option_update",
        configOptions: [{ type: "select", id: "model", currentValue: "m1", options: [] }],
      },
      ids,
    );
    assert.ok(Array.isArray(side.configOptions));
    assert.equal(events.length, 0);
  });
});
