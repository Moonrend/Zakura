import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildChainMessages,
  buildCompactionDigest,
  buildCompactionSystemPrompt,
  buildSessionReuseDigest,
  buildUserMessage,
  CloudAgentRuntime,
  compactToolResultsInPlace,
  eventsToMessages,
  extractFailureSignals,
  extractFileOpsFromMessages,
  formatHistorySummaryForPrompt,
  isContextOverflowError,
  mergeFileOps,
  parseAttachments,
  parseFileOpsFromSummary,
  parseMemoryExtraction,
  prepareHistoryForModel,
  resolveCompactBudgetForContextWindow,
  splitMessagesForCompaction,
} from "../src/services/cloud-agent-runtime.js";
import {
  applyTokenCalibration,
  estimateTextTokens,
  estimateMessagesTokens,
  lastCancelledRunId,
  resolveContextWindowBudget,
} from "@zakura/shared";
import type { ModelChatMessage } from "@zakura/shared";
import {
  absorbChatStreamChunk,
  chatStreamStateToResult,
  createChatStreamState,
} from "../src/model-router/openai-response.js";
import { extractSnippet } from "../src/services/cloud-agent-session.js";

describe("lastCancelledRunId", () => {
  it("returns the last cancelled run", () => {
    assert.equal(
      lastCancelledRunId([
        { type: "run_start", runId: "r1", payload: { runId: "r1" } },
        { type: "run_end", runId: "r1", payload: { status: "cancelled" } },
      ]),
      "r1",
    );
  });

  it("returns null when last run completed or is still running", () => {
    assert.equal(
      lastCancelledRunId([
        { type: "run_start", runId: "r1", payload: { runId: "r1" } },
        { type: "run_end", runId: "r1", payload: { status: "cancelled" } },
        { type: "run_start", runId: "r2", payload: { runId: "r2" } },
        { type: "run_end", runId: "r2", payload: { status: "completed" } },
      ]),
      null,
    );
    assert.equal(
      lastCancelledRunId([
        { type: "run_start", runId: "r1", payload: { runId: "r1" } },
        { type: "assistant_delta", runId: "r1", payload: { delta: "…" } },
      ]),
      null,
    );
  });

  it("reads run_end from a tail window without the matching run_start", () => {
    assert.equal(
      lastCancelledRunId([
        { type: "assistant_delta", runId: "r9", payload: { delta: "半截" } },
        { type: "run_end", runId: "r9", payload: { status: "cancelled" } },
      ]),
      "r9",
    );
  });
});

describe("eventsToMessages", () => {
  it("reconstructs user/assistant/tool sequence", () => {
    const msgs = eventsToMessages([
      { type: "user_message", runId: "r1", payload: { content: "你好" } },
      { type: "run_start", runId: "r1", payload: {} },
      { type: "assistant_delta", runId: "r1", payload: { delta: "我先查一下。" } },
      {
        type: "tool_call_start",
        runId: "r1",
        payload: { toolCallId: "c1", name: "web_search" },
      },
      {
        type: "tool_call_args",
        runId: "r1",
        payload: { toolCallId: "c1", arguments: '{"q":"天气"}' },
      },
      {
        type: "tool_call_result",
        runId: "r1",
        payload: { toolCallId: "c1", name: "web_search", resultText: "晴", isError: false },
      },
      { type: "assistant_message", runId: "r1", payload: { content: "今天晴。" } },
      { type: "run_end", runId: "r1", payload: { status: "completed" } },
    ]);
    assert.equal(msgs.length, 4);
    assert.equal(msgs[0]!.role, "user");
    assert.equal(msgs[1]!.role, "assistant");
    assert.equal(msgs[1]!.content, "我先查一下。");
    assert.equal(msgs[1]!.toolCalls?.[0]?.function.name, "web_search");
    assert.equal(msgs[2]!.role, "tool");
    assert.equal(msgs[2]!.toolCallId, "c1");
    assert.equal(msgs[3]!.role, "assistant");
    assert.equal(msgs[3]!.content, "今天晴。");
  });

  it("drops assistant/tool events of failed runs but keeps user messages", () => {
    const msgs = eventsToMessages([
      { type: "user_message", runId: "r1", payload: { content: "任务" } },
      { type: "assistant_delta", runId: "r1", payload: { delta: "半截输出" } },
      { type: "run_error", runId: "r1", payload: { message: "boom" } },
      { type: "run_end", runId: "r1", payload: { status: "failed" } },
      { type: "user_message", runId: "r2", payload: { content: "再试一次" } },
      { type: "assistant_message", runId: "r2", payload: { content: "好的" } },
      { type: "run_end", runId: "r2", payload: { status: "completed" } },
    ]);
    assert.deepEqual(
      msgs.map((m) => [m.role, m.content]),
      [
        ["user", "任务"],
        ["user", "再试一次"],
        ["assistant", "好的"],
      ],
    );
  });

  it("drops deltas of rolled-back stream messages", () => {
    const msgs = eventsToMessages([
      { type: "user_message", runId: "r1", payload: { content: "问" } },
      { type: "assistant_delta", runId: "r1", payload: { messageId: "m1", delta: "半截" } },
      {
        type: "assistant_rollback",
        runId: "r1",
        payload: { messageId: "m1", reason: "stream_interrupted" },
      },
      { type: "assistant_delta", runId: "r1", payload: { messageId: "m2", delta: "完整" } },
      { type: "assistant_message", runId: "r1", payload: { messageId: "m2", content: "完整回答" } },
      { type: "run_end", runId: "r1", payload: { status: "completed" } },
    ]);
    assert.deepEqual(
      msgs.map((m) => [m.role, m.content]),
      [
        ["user", "问"],
        ["assistant", "完整回答"],
      ],
    );
  });

  it("synthesizes tool results for orphan tool calls (cancelled runs)", () => {
    const msgs = eventsToMessages([
      { type: "user_message", runId: "r1", payload: { content: "任务" } },
      {
        type: "tool_call_start",
        runId: "r1",
        payload: { toolCallId: "c1", name: "re_shell_exec" },
      },
      {
        type: "tool_call_args",
        runId: "r1",
        payload: { toolCallId: "c1", arguments: '{"command":"sleep 999"}' },
      },
      // 用户取消：没有 tool_call_result
      { type: "run_end", runId: "r1", payload: { status: "cancelled" } },
    ]);
    assert.deepEqual(
      msgs.map((m) => m.role),
      ["user", "assistant", "tool"],
    );
    assert.equal(msgs[2]!.toolCallId, "c1");
    assert.match(msgs[2]!.content ?? "", /取消或中断/);
  });

  it("ignores run_log / memory_updated / context_sources / session_update", () => {
    const msgs = eventsToMessages([
      { type: "user_message", runId: "r1", payload: { content: "hi" } },
      { type: "run_log", runId: "r1", payload: { level: "info", message: "x" } },
      { type: "tool_call_progress", runId: "r1", payload: { toolCallId: "c1", stdout: "log" } },
      { type: "memory_updated", runId: "r1", payload: { items: [] } },
      { type: "context_sources", runId: "r1", payload: { items: [] } },
      { type: "session_update", runId: "r1", payload: { title: "t" } },
      { type: "assistant_message", runId: "r1", payload: { content: "hey" } },
    ]);
    assert.equal(msgs.length, 2);
  });
});

