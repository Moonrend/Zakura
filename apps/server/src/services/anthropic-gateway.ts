/**
 * Anthropic Messages API (`POST /v1/messages`) as an inbound protocol.
 *
 * The gateway already speaks OpenAI Chat Completions and the Responses API. A large
 * amount of tooling (the Anthropic SDKs, Claude Code, and anything pointed at
 * `ANTHROPIC_BASE_URL`) only speaks Messages, so exposing it removes the need for a
 * shim on the client side.
 *
 * This module is pure translation in both directions — Messages request → the
 * internal `OpenAiGatewayBody`, and `ModelChatResult` → a Messages response or SSE
 * stream. It holds no state and does no I/O, which keeps it directly testable.
 *
 * Reference: https://docs.anthropic.com/en/api/messages
 */
import { randomUUID } from "node:crypto";
import type { ModelChatResult, ModelToolCall } from "@zakura/shared";
import type { OpenAiGatewayBody } from "./openai-gateway.js";

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

export function anthropicMessageId(): string {
  return `msg_${randomUUID().replace(/-/g, "")}`;
}

/**
 * Flatten Anthropic content (string, or an array of typed blocks) into the shape
 * Chat Completions expects.
 *
 * `tool_result` blocks are the interesting case: Anthropic carries them as user
 * content, while Chat Completions models them as a separate `role: "tool"` message
 * keyed by id. They are therefore lifted out rather than inlined, otherwise the
 * model loses the link between a call and its result.
 */
