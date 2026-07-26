import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildChainMessages,
  buildUserMessage,
  CloudAgentRuntime,
  eventsToMessages,
  parseAttachments,
  parseMemoryExtraction,
} from "../src/services/cloud-agent-runtime.js";
import {
  absorbChatStreamChunk,
  chatStreamStateToResult,
  createChatStreamState,
} from "../src/model-router/openai-response.js";
import { extractSnippet } from "../src/services/cloud-agent-session.js";

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

  it("ignores run_log / memory_updated / session_update", () => {
    const msgs = eventsToMessages([
      { type: "user_message", runId: "r1", payload: { content: "hi" } },
      { type: "run_log", runId: "r1", payload: { level: "info", message: "x" } },
      { type: "memory_updated", runId: "r1", payload: { items: [] } },
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
});

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
      }),
      "你",
    );
    assert.equal(
      absorbChatStreamChunk(state, { choices: [{ delta: { content: "好" } }] }),
      "好",
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
    assert.equal(result.model, "gpt-x");
    assert.equal(result.finishReason, "tool_calls");
    assert.equal(result.toolCalls?.length, 1);
    assert.equal(result.toolCalls?.[0]?.id, "call_1");
    assert.equal(result.toolCalls?.[0]?.function.name, "web_search");
    assert.equal(result.toolCalls?.[0]?.function.arguments, '{"q":"天气"}');
    assert.equal(result.usage?.totalTokens, 15);
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
      chat: async (_tenant: string, messages: unknown[], _input: unknown, options: unknown) => {
        chatInputs.push({ messages, options });
        const res = handlers.chat(
          messages as Array<{ role: string; content: string | null }>,
          options,
        );
        return { ...res, model: "test", openai: {} };
      },
    };
    const runtime = new CloudAgentRuntime({
      store: {} as never,
      gateway: gateway as never,
      modelRouter: modelRouter as never,
      agentService: {} as never,
    });
    return { runtime, chatInputs, toolCalls };
  }

  it("runs an isolated tool loop and returns the final answer", async () => {
    let round = 0;
    const { runtime, chatInputs, toolCalls } = makeRuntime({
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

    const progress: string[] = [];
    const answer = await runtime.runSubagent(
      "t1",
      fakeAgent,
      { task: "统计 a.txt 行数", expected_output: "一句话结论" },
      { onProgress: (m) => progress.push(m) },
    );

    assert.equal(answer, "最终结论：a.txt 共 3 行");
    assert.deepEqual(toolCalls, ["re_fs_read"]);
    // 子代理工具集不包含 spawn_subagent（防递归）
    const defs = (chatInputs[0]!.options as {
      tools: Array<{ function: { name: string } }>;
    }).tools;
    assert.equal(defs.some((d) => d.function.name === "re_spawn_subagent"), false);
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
  });

  it("requires a task", async () => {
    const { runtime } = makeRuntime({ chat: () => ({ content: "x" }) });
    await assert.rejects(runtime.runSubagent("t1", fakeAgent, {}, {}), /task 必填/);
  });

  it("stops when parent run is cancelled", async () => {
    const { runtime } = makeRuntime({
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
  });
});