describe("buildChainMessages", () => {
  it("reconstructs legacy linear history via inference", () => {
    const res = buildChainMessages(
      [
        { type: "user_message", runId: "r1", payload: { messageId: "m1", content: "第一问" } },
        { type: "run_start", runId: "r1", payload: { runId: "r1" } },
        { type: "assistant_message", runId: "r1", payload: { content: "第一答" } },
        { type: "run_end", runId: "r1", payload: { status: "completed" } },
        { type: "user_message", runId: "r2", payload: { messageId: "m2", content: "第二问" } },
        { type: "run_start", runId: "r2", payload: { runId: "r2" } },
        { type: "assistant_message", runId: "r2", payload: { content: "第二答" } },
      ],
      "m2",
    );
    assert.equal(res.turns, 2);
    assert.equal(res.userContent, "第二问");
    assert.deepEqual(
      res.messages.map((m) => [m.role, m.content]),
      [
        ["user", "第一问"],
        ["assistant", "第一答"],
        ["user", "第二问"],
      ],
    );
  });

  it("excludes superseded variants after regenerate", () => {
    const events = [
      { type: "user_message", runId: "r1", payload: { messageId: "m1", content: "问", parentRunId: null } },
      { type: "run_start", runId: "r1", payload: { runId: "r1", replyToMessageId: "m1" } },
      { type: "assistant_message", runId: "r1", payload: { content: "答A" } },
      // 重新生成：同一 m1 的第二个变体
      { type: "run_start", runId: "r2", payload: { runId: "r2", replyToMessageId: "m1" } },
      { type: "assistant_message", runId: "r2", payload: { content: "答B" } },
      // 用户在变体 B 之后继续
      { type: "user_message", runId: "r3", payload: { messageId: "m2", content: "继续", parentRunId: "r2" } },
      { type: "run_start", runId: "r3", payload: { runId: "r3", replyToMessageId: "m2" } },
    ];
    const res = buildChainMessages(events, "m2");
    assert.deepEqual(
      res.messages.map((m) => [m.role, m.content]),
      [
        ["user", "问"],
        ["assistant", "答B"],
        ["user", "继续"],
      ],
    );
  });

  it("follows the selected branch for sibling user messages", () => {
    const events = [
      { type: "user_message", runId: "r1", payload: { messageId: "m1", content: "根", parentRunId: null } },
      { type: "run_start", runId: "r1", payload: { runId: "r1", replyToMessageId: "m1" } },
      { type: "assistant_message", runId: "r1", payload: { content: "根答" } },
      // 分支 A
      { type: "user_message", runId: "r2", payload: { messageId: "mA", content: "走A", parentRunId: "r1" } },
      { type: "run_start", runId: "r2", payload: { runId: "r2", replyToMessageId: "mA" } },
      { type: "assistant_message", runId: "r2", payload: { content: "A答" } },
      // 分支 B（编辑重发的兄弟消息）
      { type: "user_message", runId: "r3", payload: { messageId: "mB", content: "走B", parentRunId: "r1" } },
      { type: "run_start", runId: "r3", payload: { runId: "r3", replyToMessageId: "mB" } },
    ];
    const resB = buildChainMessages(events, "mB");
    assert.deepEqual(
      resB.messages.map((m) => [m.role, m.content]),
      [
        ["user", "根"],
        ["assistant", "根答"],
        ["user", "走B"],
      ],
    );
    const resA = buildChainMessages(events, "mA");
    assert.equal(resA.messages.some((m) => m.content === "走B"), false);
  });

  it("keeps cancelled parent run output so continue can resume", () => {
    const events = [
      { type: "user_message", runId: "r1", payload: { messageId: "m1", content: "做任务", parentRunId: null } },
      { type: "run_start", runId: "r1", payload: { runId: "r1", replyToMessageId: "m1" } },
      { type: "assistant_message", runId: "r1", payload: { content: "已改一半" } },
      { type: "run_end", runId: "r1", payload: { status: "cancelled" } },
      {
        type: "user_message",
        runId: "r2",
        payload: { messageId: "m2", content: "请继续", parentRunId: "r1", continue: true },
      },
    ];
    const res = buildChainMessages(events, "m2");
    assert.deepEqual(
      res.messages.map((m) => [m.role, m.content]),
      [
        ["user", "做任务"],
        ["assistant", "已改一半"],
        ["user", "请继续"],
      ],
    );
  });

  it("keeps user message but drops output of failed parent runs", () => {
    const events = [
      { type: "user_message", runId: "r1", payload: { messageId: "m1", content: "问", parentRunId: null } },
      { type: "run_start", runId: "r1", payload: { runId: "r1", replyToMessageId: "m1" } },
      { type: "assistant_delta", runId: "r1", payload: { delta: "半截" } },
      { type: "run_end", runId: "r1", payload: { status: "failed" } },
      { type: "user_message", runId: "r2", payload: { messageId: "m2", content: "再问", parentRunId: "r1" } },
    ];
    const res = buildChainMessages(events, "m2");
    assert.deepEqual(
      res.messages.map((m) => [m.role, m.content]),
      [
        ["user", "问"],
        ["user", "再问"],
      ],
    );
  });

  it("excludes rolled-back deltas from chain context", () => {
    const events = [
      { type: "user_message", runId: "r1", payload: { messageId: "m1", content: "问", parentRunId: null } },
      { type: "run_start", runId: "r1", payload: { runId: "r1", replyToMessageId: "m1" } },
      { type: "assistant_delta", runId: "r1", payload: { messageId: "a1", delta: "垃圾半截" } },
      { type: "assistant_rollback", runId: "r1", payload: { messageId: "a1" } },
      { type: "assistant_delta", runId: "r1", payload: { messageId: "a2", delta: "重来的" } },
      { type: "assistant_message", runId: "r1", payload: { messageId: "a2", content: "重来的完整回答" } },
      { type: "run_end", runId: "r1", payload: { status: "completed" } },
      { type: "user_message", runId: "r2", payload: { messageId: "m2", content: "继续", parentRunId: "r1" } },
    ];
    const res = buildChainMessages(events, "m2");
    assert.deepEqual(
      res.messages.map((m) => [m.role, m.content]),
      [
        ["user", "问"],
        ["assistant", "重来的完整回答"],
        ["user", "继续"],
      ],
    );
  });

  it("throws when target message is missing", () => {
    assert.throws(() => buildChainMessages([], "nope"));
  });

  it("keeps mid-run steer user_message inside the answering run", () => {
    const events = [
      { type: "user_message", runId: "r1", payload: { messageId: "m1", content: "做重构", parentRunId: null } },
      { type: "run_start", runId: "r1", payload: { runId: "r1", replyToMessageId: "m1" } },
      { type: "assistant_message", runId: "r1", payload: { messageId: "a1", content: "先改 A" } },
      {
        type: "user_message",
        runId: "r1",
        payload: { messageId: "s1", content: "别动测试", steer: true },
      },
      { type: "assistant_message", runId: "r1", payload: { messageId: "a2", content: "好的跳过测试" } },
      { type: "run_end", runId: "r1", payload: { status: "completed" } },
      { type: "user_message", runId: "r2", payload: { messageId: "m2", content: "继续", parentRunId: "r1" } },
    ];
    const res = buildChainMessages(events, "m2");
    assert.equal(res.turns, 2);
    assert.deepEqual(
      res.messages.map((m) => [m.role, m.content]),
      [
        ["user", "做重构"],
        ["assistant", "先改 A"],
        ["user", "别动测试"],
        ["assistant", "好的跳过测试"],
        ["user", "继续"],
      ],
    );
  });

  it("chains OpenAI Gateway events that lack runId / run_start", () => {
    const events = [
      {
        type: "user_message",
        runId: null,
        payload: { messageId: "m1", content: "gateway 问1" },
      },
      {
        type: "assistant_message",
        runId: null,
        payload: { messageId: "a1", content: "gateway 答1" },
      },
      {
        type: "user_message",
        runId: null,
        payload: { messageId: "m2", content: "gateway 问2" },
      },
      {
        type: "assistant_message",
        runId: null,
        payload: { messageId: "a2", content: "gateway 答2" },
      },
    ];
    const res = buildChainMessages(events, "m2");
    assert.equal(res.turns, 2);
    assert.deepEqual(
      res.messages.map((m) => [m.role, m.content]),
      [
        ["user", "gateway 问1"],
        ["assistant", "gateway 答1"],
        ["user", "gateway 问2"],
      ],
    );
  });
});

