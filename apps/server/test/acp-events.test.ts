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

describe("ACP 1.3 content blocks", () => {
  it("renders image blocks as data URI instead of dropping them", async () => {
    const { store, events } = fakeStore();
    await appendAcpUpdate(
      store,
      "s",
      "r",
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "AAAA", mimeType: "image/png", title: "shot" },
      },
      ids,
    );
    const deltas = events.filter((e) => e.type === "assistant_delta");
    assert.equal(deltas.length, 1);
    const delta = (deltas[0].payload as { delta: string }).delta;
    assert.match(delta, /^!\[shot\]\(data:image\/png;base64,AAAA\)$/);
  });

  it("renders resource_link as a markdown link", async () => {
    const { store, events } = fakeStore();
    await appendAcpUpdate(
      store,
      "s",
      "r",
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "resource_link", uri: "file:///a.ts", name: "a.ts" },
      },
      ids,
    );
    const delta = (events.find((e) => e.type === "assistant_delta")!.payload as { delta: string })
      .delta;
    assert.equal(delta, "[a.ts](file:///a.ts)");
  });

  it("renders embedded text resource as a fenced block", async () => {
    const { store, events } = fakeStore();
    await appendAcpUpdate(
      store,
      "s",
      "r",
      {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "resource",
          resource: { uri: "file:///a.json", mimeType: "application/json", text: "{}" },
        },
      },
      ids,
    );
    const delta = (events.find((e) => e.type === "assistant_delta")!.payload as { delta: string })
      .delta;
    assert.match(delta, /```json\n\{\}\n```/);
  });

  it("joins array content blocks", async () => {
    const { store, events } = fakeStore();
    await appendAcpUpdate(
      store,
      "s",
      "r",
      {
        sessionUpdate: "agent_message_chunk",
        content: [
          { type: "text", text: "see " },
          { type: "resource_link", uri: "file:///b.ts", name: "b.ts" },
        ],
      },
      ids,
    );
    const delta = (events.find((e) => e.type === "assistant_delta")!.payload as { delta: string })
      .delta;
    assert.equal(delta, "see [b.ts](file:///b.ts)");
  });
});

describe("ACP 1.3 previously-dropped updates", () => {
  it("handles non-streaming agent_message and agent_thought", async () => {
    const { store, events } = fakeStore();
    const a = await appendAcpUpdate(
      store,
      "s",
      "r",
      { sessionUpdate: "agent_message", content: { type: "text", text: "whole" } },
      ids,
    );
    const t = await appendAcpUpdate(
      store,
      "s",
      "r",
      { sessionUpdate: "agent_thought", content: { type: "text", text: "pondering" } },
      ids,
    );
    assert.equal(a.runStatus, "streaming");
    assert.equal(t.runStatus, "thinking");
    assert.equal(
      (events.find((e) => e.type === "assistant_delta")!.payload as { delta: string }).delta,
      "whole",
    );
    assert.equal(
      (events.find((e) => e.type === "reasoning_delta")!.payload as { delta: string }).delta,
      "pondering",
    );
  });

  it("streams tool_call_content_chunk into tool progress", async () => {
    const { store, events } = fakeStore();
    const res = await appendAcpUpdate(
      store,
      "s",
      "r",
      {
        sessionUpdate: "tool_call_content_chunk",
        toolCallId: "tc9",
        content: { type: "text", text: "partial" },
      },
      ids,
    );
    assert.equal(res.runStatus, "tool");
    const ev = events.find((e) => e.type === "tool_call_progress");
    assert.ok(ev);
    assert.deepEqual(ev.payload, { toolCallId: "tc9", message: "partial" });
  });

  it("surfaces terminal output instead of discarding it", async () => {
    const { store, events } = fakeStore();
    const res = await appendAcpUpdate(
      store,
      "s",
      "r",
      { sessionUpdate: "terminal_output_chunk", terminalId: "t7", output: "$ ls\n" },
      ids,
    );
    assert.equal(res.runStatus, "tool");
    const ev = events.find((e) => e.type === "run_log");
    assert.ok(ev);
    const payload = ev.payload as { message: string; data?: { terminalId?: string } };
    assert.equal(payload.message, "$ ls\n");
    assert.equal(payload.data?.terminalId, "t7");
  });

  it("records echoed user messages without polluting assistant bubbles", async () => {
    const { store, events } = fakeStore();
    await appendAcpUpdate(
      store,
      "s",
      "r",
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echo" } },
      ids,
    );
    assert.equal(events.filter((e) => e.type === "assistant_delta").length, 0);
    assert.equal(events.filter((e) => e.type === "run_log").length, 1);
  });

  it("clears the plan on plan_removed", async () => {
    const { store, events } = fakeStore();
    await appendAcpUpdate(store, "s", "r", { sessionUpdate: "plan_removed" }, ids);
    const ev = events.find((e) => e.type === "acp_plan");
    assert.ok(ev);
    assert.deepEqual(ev.payload, { entries: [] });
  });

  it("applies mode and config from state_update", async () => {
    const { store, events } = fakeStore();
    const mode = await appendAcpUpdate(
      store,
      "s",
      "r",
      { sessionUpdate: "state_update", currentModeId: "plan" },
      ids,
    );
    assert.equal(mode.modeId, "plan");
    assert.ok(events.some((e) => e.type === "session_update"));
    const cfg = await appendAcpUpdate(
      store,
      "s",
      "r",
      { sessionUpdate: "state_update", configOptions: [{ id: "x" }] },
      ids,
    );
    assert.deepEqual(cfg.configOptions, [{ id: "x" }]);
  });
});