function convertUserContent(content: unknown): {
  parts: Array<RawRecord>;
  toolResults: Array<{ tool_call_id: string; content: string }>;
} {
  const parts: Array<RawRecord> = [];
  const toolResults: Array<{ tool_call_id: string; content: string }> = [];

  if (typeof content === "string") {
    if (content) parts.push({ type: "text", text: content });
    return { parts, toolResults };
  }
  if (!Array.isArray(content)) return { parts, toolResults };

  for (const raw of content) {
    const block = asRecord(raw);
    if (!block) continue;
    switch (block.type) {
      case "text":
        if (typeof block.text === "string" && block.text) {
          parts.push({ type: "text", text: block.text });
        }
        break;
      case "image": {
        const source = asRecord(block.source);
        if (!source) break;
        if (source.type === "base64" && typeof source.data === "string") {
          const media = typeof source.media_type === "string" ? source.media_type : "image/png";
          parts.push({
            type: "image_url",
            image_url: { url: `data:${media};base64,${source.data}` },
          });
        } else if (source.type === "url" && typeof source.url === "string") {
          parts.push({ type: "image_url", image_url: { url: source.url } });
        }
        break;
      }
      case "tool_result": {
        const id = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
        if (!id) break;
        toolResults.push({ tool_call_id: id, content: stringifyToolResult(block.content) });
        break;
      }
      default:
        // Unknown block types are dropped rather than passed through: sending an
        // unrecognised shape downstream fails less clearly than omitting it.
        break;
    }
  }
  return { parts, toolResults };
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((raw) => {
        const block = asRecord(raw);
        if (block && block.type === "text" && typeof block.text === "string") return block.text;
        return block ? JSON.stringify(block) : "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  return content === undefined ? "" : JSON.stringify(content);
}

/** Assistant turns may carry `tool_use` blocks, which become `tool_calls`. */
function convertAssistantContent(content: unknown): {
  text: string;
  toolCalls: Array<RawRecord>;
} {
  if (typeof content === "string") return { text: content, toolCalls: [] };
  if (!Array.isArray(content)) return { text: "", toolCalls: [] };

  const chunks: string[] = [];
  const toolCalls: Array<RawRecord> = [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      chunks.push(block.text);
    } else if (block.type === "tool_use") {
      const id = typeof block.id === "string" ? block.id : `call_${randomUUID()}`;
      const name = typeof block.name === "string" ? block.name : "";
      if (!name) continue;
      toolCalls.push({
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  return { text: chunks.join(""), toolCalls };
}

/** Anthropic `system` accepts a string or an array of text blocks. */
export function anthropicSystemToText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .map((raw) => {
      const block = asRecord(raw);
      return block && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function convertTools(tools: unknown): Array<RawRecord> | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: Array<RawRecord> = [];
  for (const raw of tools) {
    const tool = asRecord(raw);
    if (!tool || typeof tool.name !== "string") continue;
    // Anthropic server-side tools (web_search etc.) carry a `type` and no
    // input_schema; they are not function tools and cannot be forwarded.
    if (typeof tool.type === "string" && !tool.input_schema) continue;
    out.push({
      type: "function",
      function: {
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    });
  }
  return out.length ? out : undefined;
}

function convertToolChoice(choice: unknown): unknown {
  const rec = asRecord(choice);
  if (!rec) return undefined;
  switch (rec.type) {
    case "auto":
      return "auto";
    case "any":
      // Closest Chat Completions equivalent to "must use some tool".
      return "required";
    case "none":
      return "none";
    case "tool":
      return typeof rec.name === "string"
        ? { type: "function", function: { name: rec.name } }
        : "auto";
    default:
      return undefined;
  }
}

/** Translate a Messages request into the gateway's internal Chat Completions shape. */
export function translateAnthropicRequest(raw: unknown): OpenAiGatewayBody {
  const body = asRecord(raw) ?? {};
  const messages: Array<RawRecord> = [];

  const system = anthropicSystemToText(body.system);
  if (system) messages.push({ role: "system", content: system });

  const input = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of input) {
    const message = asRecord(raw);
    if (!message) continue;
    const role = message.role;

    if (role === "assistant") {
      const { text, toolCalls } = convertAssistantContent(message.content);
      messages.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // user (default)
    const { parts, toolResults } = convertUserContent(message.content);
    // Tool results must precede the next user text, mirroring the order the model
    // saw them in the Anthropic transcript.
    for (const result of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: result.tool_call_id,
        content: result.content,
      });
    }
    if (parts.length) {
      const onlyText = parts.every((p) => p.type === "text");
      messages.push({
        role: "user",
        content: onlyText ? parts.map((p) => String(p.text ?? "")).join("") : parts,
      });
    }
  }

  const tools = convertTools(body.tools);
  const toolChoice = convertToolChoice(body.tool_choice);
  const thinking = asRecord(body.thinking);

  return {
    messages,
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(body.stream === true ? { stream: true } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
    // `max_tokens` is required by Anthropic and optional downstream; pass it through.
    ...(typeof body.max_tokens === "number" ? { max_tokens: body.max_tokens } : {}),
    ...(Array.isArray(body.stop_sequences) ? { stop: body.stop_sequences } : {}),
    ...(typeof body.metadata === "object" && body.metadata ? { metadata: body.metadata } : {}),
    // Extended thinking maps onto the router's reasoning effort. Budget is a token
    // count, so bucket it rather than inventing a scale.
    ...(thinking?.type === "enabled"
      ? { reasoning_effort: thinkingEffort(thinking.budget_tokens) }
      : {}),
  };
}

function thinkingEffort(budget: unknown): "low" | "medium" | "high" {
  const tokens = typeof budget === "number" ? budget : 0;
  if (tokens >= 16_000) return "high";
  if (tokens >= 4_000) return "medium";
  return "low";
}

/** Chat Completions finish reasons → Anthropic stop reasons. */
export function anthropicStopReason(
  finishReason: string | null | undefined,
  hasToolCalls: boolean,
): string {
  if (hasToolCalls) return "tool_use";
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "stop":
      return "end_turn";
    case "content_filter":
      return "refusal";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return "end_turn";
  }
}

function toolUseBlocks(toolCalls: ModelToolCall[] | undefined): Array<RawRecord> {
  if (!toolCalls?.length) return [];
  return toolCalls.map((call) => ({
    type: "tool_use",
    id: call.id,
    name: call.function.name,
    input: parseArguments(call.function.arguments),
  }));
}

function parseArguments(args: string | undefined): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    // Anthropic `input` must be an object; surface the raw text rather than
    // dropping the arguments entirely.
    return { _raw: args };
  }
}

/** Build a non-streaming Messages response from a router result. */
export function translateAnthropicResponse(
  result: ModelChatResult,
  opts: { id?: string; model?: string } = {},
): RawRecord {
  const blocks: Array<RawRecord> = [];
  if (result.content) blocks.push({ type: "text", text: result.content });
  blocks.push(...toolUseBlocks(result.toolCalls));

  const inputTokens = result.usage?.promptTokens ?? 0;
  const outputTokens = result.usage?.completionTokens ?? 0;

  return {
    id: opts.id ?? anthropicMessageId(),
    type: "message",
    role: "assistant",
    model: opts.model ?? result.model,
    // An empty content array is valid but unhelpful; keep at least one block so
    // clients that index [0] do not fault.
    content: blocks.length ? blocks : [{ type: "text", text: "" }],
    stop_reason: anthropicStopReason(result.finishReason, Boolean(result.toolCalls?.length)),
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

export type AnthropicSseEvent = { event: string; data: RawRecord };

/**
 * The fixed preamble of a Messages stream.
 *
 * Anthropic's stream is a strict event sequence, not a series of interchangeable
 * chunks: clients rely on `message_start` → `content_block_start` →
 * `content_block_delta`* → `content_block_stop` → `message_delta` →
 * `message_stop`, with `index` monotonically increasing across blocks. Emitting
 * these out of order breaks the official SDKs, so the sequence is assembled here
 * rather than ad hoc at the route.
 */
export function anthropicStreamStart(id: string, model: string): AnthropicSseEvent[] {
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    },
  ];
}

export function anthropicTextBlockStart(index: number): AnthropicSseEvent {
  return {
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    },
  };
}

export function anthropicTextDelta(index: number, text: string): AnthropicSseEvent {
  return {
    event: "content_block_delta",
    data: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  };
}

/**
 * Reasoning maps to a `thinking` block, which is a distinct block type — not text.
 * Merging the two would put chain-of-thought into the visible answer.
 */
export function anthropicThinkingBlockStart(index: number): AnthropicSseEvent {
  return {
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "" },
    },
  };
}

export function anthropicThinkingDelta(index: number, text: string): AnthropicSseEvent {
  return {
    event: "content_block_delta",
    data: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text } },
  };
}

export function anthropicBlockStop(index: number): AnthropicSseEvent {
  return { event: "content_block_stop", data: { type: "content_block_stop", index } };
}

/** A tool call arrives whole from the router, so emit start + one full delta. */
export function anthropicToolUseEvents(
  index: number,
  call: ModelToolCall,
): AnthropicSseEvent[] {
  return [
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: call.id, name: call.function.name, input: {} },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          // Anthropic streams tool input as JSON text; clients accumulate and parse.
          partial_json: call.function.arguments || "{}",
        },
      },
    },
    anthropicBlockStop(index),
  ];
}

export function anthropicStreamEnd(
  stopReason: string,
  usage: { inputTokens: number; outputTokens: number },
): AnthropicSseEvent[] {
  return [
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

/** Anthropic error envelope. */
export function anthropicErrorBody(
  message: string,
  type = "invalid_request_error",
): RawRecord {
  return { type: "error", error: { type, message } };
}

/** Serialise an event as an SSE frame. Anthropic names every event. */
export function anthropicSse(event: AnthropicSseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