describe("context compaction", () => {
  it("caps oversized tool results before model prep", () => {
    const big = "x".repeat(20_000);
    const messages: ModelChatMessage[] = [
      { role: "user", content: "查一下" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "re_shell_exec", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: big, toolCallId: "c1", name: "re_shell_exec" },
    ];
    const n = prepareHistoryForModel(messages, { maxToolResultChars: 2_000 });
    assert.ok(n >= 1);
    assert.ok((messages[2]!.content?.length ?? 0) <= 2_200);
    assert.match(messages[2]!.content ?? "", /工具结果截断|截断/);
  });

  it("tier-compresses many large tool results when over budget", () => {
    const messages: ModelChatMessage[] = [{ role: "user", content: "start" }];
    for (let i = 0; i < 30; i += 1) {
      messages.push({
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: `c${i}`,
            type: "function",
            function: { name: "t", arguments: "{}" },
          },
        ],
      });
      messages.push({
        role: "tool",
        content: "y".repeat(3_000),
        toolCallId: `c${i}`,
        name: "t",
      });
    }
    const before = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    compactToolResultsInPlace(messages, {
      thresholdChars: 8_000,
      inLoopChars: 8_000,
      maxToolResultChars: 12_000,
    });
    const after = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    assert.ok(after < before);
  });

  it("buildCompactionDigest prefers structured roles and file paths", () => {
    const digest = buildCompactionDigest([
      { role: "user", content: "部署生产环境" },
      {
        role: "assistant",
        content: "先检查配置",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "re_fs_read", arguments: '{"path":"a.yml"}' },
          },
        ],
      },
      { role: "tool", content: "port: 8080", toolCallId: "c1", name: "re_fs_read" },
    ]);
    assert.match(digest, /用户/);
    assert.match(digest, /助手/);
    assert.match(digest, /re_fs_read|工具|文件轨迹/);
    assert.match(digest, /a\.yml/);
    assert.match(digest, /<read-files>/);
  });

  it("extractFileOpsFromMessages tracks read vs write", () => {
    const ops = extractFileOpsFromMessages([
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "r1",
            type: "function",
            function: { name: "re_fs_read", arguments: '{"path":"src/app.ts"}' },
          },
          {
            id: "w1",
            type: "function",
            function: {
              name: "re_fs_edit",
              arguments: '{"path":"src/app.ts","old_text":"a","new_text":"b"}',
            },
          },
          {
            id: "p1",
            type: "function",
            function: {
              name: "re_apply_patch",
              arguments: JSON.stringify({
                patches: [
                  { path: "src/b.ts", old_text: "x", new_text: "y" },
                  { path: "src/c.ts", old_text: "1", new_text: "2" },
                ],
              }),
            },
          },
        ],
      },
    ]);
    assert.deepEqual(ops.modifiedFiles.sort(), ["src/app.ts", "src/b.ts", "src/c.ts"].sort());
    // 已改文件不重复出现在已读
    assert.ok(!ops.readFiles.includes("src/app.ts"));
  });

  it("mergeFileOps and parseFileOpsFromSummary accumulate paths", () => {
    const merged = mergeFileOps(
      { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
      { readFiles: ["c.ts", "b.ts"], modifiedFiles: ["d.ts"] },
    );
    assert.ok(merged.modifiedFiles.includes("b.ts"));
    assert.ok(merged.modifiedFiles.includes("d.ts"));
    assert.ok(merged.readFiles.includes("a.ts"));
    assert.ok(merged.readFiles.includes("c.ts"));
    assert.ok(!merged.readFiles.includes("b.ts"));

    const parsed = parseFileOpsFromSummary(`
## 代码状态
### 已读文件
- packages/foo/bar.ts
### 已改文件
- packages/foo/bar.ts
- apps/server/src/x.ts
<read-files>
packages/foo/bar.ts
extra/read.ts
</read-files>
<modified-files>
apps/server/src/x.ts
</modified-files>
`);
    assert.ok(parsed.readFiles.includes("extra/read.ts"));
    assert.ok(parsed.modifiedFiles.includes("apps/server/src/x.ts"));
  });

  it("buildCompactionSystemPrompt requires coding structure", () => {
    const prompt = buildCompactionSystemPrompt({
      previousSummary: "## 目标\n修登录",
      previousOps: { readFiles: ["auth.ts"], modifiedFiles: [] },
    });
    assert.match(prompt, /代码状态/);
    assert.match(prompt, /关键决策/);
    assert.match(prompt, /auth\.ts/);
    assert.match(prompt, /已有摘要/);
  });

  it("formatHistorySummaryForPrompt adds coding guidance", () => {
    const text = formatHistorySummaryForPrompt("## 目标\n实现压缩", {
      readFiles: ["messages.ts"],
      modifiedFiles: ["runtime.ts"],
    });
    assert.match(text, /重新读取|已改/);
    assert.match(text, /runtime\.ts/);
    assert.match(text, /messages\.ts/);
  });

  it("buildSessionReuseDigest splits recent vs older", () => {
    const messages: ModelChatMessage[] = [];
    for (let i = 0; i < 20; i += 1) {
      messages.push({ role: "user", content: `q${i}` });
      messages.push({ role: "assistant", content: `a${i}` });
    }
    const { digest, recent, olderCount } = buildSessionReuseDigest(messages, {
      keepRecent: 6,
    });
    assert.equal(recent.length, 6);
    assert.equal(olderCount, 34);
    assert.ok(digest.length > 0);
  });

  it("splitMessagesForCompaction cuts on user turn boundaries", () => {
    const messages: ModelChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old task " + "x".repeat(500) },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "re_fs_read", arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: "tool", content: "file body " + "y".repeat(400), toolCallId: "c1", name: "re_fs_read" },
      { role: "assistant", content: "done old" },
      { role: "user", content: "new task" },
      { role: "assistant", content: "working on new" },
    ];
    const split = splitMessagesForCompaction(messages, {
      keepRecent: 4,
      keepRecentChars: 200,
      thresholdChars: 8_000,
    });
    assert.equal(split.systemPrefix.length, 1);
    assert.equal(split.systemPrefix[0]!.role, "system");
    // recent 应从某个 user 起，不能以 tool 开头
    assert.ok(split.recent.length > 0);
    assert.notEqual(split.recent[0]!.role, "tool");
    assert.ok(
      split.recent[0]!.role === "user" || split.recent[0]!.role === "assistant",
    );
    // older + recent = body
    assert.equal(
      split.older.length + split.recent.length,
      messages.length - 1,
    );
  });

  it("splitMessagesForCompaction never orphans tool results at cut", () => {
    const messages: ModelChatMessage[] = [
      { role: "user", content: "u1" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "t1",
            type: "function",
            function: { name: "re_shell_exec", arguments: '{"command":"ls"}' },
          },
        ],
      },
      {
        role: "tool",
        content: "out " + "z".repeat(3000),
        toolCallId: "t1",
        name: "re_shell_exec",
      },
      { role: "user", content: "u2 keep me" },
      { role: "assistant", content: "ok" },
    ];
    const split = splitMessagesForCompaction(messages, {
      keepRecentChars: 50,
      keepRecent: 8,
      thresholdChars: 8_000,
    });
    if (split.recent.length) {
      assert.notEqual(split.recent[0]!.role, "tool");
    }
  });

  it("isContextOverflowError detects common patterns", () => {
    assert.equal(isContextOverflowError(new Error("context_length_exceeded")), true);
    assert.equal(isContextOverflowError(new Error("This model's maximum context length is")), true);
    assert.equal(isContextOverflowError(new Error("prompt is too long")), true);
    assert.equal(isContextOverflowError(new Error("普通网络错误")), false);
  });

  it("extractFailureSignals picks shell errors", () => {
    const signals = extractFailureSignals([
      {
        role: "tool",
        name: "re_shell_exec",
        toolCallId: "1",
        content: "exit code: 1\nError: tsc failed\nsrc/a.ts(1,1): error TS2322",
      },
      {
        role: "tool",
        name: "re_fs_read",
        toolCallId: "2",
        content: "export const x = 1",
      },
    ]);
    assert.ok(signals.length >= 1);
    assert.match(signals[0]!.signal, /error|exit|tsc/i);
  });

  it("buildCompactionDigest includes failure section", () => {
    const digest = buildCompactionDigest([
      { role: "user", content: "fix" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "1",
            type: "function",
            function: { name: "re_shell_exec", arguments: '{"command":"npm test"}' },
          },
        ],
      },
      {
        role: "tool",
        name: "re_shell_exec",
        toolCallId: "1",
        content: "FAIL tests/a.test.ts\nError: expected true",
      },
    ]);
    assert.match(digest, /失败|验证/);
    assert.match(digest, /FAIL|Error/);
  });

  it("resolveCompactBudgetForContextWindow tightens for small windows", () => {
    const tight = resolveCompactBudgetForContextWindow(
      { thresholdChars: 200_000, softThresholdChars: 140_000, keepRecentChars: 80_000 },
      32_000,
    );
    assert.ok(tight.thresholdTokens < estimateTokensRough(200_000));
    assert.ok(tight.thresholdTokens >= 2_000);
    assert.ok(tight.softThresholdTokens <= tight.thresholdTokens);
    assert.ok(tight.contextLimitTokens === 32_000);

    const bigWindow = resolveCompactBudgetForContextWindow(
      { thresholdChars: 40_000 },
      200_000,
    );
    // 用户 40k chars ≈ 10k tokens，应严于窗口 85%
    assert.ok(bigWindow.thresholdTokens <= 12_000);
  });

  it("estimateTextTokens is CJK-aware", () => {
    const en = estimateTextTokens("hello world test");
    const zh = estimateTextTokens("你好世界测试一下");
    // 中文应按字计，明显多于「字数/4」
    assert.ok(zh >= 7);
    assert.ok(en >= 2);
    assert.ok(zh > en);
  });

  it("applyTokenCalibration clamps and scales", () => {
    const base = 1000;
    const up = applyTokenCalibration(base, {
      measuredPromptTokens: 1800,
      estimatedAtMeasure: 1000,
    });
    assert.equal(up, 1800);
    const capped = applyTokenCalibration(base, {
      measuredPromptTokens: 5000,
      estimatedAtMeasure: 1000,
    });
    assert.ok(capped <= 2200);
  });

  it("resolveContextWindowBudget leaves reserve for output", () => {
    const b = resolveContextWindowBudget({ contextLimitTokens: 128_000 });
    assert.ok(b.reserveTokens >= 2_000);
    assert.ok(b.hardTokens < b.usableTokens);
    assert.ok(b.softTokens < b.hardTokens);
  });

  it("estimateMessagesTokens grows with tool dumps", () => {
    const small = estimateMessagesTokens([{ role: "user", content: "hi" }]);
    const big = estimateMessagesTokens([
      { role: "user", content: "hi" },
      {
        role: "tool",
        name: "re_fs_read",
        content: "x".repeat(8_000),
        toolCallId: "1",
      },
    ]);
    assert.ok(big > small + 1_000);
  });
});

