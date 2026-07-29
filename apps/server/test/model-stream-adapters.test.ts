import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  absorbAnthropicStreamEvent,
  anthropicStreamStateToResult,
  createAnthropicStreamState,
} from "../src/model-router/adapters/anthropic.js";
import {
  absorbGeminiStreamChunk,
  createGeminiStreamState,
  geminiStreamStateToResult,
} from "../src/model-router/adapters/gemini.js";

describe("anthropic stream accumulation", () => {
  it("accumulates text, tool_use blocks and usage", () => {
    const state = createAnthropicStreamState();
    absorbAnthropicStreamEvent(state, {
      type: "message_start",
      message: { model: "claude-sonnet-5", usage: { input_tokens: 42 } },
    });
    assert.equal(
      absorbAnthropicStreamEvent(state, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "查一下" },
      }).content,
      "查一下",
    );
    absorbAnthropicStreamEvent(state, {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "web_search" },
    });
    absorbAnthropicStreamEvent(state, {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"q":' },
    });
    absorbAnthropicStreamEvent(state, {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '"东京天气"}' },
    });
    absorbAnthropicStreamEvent(state, {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 7 },
    });

    const result = anthropicStreamStateToResult(state, "fallback");
    assert.equal(result.content, "查一下");
    assert.equal(result.model, "claude-sonnet-5");
    assert.equal(result.finishReason, "tool_calls");
    assert.equal(result.toolCalls?.length, 1);
    assert.equal(result.toolCalls?.[0]?.id, "toolu_1");
    assert.equal(result.toolCalls?.[0]?.function.name, "web_search");
    assert.equal(result.toolCalls?.[0]?.function.arguments, '{"q":"东京天气"}');
    assert.equal(result.usage?.promptTokens, 42);
    assert.equal(result.usage?.completionTokens, 7);
    assert.equal(result.usage?.totalTokens, 49);
  });

  it("maps end_turn to stop and throws on error events", () => {
    const state = createAnthropicStreamState();
    absorbAnthropicStreamEvent(state, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "好的" },
    });
    absorbAnthropicStreamEvent(state, {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    });
    const result = anthropicStreamStateToResult(state, "m");
    assert.equal(result.finishReason, "stop");
    assert.equal(result.content, "好的");

    assert.throws(() =>
      absorbAnthropicStreamEvent(createAnthropicStreamState(), {
        type: "error",
        error: { message: "overloaded" },
      }),
    );
  });

  it("accumulates thinking deltas separately", () => {
    const state = createAnthropicStreamState();
    absorbAnthropicStreamEvent(state, {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking" },
    });
    assert.deepEqual(
      absorbAnthropicStreamEvent(state, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "先分析" },
      }),
      { content: "", reasoning: "先分析" },
    );
    assert.equal(state.reasoning, "先分析");
  });
});

describe("gemini stream accumulation", () => {
  it("accumulates text, function calls and usage", () => {
    const state = createGeminiStreamState();
    assert.equal(
      absorbGeminiStreamChunk(state, {
        candidates: [{ content: { parts: [{ text: "让我" }] } }],
      }).content,
      "让我",
    );
    absorbGeminiStreamChunk(state, {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: "fs_read", args: { path: "a.txt" } } }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
    });

    const result = geminiStreamStateToResult(state, "gemini-pro");
    assert.equal(result.content, "让我");
    assert.equal(result.toolCalls?.length, 1);
    assert.equal(result.toolCalls?.[0]?.function.name, "fs_read");
    assert.equal(result.toolCalls?.[0]?.function.arguments, '{"path":"a.txt"}');
    assert.equal(result.finishReason, "stop");
    assert.equal(result.usage?.totalTokens, 8);
  });

  it("keeps thought parts out of answer text", () => {
    const state = createGeminiStreamState();
    assert.deepEqual(
      absorbGeminiStreamChunk(state, {
        candidates: [{ content: { parts: [{ text: "先想", thought: true }] } }],
      }),
      { content: "", reasoning: "先想" },
    );
    absorbGeminiStreamChunk(state, {
      candidates: [{ content: { parts: [{ text: "答案" }] } }],
    });
    assert.equal(state.reasoning, "先想");
    assert.equal(state.text, "答案");
  });

  it("throws on error payloads", () => {
    assert.throws(() =>
      absorbGeminiStreamChunk(createGeminiStreamState(), {
        error: { message: "quota" },
      }),
    );
  });
});
