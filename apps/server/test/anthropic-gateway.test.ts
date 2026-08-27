/**
 * Anthropic Messages API 入站协议的双向翻译。
 *
 * 两个方向都必须钉住：
 * - 请求侧：Anthropic 把 tool_result 放在 user 内容里，Chat Completions 用独立的
 *   role:"tool" 消息按 id 关联。翻错这一点，模型就看不到「调用」和「结果」的对应关系。
 * - 响应侧：Anthropic 的流是严格事件序列（不是可互换的 chunk），官方 SDK 依赖
 *   message_start → content_block_start → delta* → content_block_stop →
 *   message_delta → message_stop，且 index 单调递增。顺序错了 SDK 直接崩。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ModelChatResult } from "@zakura/shared";
import {
  anthropicBlockStop,
  anthropicErrorBody,
  anthropicSse,
  anthropicStopReason,
  anthropicStreamEnd,
  anthropicStreamStart,
  anthropicSystemToText,
  anthropicTextBlockStart,
  anthropicTextDelta,
  anthropicThinkingBlockStart,
  anthropicThinkingDelta,
  anthropicToolUseEvents,
  translateAnthropicRequest,
  translateAnthropicResponse,
} from "../src/services/anthropic-gateway.js";

type Msg = { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string };

function messagesOf(body: ReturnType<typeof translateAnthropicRequest>): Msg[] {
  return (body.messages ?? []) as Msg[];
}

describe("translateAnthropicRequest", () => {
  it("system 字符串变成 system 消息", () => {
    const out = translateAnthropicRequest({
      model: "claude-x",
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
    });
    assert.deepEqual(messagesOf(out)[0], { role: "system", content: "be terse" });
    assert.equal(out.model, "claude-x");
    assert.equal(out.max_tokens, 100);
  });

  it("system 数组块拼成一段文本", () => {
    const out = translateAnthropicRequest({
      system: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
      messages: [],
    });
    assert.equal(messagesOf(out)[0]!.content, "a\n\nb");
    assert.equal(anthropicSystemToText("plain"), "plain");
  });

  it("纯文本块合并为字符串内容", () => {
    const out = translateAnthropicRequest({
      messages: [{ role: "user", content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] }],
    });
    assert.deepEqual(messagesOf(out), [{ role: "user", content: "hello world" }]);
  });

  it("base64 图片变成 data URL 的 image_url", () => {
    const out = translateAnthropicRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
          ],
        },
      ],
    });
    const parts = messagesOf(out)[0]!.content as Array<Record<string, unknown>>;
    assert.equal(parts.length, 2);
    assert.deepEqual(parts[1], {
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,QUJD" },
    });
  });

  it("tool_result 提升为独立的 tool 消息并保留 id 关联", () => {
    const out = translateAnthropicRequest({
      messages: [
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "sure" },
            { type: "tool_use", id: "toolu_1", name: "ls", input: { path: "/" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "a\nb" },
            { type: "text", text: "thanks" },
          ],
        },
      ],
    });
    const msgs = messagesOf(out);
    assert.equal(msgs[1]!.role, "assistant");
    assert.deepEqual(msgs[1]!.tool_calls, [
      { id: "toolu_1", type: "function", function: { name: "ls", arguments: '{"path":"/"}' } },
    ]);
    // tool 结果必须排在后续 user 文本之前，保持模型在原始 transcript 里看到的顺序。
    assert.equal(msgs[2]!.role, "tool");
    assert.equal(msgs[2]!.tool_call_id, "toolu_1");
    assert.equal(msgs[2]!.content, "a\nb");
    assert.equal(msgs[3]!.role, "user");
    assert.equal(msgs[3]!.content, "thanks");
  });

  it("tool_result 的块数组内容拼成文本", () => {
    const out = translateAnthropicRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "x" }, { type: "text", text: "y" }] },
          ],
        },
      ],
    });
    assert.equal(messagesOf(out)[0]!.content, "x\ny");
  });

  it("工具定义映射为 function 形状", () => {
    const out = translateAnthropicRequest({
      messages: [],
      tools: [
        { name: "ls", description: "list", input_schema: { type: "object", properties: { p: { type: "string" } } } },
        // 服务端工具没有 input_schema，不能当函数工具转发。
        { type: "web_search_20250305", name: "web_search" },
      ],
    });
    const tools = out.tools as Array<Record<string, any>>;
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.function.name, "ls");
    assert.equal(tools[0]!.function.description, "list");
  });

  it("tool_choice 各形态映射正确", () => {
    const choice = (v: unknown) => translateAnthropicRequest({ messages: [], tool_choice: v }).tool_choice;
    assert.equal(choice({ type: "auto" }), "auto");
    // Anthropic 的 any = 必须用某个工具，Chat Completions 里最接近的是 required。
    assert.equal(choice({ type: "any" }), "required");
    assert.equal(choice({ type: "none" }), "none");
    assert.deepEqual(choice({ type: "tool", name: "ls" }), {
      type: "function",
      function: { name: "ls" },
    });
  });

  it("extended thinking 的 budget 分档映射到 reasoning effort", () => {
    const effort = (budget: number) =>
      translateAnthropicRequest({
        messages: [],
        thinking: { type: "enabled", budget_tokens: budget },
      }).reasoning_effort;
    assert.equal(effort(1_000), "low");
    assert.equal(effort(8_000), "medium");
    assert.equal(effort(32_000), "high");
    assert.equal(
      translateAnthropicRequest({ messages: [] }).reasoning_effort,
      undefined,
    );
  });

  it("采样参数与 stop_sequences 透传", () => {
    const out = translateAnthropicRequest({
      messages: [],
      temperature: 0.4,
      top_p: 0.9,
      stop_sequences: ["END"],
      stream: true,
    });
    assert.equal(out.temperature, 0.4);
    assert.equal(out.top_p, 0.9);
    assert.deepEqual(out.stop, ["END"]);
    assert.equal(out.stream, true);
  });

  it("未知内容块被丢弃而不是原样下传", () => {
    const out = translateAnthropicRequest({
      messages: [{ role: "user", content: [{ type: "future_thing", blah: 1 }] }],
    });
    assert.deepEqual(messagesOf(out), []);
  });
});

describe("translateAnthropicResponse", () => {
  const base: ModelChatResult = {
    content: "hello",
    model: "m",
    finishReason: "stop",
    usage: { promptTokens: 7, completionTokens: 3 },
    openai: {} as never,
  };

  it("文本结果转成 message + text 块", () => {
    const out = translateAnthropicResponse(base, { id: "msg_1", model: "m" }) as any;
    assert.equal(out.type, "message");
    assert.equal(out.role, "assistant");
    assert.equal(out.id, "msg_1");
    assert.deepEqual(out.content, [{ type: "text", text: "hello" }]);
    assert.equal(out.stop_reason, "end_turn");
    assert.deepEqual(out.usage, { input_tokens: 7, output_tokens: 3 });
  });

  it("工具调用转成 tool_use 块，stop_reason 为 tool_use", () => {
    const out = translateAnthropicResponse(
      {
        ...base,
        content: null,
        toolCalls: [{ id: "c1", type: "function", function: { name: "ls", arguments: '{"p":"/"}' } }],
      },
      {},
    ) as any;
    assert.deepEqual(out.content, [
      { type: "tool_use", id: "c1", name: "ls", input: { p: "/" } },
    ]);
    assert.equal(out.stop_reason, "tool_use");
  });

  it("工具参数不是合法 JSON 时保留原文而不是丢弃", () => {
    const out = translateAnthropicResponse(
      {
        ...base,
        toolCalls: [{ id: "c1", type: "function", function: { name: "x", arguments: "not json" } }],
      },
      {},
    ) as any;
    const block = out.content.find((b: any) => b.type === "tool_use");
    assert.deepEqual(block.input, { _raw: "not json" });
  });

  it("空内容也至少给一个块，避免客户端取 [0] 出错", () => {
    const out = translateAnthropicResponse({ ...base, content: null }, {}) as any;
    assert.equal(out.content.length, 1);
    assert.equal(out.content[0].type, "text");
  });
});

describe("anthropicStopReason", () => {
  it("映射 finish reason", () => {
    assert.equal(anthropicStopReason("stop", false), "end_turn");
    assert.equal(anthropicStopReason("length", false), "max_tokens");
    assert.equal(anthropicStopReason("content_filter", false), "refusal");
    assert.equal(anthropicStopReason("tool_calls", false), "tool_use");
    assert.equal(anthropicStopReason(null, false), "end_turn");
    // 有工具调用时一律 tool_use，无论上游报什么。
    assert.equal(anthropicStopReason("stop", true), "tool_use");
  });
});

describe("Anthropic SSE 事件序列", () => {
  it("按 SDK 期望的顺序与 index 组装", () => {
    const events = [
      ...anthropicStreamStart("msg_1", "m"),
      anthropicTextBlockStart(0),
      anthropicTextDelta(0, "he"),
      anthropicTextDelta(0, "llo"),
      anthropicBlockStop(0),
      ...anthropicStreamEnd("end_turn", { inputTokens: 1, outputTokens: 2 }),
    ];
    assert.deepEqual(
      events.map((e) => e.event),
      [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ],
    );
    const start = events[0]!.data as any;
    assert.equal(start.message.id, "msg_1");
    assert.equal(start.message.role, "assistant");
    const end = events[5]!.data as any;
    assert.equal(end.delta.stop_reason, "end_turn");
    assert.deepEqual(end.usage, { input_tokens: 1, output_tokens: 2 });
  });

  it("thinking 是独立块类型，不与正文混流", () => {
    const start = anthropicThinkingBlockStart(0).data as any;
    assert.equal(start.content_block.type, "thinking");
    const delta = anthropicThinkingDelta(0, "why").data as any;
    // 混进 text_delta 会把思维链塞进可见回答里。
    assert.equal(delta.delta.type, "thinking_delta");
    assert.equal(delta.delta.thinking, "why");
    assert.equal((anthropicTextDelta(0, "x").data as any).delta.type, "text_delta");
  });

  it("tool_use 以 start + input_json_delta + stop 三段发出", () => {
    const events = anthropicToolUseEvents(2, {
      id: "c1",
      type: "function",
      function: { name: "ls", arguments: '{"p":"/"}' },
    });
    assert.deepEqual(events.map((e) => e.event), [
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
    ]);
    const startData = events[0]!.data as any;
    assert.equal(startData.index, 2);
    assert.equal(startData.content_block.name, "ls");
    const deltaData = events[1]!.data as any;
    assert.equal(deltaData.delta.type, "input_json_delta");
    assert.equal(deltaData.delta.partial_json, '{"p":"/"}');
  });

  it("SSE 帧带 event 名（Anthropic 每个事件都有名字）", () => {
    const frame = anthropicSse(anthropicTextDelta(0, "x"));
    assert.match(frame, /^event: content_block_delta\n/);
    assert.match(frame, /\ndata: \{.*\}\n\n$/s);
  });

  it("错误信封符合 Anthropic 形状", () => {
    const body = anthropicErrorBody("boom", "api_error") as any;
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "api_error");
    assert.equal(body.error.message, "boom");
  });
});