function estimateTokensRough(chars: number): number {
  return Math.ceil(chars / 4);
}

describe("parseMemoryExtraction", () => {
  it("parses fenced JSON object", () => {
    const out = parseMemoryExtraction(
      '好的，提取如下：\n```json\n{"memories":[{"content":"用户偏好中文回复","layer":"preference","importance":4}]}\n```',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.content, "用户偏好中文回复");
    assert.equal(out[0]!.layer, "preference");
    assert.equal(out[0]!.importance, 4);
  });

  it("parses bare array and drops invalid layers", () => {
    const out = parseMemoryExtraction(
      '[{"content":"在做 reCloud 项目","layer":"nonsense"},{"content":""}]',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.layer, undefined);
  });

  it("returns empty on empty result or garbage", () => {
    assert.deepEqual(parseMemoryExtraction('{"memories":[]}'), []);
    assert.deepEqual(parseMemoryExtraction("没有值得记住的内容"), []);
  });

  it("caps at 5 items", () => {
    const many = JSON.stringify({
      memories: Array.from({ length: 9 }, (_, i) => ({ content: `事实 ${i}` })),
    });
    assert.equal(parseMemoryExtraction(many).length, 5);
  });
});

describe("extractSnippet", () => {
  it("returns context around the match", () => {
    const payload = JSON.stringify({
      messageId: "m",
      content: `${"前".repeat(60)}关键词${"后".repeat(60)}`,
    });
    const snip = extractSnippet(payload, "关键词");
    assert.ok(snip);
    assert.ok(snip!.includes("关键词"));
    assert.ok(snip!.startsWith("…"));
    assert.ok(snip!.endsWith("…"));
    assert.ok(snip!.length < 100);
  });

  it("is case-insensitive and handles head matches", () => {
    const payload = JSON.stringify({ content: "Hello World, this is a test" });
    const snip = extractSnippet(payload, "hello");
    assert.ok(snip!.startsWith("Hello"));
  });

  it("returns null for invalid payloads", () => {
    assert.equal(extractSnippet("not-json", "x"), null);
    assert.equal(extractSnippet(JSON.stringify({}), "x"), null);
  });
});

describe("chat stream accumulation", () => {
  it("accumulates content deltas and tool call fragments", () => {
    const state = createChatStreamState();
    assert.equal(
      absorbChatStreamChunk(state, {
        model: "gpt-x",
        choices: [{ delta: { content: "你" } }],
      }).content,
      "你",
    );
    assert.deepEqual(
      absorbChatStreamChunk(state, { choices: [{ delta: { content: "好" } }] }),
      { content: "好", reasoning: "" },
    );
    absorbChatStreamChunk(state, {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", function: { name: "web_", arguments: "" } },
            ],
          },
        },
      ],
    });
    absorbChatStreamChunk(state, {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { name: "search", arguments: '{"q":' } }],
          },
        },
      ],
    });
    absorbChatStreamChunk(state, {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: '"天气"}' } }] },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const result = chatStreamStateToResult(state, "fallback");
    assert.equal(result.content, "你好");
    assert.equal(state.reasoning, "");
    assert.equal(result.model, "gpt-x");
    assert.equal(result.finishReason, "tool_calls");
    assert.equal(result.toolCalls?.length, 1);
    assert.equal(result.toolCalls?.[0]?.id, "call_1");
    assert.equal(result.toolCalls?.[0]?.function.name, "web_search");
    assert.equal(result.toolCalls?.[0]?.function.arguments, '{"q":"天气"}');
    assert.equal(result.usage?.totalTokens, 15);
  });

  it("accumulates reasoning deltas separately from content", () => {
    const state = createChatStreamState();
    assert.deepEqual(
      absorbChatStreamChunk(state, {
        choices: [{ delta: { reasoning_content: "先想一下。" } }],
      }),
      { content: "", reasoning: "先想一下。" },
    );
    assert.deepEqual(
      absorbChatStreamChunk(state, {
        choices: [{ delta: { content: "结论" } }],
      }),
      { content: "结论", reasoning: "" },
    );
    assert.equal(state.reasoning, "先想一下。");
    assert.equal(state.content, "结论");
  });

  it("fills missing tool call ids", () => {
    const state = createChatStreamState();
    absorbChatStreamChunk(state, {
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { name: "t", arguments: "{}" } }] } },
      ],
    });
    const result = chatStreamStateToResult(state, "m");
    assert.equal(result.toolCalls?.[0]?.id, "call_0");
  });

  it("does not expose stray streamed tool calls when the model stops normally", () => {
    const state = createChatStreamState();
    absorbChatStreamChunk(state, {
      choices: [
        {
          delta: {
            content: "最终答案",
            tool_calls: [{ index: 0, function: { name: "web_search", arguments: "{}" } }],
          },
          finish_reason: "stop",
        },
      ],
    });

    const result = chatStreamStateToResult(state, "m");
    assert.equal(result.content, "最终答案");
    assert.equal(result.finishReason, "stop");
    assert.equal(result.toolCalls, undefined);
    assert.equal(result.openai.choices[0]!.message.tool_calls, undefined);
  });
});

describe("attachments", () => {
  it("parseAttachments tolerates invalid entries and caps at 10", () => {
    const out = parseAttachments([
      { name: "a.png", path: "uploads/a.png", mime: "image/png", size: 10, kind: "image" },
      { path: "uploads/b.pdf" },
      { name: "no-path" },
      "garbage",
      null,
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], {
      name: "a.png",
      path: "uploads/a.png",
      mime: "image/png",
      size: 10,
      kind: "image",
    });
    assert.equal(out[1]!.name, "b.pdf");
    assert.equal(out[1]!.kind, "file");
    assert.equal(parseAttachments("nope").length, 0);
  });

  it("buildUserMessage adds notes and image parts", () => {
    const msg = buildUserMessage("看看这张图", [
      { name: "a.png", path: "uploads/a.png", mime: "image/png", size: 2048, kind: "image" },
      { name: "b.csv", path: "uploads/b.csv", mime: "text/csv", size: 100, kind: "file" },
    ]);
    assert.equal(msg.role, "user");
    assert.match(msg.content ?? "", /uploads\/a\.png/);
    assert.match(msg.content ?? "", /uploads\/b\.csv/);
    assert.equal(msg.parts?.length, 2);
    assert.equal(msg.parts?.[0]?.type, "text");
    const img = msg.parts?.[1];
    assert.equal(img?.type, "image_url");
    if (img?.type === "image_url") {
      assert.equal(img.imageUrl.url, "workspace:uploads/a.png");
    }
  });

  it("buildUserMessage without attachments keeps plain content", () => {
    const msg = buildUserMessage("你好", []);
    assert.equal(msg.content, "你好");
    assert.equal(msg.parts, undefined);
  });

  it("buildChainMessages carries attachments into user parts", () => {
    const res = buildChainMessages(
      [
        {
          type: "user_message",
          runId: "r1",
          payload: {
            messageId: "m1",
            content: "分析图片",
            parentRunId: null,
            attachments: [
              { name: "x.jpg", path: "uploads/x.jpg", mime: "image/jpeg", size: 5, kind: "image" },
            ],
          },
        },
        { type: "run_start", runId: "r1", payload: { runId: "r1", replyToMessageId: "m1" } },
      ],
      "m1",
    );
    const user = res.messages[0]!;
    assert.match(user.content ?? "", /uploads\/x\.jpg/);
    assert.equal(user.parts?.some((p) => p.type === "image_url"), true);
  });
});

describe("runSubagent", () => {
  const fakeAgent = {
    id: "agent-1",
    tenantId: "t1",
    name: "测试代理",
    slug: "test-agent",
    configJson: "{}",
    enableComputer: true,
    enableBrowser: false,
    enableMemory: false,
    runtimeNodeId: null,
  } as unknown as import("../src/db/schema.js").Agent;

  type FakeEvent = {
    sessionId: string;
    type: string;
    runId: string | null;
    payload: Record<string, unknown>;
  };

  /** 内存版会话存储：验证子代理对话历史确实作为 kind 会话落库 */
  function makeFakeStore() {
    const events: FakeEvent[] = [];
    const sessions: Array<Record<string, unknown>> = [];
    let n = 0;
    const store = {
      createSession: async (input: Record<string, unknown>) => {
        const session = { id: `sess-${(n += 1)}`, lastSeq: 0, activeRunId: null, ...input };
        sessions.push(session);
        return session;
      },
      createRun: async (sessionId: string) => ({
        id: `run-${(n += 1)}`,
        sessionId,
        status: "queued",
        cancelRequested: false,
      }),
      markRunStarted: async () => {},
      appendEvent: async (input: {
        sessionId: string;
        type: string;
        runId?: string | null;
        payload: unknown;
      }) => {
        const ev: FakeEvent = {
          sessionId: input.sessionId,
          type: input.type,
          runId: input.runId ?? null,
          payload: input.payload as Record<string, unknown>,
        };
        events.push(ev);
        return { ...ev, id: `ev-${events.length}`, seq: events.length, createdAt: "" };
      },
      isCancelRequested: async () => false,
      onRunCancel: () => () => {},
      finishRun: async () => {},
      listQueued: async () => [],
      drainSteerQueued: async () => [],
      takeNextQueued: async () => null,
      enqueueQueued: async () => [],
      publishQueueSnapshot: async () => {},
    };
    return { store, events, sessions };
  }

  function makeRuntime(handlers: {
    chat: (messages: Array<{ role: string; content: string | null }>, options?: unknown) => {
      content: string | null;
      toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    };
  }) {
    const chatInputs: Array<{ messages: unknown[]; options: unknown }> = [];
    const toolCalls: string[] = [];
    const gateway = {
      listToolsForAgent: async () => [
        {
          qualifiedName: "re_spawn_subagent",
          instanceId: null,
          providerId: "zakura-subagent",
          localName: "spawn_subagent",
          description: "",
          inputSchema: { type: "object" },
        },
        {
          qualifiedName: "re_fs_read",
          instanceId: null,
          providerId: "zakura-agent",
          localName: "fs_read",
          description: "读文件",
          inputSchema: { type: "object" },
        },
      ],
      callTool: async (_tenant: string, qualified: string) => {
        toolCalls.push(qualified);
        return { content: [{ type: "text", text: `result-of-${qualified}` }] };
      },
    };
    const modelRouter = {
      // 统一循环引擎全部走流式接口
      chatStream: async (
        _tenant: string,
        messages: unknown[],
        _input: unknown,
        options: unknown,
      ) => {
        chatInputs.push({ messages, options });
        const res = handlers.chat(
          messages as Array<{ role: string; content: string | null }>,
          options,
        );
        return { ...res, model: "test", routeSlug: "test-route", openai: {} };
      },
    };
    const { store, events, sessions } = makeFakeStore();
    const runtime = new CloudAgentRuntime({
      store: store as never,
      gateway: gateway as never,
      modelRouter: modelRouter as never,
      agentService: {} as never,
    });
    return { runtime, chatInputs, toolCalls, events, sessions };
  }

  it("runs an isolated tool loop and returns the final answer", async () => {
    let round = 0;
    const { runtime, chatInputs, toolCalls, events, sessions } = makeRuntime({
      chat: () => {
        round += 1;
        if (round === 1) {
          return {
            content: null,
            toolCalls: [
              {
                id: "c1",
                type: "function",
                function: { name: "re_fs_read", arguments: '{"path":"a.txt"}' },
              },
            ],
          };
        }
        return { content: "最终结论：a.txt 共 3 行" };
      },
    });

    const progress: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const answer = await runtime.runSubagent(
      "t1",
      fakeAgent,
      { task: "统计 a.txt 行数", expected_output: "一句话结论" },
      {
        onProgress: (message, data) => progress.push({ message, ...(data ? { data } : {}) }),
        origin: { source: "agent_loop", parentSessionId: "parent-1", parentRunId: "prun-1" },
      },
    );

    assert.equal(answer.text, "最终结论：a.txt 共 3 行");
    assert.deepEqual(toolCalls, ["re_fs_read"]);
    // 默认深度上限 2：depth=1 的子代理仍可继续派生（工具面保留 spawn_subagent）
    const defs = (chatInputs[0]!.options as {
      tools: Array<{ function: { name: string } }>;
    }).tools;
    assert.equal(defs.some((d) => d.function.name === "re_spawn_subagent"), true);
    assert.equal(defs.some((d) => d.function.name === "re_fs_read"), true);
    // 系统提示词包含任务契约；用户消息包含任务与期望输出
    const sys = (chatInputs[0]!.messages[0] as { content: string }).content;
    assert.match(sys, /子代理/);
    assert.match(sys, /任务契约/);
    assert.match(sys, /一句话结论/);
    // 第二轮能看到工具结果
    const secondMsgs = chatInputs[1]!.messages as Array<{ role: string; content: string | null }>;
    assert.equal(secondMsgs.some((m) => m.role === "tool" && m.content?.includes("result-of-re_fs_read")), true);
    assert.equal(progress.length >= 2, true);

    // —— 对话历史落库为 kind=subagent 会话 ——
    assert.equal(sessions.length, 1);
    const session = sessions[0]!;
    assert.equal(session.kind, "subagent");
    assert.equal(answer.sessionId, session.id);
    assert.match(String(session.title), /统计 a\.txt 行数/);
    const origin = session.origin as Record<string, unknown>;
    assert.equal(origin.source, "agent_loop");
    assert.equal(origin.parentSessionId, "parent-1");
    // 事件流完整：任务、Run 生命周期、工具调用、最终回复
    const types = events.map((e) => e.type);
    for (const t of [
      "user_message",
      "run_start",
      "tool_call_start",
      "tool_call_args",
      "tool_call_result",
      "assistant_message",
      "run_end",
    ]) {
      assert.equal(types.includes(t), true, `缺少事件 ${t}`);
    }
    const userEv = events.find((e) => e.type === "user_message")!;
    assert.match(String(userEv.payload.content), /统计 a\.txt 行数/);
    const finalEv = events.find((e) => e.type === "assistant_message")!;
    assert.equal(finalEv.payload.content, "最终结论：a.txt 共 3 行");
    const endEv = events.find((e) => e.type === "run_end")!;
    assert.equal(endEv.payload.status, "completed");
    // 进度回调携带子会话 id，父会话可链接
    assert.equal(
      progress.some((p) => p.data && p.data.childSessionId === session.id),
      true,
    );
  });

  it("requires a task", async () => {
    const { runtime } = makeRuntime({ chat: () => ({ content: "x" }) });
    await assert.rejects(runtime.runSubagent("t1", fakeAgent, {}, {}), /task 必填/);
  });

  it("allows nested spawn within depth limit and records the chain", async () => {
    const { runtime, chatInputs, toolCalls, events, sessions } = makeRuntime({
      chat: (messages) => {
        const userText = messages.find((m) => m.role === "user")?.content ?? "";
        // 第二级子代理：直接给出结果
        if (userText.includes("子任务A")) return { content: "A 完成" };
        // 第一级子代理：先派生下一级，拿到结果后总结
        const hasToolResult = messages.some((m) => m.role === "tool");
        if (!hasToolResult) {
          return {
            content: null,
            toolCalls: [
              {
                id: "c1",
                type: "function",
                function: {
                  name: "re_spawn_subagent",
                  arguments: '{"task":"子任务A"}',
                },
              },
            ],
          };
        }
        return { content: "总结：A 完成" };
      },
    });

    const answer = await runtime.runSubagent(
      "t1",
      fakeAgent,
      { task: "拆解并完成大任务" },
      { origin: { source: "agent_loop", parentSessionId: "root", parentRunId: "r0" } },
    );

    assert.equal(answer.text, "总结：A 完成");
    // 嵌套派生走 hook 并行执行，不经过 gateway.callTool
    assert.equal(toolCalls.includes("re_spawn_subagent"), false);

    // 两级子代理会话都落库，链路完整
    assert.equal(sessions.length, 2);
    const [level1, level2] = sessions as Array<Record<string, unknown>>;
    assert.equal(level1!.kind, "subagent");
    assert.equal(level2!.kind, "subagent");
    assert.equal(answer.sessionId, level1!.id);
    const origin2 = level2!.origin as Record<string, unknown>;
    assert.equal(origin2.source, "agent_loop");
    assert.equal(origin2.parentSessionId, level1!.id);
    assert.equal(origin2.parentToolCallId, "c1");
    assert.equal(origin2.depth, 2);

    // 第一级会话的 tool_call_result 带第二级子会话链接
    const resultEv = events.find(
      (e) => e.type === "tool_call_result" && e.sessionId === level1!.id,
    );
    assert.ok(resultEv);
    assert.equal(resultEv!.payload.childSessionId, level2!.id);
    assert.match(String(resultEv!.payload.resultText), /A 完成/);

    // 深度上限（默认 2）：第一级工具面含 spawn，第二级已剔除
    const level1Defs = (chatInputs[0]!.options as {
      tools: Array<{ function: { name: string } }>;
    }).tools;
    assert.equal(level1Defs.some((d) => d.function.name === "re_spawn_subagent"), true);
    const level2Input = chatInputs.find((ci) =>
      (ci.messages as Array<{ role: string; content: string | null }>).some(
        (m) => m.role === "user" && m.content?.includes("子任务A"),
      ),
    )!;
    const level2Defs = (level2Input.options as {
      tools: Array<{ function: { name: string } }>;
    }).tools;
    assert.equal(level2Defs.some((d) => d.function.name === "re_spawn_subagent"), false);
    // 第一级提示词允许嵌套派生，第二级不再提及
    const sys1 = (chatInputs[0]!.messages[0] as { content: string }).content;
    assert.match(sys1, /派生下一级子代理/);
    const sys2 = (level2Input.messages[0] as { content: string }).content;
    assert.equal(/派生下一级子代理/.test(sys2), false);

    // 两级 Run 都完成
    const ends = events.filter((e) => e.type === "run_end");
    assert.equal(ends.length, 2);
    assert.equal(ends.every((e) => e.payload.status === "completed"), true);
  });

  it("stops nesting at configured maxSubagentDepth", async () => {
    const deepAgent = {
      ...(fakeAgent as unknown as Record<string, unknown>),
      configJson: JSON.stringify({ cloud: { maxSubagentDepth: 1 } }),
    } as unknown as import("../src/db/schema.js").Agent;
    const { runtime, chatInputs } = makeRuntime({
      chat: () => ({ content: "直接完成" }),
    });
    const answer = await runtime.runSubagent("t1", deepAgent, { task: "简单任务" }, {});
    assert.equal(answer.text, "直接完成");
    // maxDepth=1：depth-1 子代理即达上限，工具面不含 spawn_subagent
    const defs = (chatInputs[0]!.options as {
      tools: Array<{ function: { name: string } }>;
    }).tools;
    assert.equal(defs.some((d) => d.function.name === "re_spawn_subagent"), false);
  });

  it("stops when parent run is cancelled and records it", async () => {
    const { runtime, events } = makeRuntime({
      chat: () => ({
        content: null,
        toolCalls: [
          { id: "c1", type: "function", function: { name: "re_fs_read", arguments: "{}" } },
        ],
      }),
    });
    let asked = 0;
    await assert.rejects(
      runtime.runSubagent(
        "t1",
        fakeAgent,
        { task: "永远做不完" },
        {
          isCancelled: async () => {
            asked += 1;
            return asked > 1;
          },
        },
      ),
      /已取消/,
    );
    // 取消也留下完整记录：run_end(cancelled)
    const endEv = events.find((e) => e.type === "run_end");
    assert.ok(endEv);
    assert.equal(endEv!.payload.status, "cancelled");
  });
});
