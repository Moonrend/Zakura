import type {
  ModelChatInvokeOptions,
  ModelChatMessage,
  ModelChatResult,
  ModelToolCall,
} from "@zakura/shared";
import {
  parseDataUri,
  type ChatStreamCallbacks,
  type ModelProtocolAdapter,
} from "../adapter.js";
import { apiError, httpJson, httpSse } from "../http.js";
import { acceptsImageInput, imageOmittedText } from "../media.js";
import { buildOpenAIChatCompletion, toModelChatResult } from "../openai-response.js";
import { applyReasoningOptions } from "../reasoning.js";
import type { ResolvedRoute } from "../types.js";

function apiKey(route: ResolvedRoute): string {
  const key = route.upstream.config.apiKey;
  if (!key) throw new Error("Anthropic 上游需要配置 apiKey");
  return key;
}

function timeout(route: ResolvedRoute): number {
  return route.upstream.config.timeoutMs ?? 60000;
}

function version(route: ResolvedRoute): string {
  return route.upstream.config.anthropicVersion ?? "2023-06-01";
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | {
      type: "image";
      source:
        | { type: "base64"; media_type: string; data: string }
        | { type: "url"; url: string };
    };

function toAnthropicMessages(route: ResolvedRoute, messages: ModelChatMessage[]): {
  system?: string;
  messages: Array<{ role: string; content: string | AnthropicContentBlock[] }>;
} {
  const systemParts: string[] = [];
  const out: Array<{ role: string; content: string | AnthropicContentBlock[] }> = [];
  const supportsImage = acceptsImageInput(route);

  for (const m of messages) {
    if (m.role === "system") {
      if (m.content) systemParts.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId ?? "unknown",
            content: m.content ?? "",
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          input = { raw: tc.function.arguments };
        }
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    // 多模态：user 消息带 parts 时转 content blocks
    if (m.role === "user" && m.parts?.length) {
      const blocks: AnthropicContentBlock[] = [];
      for (const p of m.parts) {
        if (p.type === "text") {
          if (p.text) blocks.push({ type: "text", text: p.text });
          continue;
        }
        if (!supportsImage) {
          blocks.push({ type: "text", text: imageOmittedText() });
          continue;
        }
        const dataUri = parseDataUri(p.imageUrl.url);
        blocks.push({
          type: "image",
          source: dataUri
            ? { type: "base64", media_type: dataUri.mimeType, data: dataUri.base64 }
            : { type: "url", url: p.imageUrl.url },
        });
      }
      if (blocks.length) {
        out.push({ role: "user", content: blocks });
        continue;
      }
    }

    out.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content ?? "",
    });
  }

  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: out,
  };
}

function mapTools(options?: ModelChatInvokeOptions) {
  if (!options?.tools?.length) return undefined;
  return options.tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters ?? { type: "object", properties: {} },
  }));
}

function mapToolChoice(options?: ModelChatInvokeOptions) {
  const tc = options?.toolChoice;
  if (!tc || tc === "auto") return undefined;
  if (tc === "none") return { type: "none" as const };
  if (tc === "required") return { type: "any" as const };
  if (typeof tc === "object" && tc.type === "function") {
    return { type: "tool" as const, name: tc.function.name };
  }
  return undefined;
}

const FINISH_MAP: Record<string, string> = {
  end_turn: "stop",
  max_tokens: "length",
  stop_sequence: "stop",
  tool_use: "tool_calls",
};

function buildBody(
  route: ResolvedRoute,
  messages: ModelChatMessage[],
  options?: ModelChatInvokeOptions,
): Record<string, unknown> {
  const mapped = toAnthropicMessages(route, messages);
  const body: Record<string, unknown> = {
    model: route.model,
    max_tokens: route.options.maxTokens ?? 4096,
    messages: mapped.messages,
  };
  if (mapped.system) body.system = mapped.system;
  if (route.options.temperature != null) body.temperature = route.options.temperature;

  const tools = mapTools(options);
  if (tools) body.tools = tools;
  const toolChoice = mapToolChoice(options);
  if (toolChoice) body.tool_choice = toolChoice;
  applyReasoningOptions(route.upstream.protocol, body, route.options);
  if (options?.extensions) Object.assign(body, options.extensions);
  return body;
}

function buildRequestHeaders(route: ResolvedRoute): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey(route),
    "anthropic-version": version(route),
    ...(route.upstream.config.extraHeaders ?? {}),
  };
}

async function chat(
  route: ResolvedRoute,
  messages: ModelChatMessage[],
  options?: ModelChatInvokeOptions,
): Promise<ModelChatResult> {
  const body = buildBody(route, messages, options);
  const url = `${route.upstream.config.baseUrl}/messages`;
  const res = await httpJson<{
    id?: string;
    content?: Array<{
      type?: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
    stop_reason?: string;
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  }>(url, {
    method: "POST",
    headers: { ...buildRequestHeaders(route), Accept: "application/json" },
    body: JSON.stringify(body),
    timeoutMs: timeout(route),
  });
  if (!res.ok) throw apiError("anthropic chat", res.status, res.data, res.text);

  const blocks = res.data?.content ?? [];
  const textParts: string[] = [];
  const toolCalls: ModelChatResult["toolCalls"] = [];
  for (const b of blocks) {
    if (b.type === "text" && b.text) textParts.push(b.text);
    if (b.type === "tool_use" && b.name && b.id) {
      toolCalls!.push({
        id: b.id,
        type: "function",
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        },
      });
    }
  }

  const finishReason = res.data?.stop_reason
    ? (FINISH_MAP[res.data.stop_reason] ?? res.data.stop_reason)
    : toolCalls!.length
      ? "tool_calls"
      : "stop";

  const openai = buildOpenAIChatCompletion({
    id: res.data?.id,
    model: res.data?.model ?? route.model,
    content: textParts.join("") || null,
    toolCalls: toolCalls!.length ? toolCalls : undefined,
    finishReason,
    usage: res.data?.usage
      ? {
          promptTokens: res.data.usage.input_tokens,
          completionTokens: res.data.usage.output_tokens,
          totalTokens:
            (res.data.usage.input_tokens ?? 0) + (res.data.usage.output_tokens ?? 0),
        }
      : undefined,
  });

  return toModelChatResult(openai, res.data);
}

/** Anthropic Messages 流式事件的累积状态 */
export type AnthropicStreamState = {
  model: string | null;
  text: string;
  reasoning: string;
  /** content block index → 工具调用累积 */
  tools: Map<number, { id: string; name: string; args: string }>;
  thinkingBlocks: Set<number>;
  stopReason: string | null;
  inputTokens?: number;
  outputTokens?: number;
};

export function createAnthropicStreamState(): AnthropicStreamState {
  return {
    model: null,
    text: "",
    reasoning: "",
    tools: new Map(),
    thinkingBlocks: new Set(),
    stopReason: null,
  };
}

/**
 * 吸收一条流式事件（message_start / content_block_* / message_delta …）。
 * 返回本事件新增的文本增量；error 事件抛出异常。
 */
export function absorbAnthropicStreamEvent(
  state: AnthropicStreamState,
  event: unknown,
): { content: string; reasoning: string } {
  const empty = { content: "", reasoning: "" };
  if (!event || typeof event !== "object") return empty;
  const ev = event as {
    type?: string;
    message?: { model?: string; usage?: { input_tokens?: number } };
    index?: number;
    content_block?: { type?: string; id?: string; name?: string; thinking?: string };
    delta?: {
      type?: string;
      text?: string;
      thinking?: string;
      partial_json?: string;
      stop_reason?: string;
    };
    usage?: { output_tokens?: number };
    error?: { message?: string };
  };
  switch (ev.type) {
    case "message_start":
      if (ev.message?.model) state.model = ev.message.model;
      if (ev.message?.usage?.input_tokens != null) {
        state.inputTokens = ev.message.usage.input_tokens;
      }
      return empty;
    case "content_block_start":
      if (ev.content_block?.type === "tool_use" && ev.index != null) {
        state.tools.set(ev.index, {
          id: ev.content_block.id ?? `call_${ev.index}`,
          name: ev.content_block.name ?? "tool",
          args: "",
        });
      }
      if (ev.content_block?.type === "thinking" && ev.index != null) {
        state.thinkingBlocks.add(ev.index);
        if (ev.content_block.thinking) {
          state.reasoning += ev.content_block.thinking;
          return { content: "", reasoning: ev.content_block.thinking };
        }
      }
      return empty;
    case "content_block_delta": {
      const d = ev.delta;
      if (d?.type === "text_delta" && typeof d.text === "string") {
        state.text += d.text;
        return { content: d.text, reasoning: "" };
      }
      if (
        (d?.type === "thinking_delta" || state.thinkingBlocks.has(ev.index ?? -1)) &&
        typeof d?.thinking === "string"
      ) {
        state.reasoning += d.thinking;
        return { content: "", reasoning: d.thinking };
      }
      if (d?.type === "input_json_delta" && typeof d.partial_json === "string") {
        const slot = ev.index != null ? state.tools.get(ev.index) : undefined;
        if (slot) slot.args += d.partial_json;
      }
      return empty;
    }
    case "message_delta":
      if (ev.delta?.stop_reason) state.stopReason = ev.delta.stop_reason;
      if (ev.usage?.output_tokens != null) state.outputTokens = ev.usage.output_tokens;
      return empty;
    case "error":
      throw new Error(`anthropic stream error: ${ev.error?.message ?? "unknown"}`);
    default:
      return empty;
  }
}

export function anthropicStreamStateToResult(
  state: AnthropicStreamState,
  fallbackModel: string,
): ModelChatResult {
  const toolCalls: ModelToolCall[] = [...state.tools.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => ({
      id: t.id,
      type: "function" as const,
      function: { name: t.name, arguments: t.args || "{}" },
    }));
  const finishReason = state.stopReason
    ? (FINISH_MAP[state.stopReason] ?? state.stopReason)
    : toolCalls.length
      ? "tool_calls"
      : "stop";
  const openai = buildOpenAIChatCompletion({
    model: state.model ?? fallbackModel,
    content: state.text || null,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason,
    usage:
      state.inputTokens != null || state.outputTokens != null
        ? {
            promptTokens: state.inputTokens,
            completionTokens: state.outputTokens,
            totalTokens: (state.inputTokens ?? 0) + (state.outputTokens ?? 0),
          }
        : undefined,
  });
  return toModelChatResult(openai);
}

async function chatStream(
  route: ResolvedRoute,
  messages: ModelChatMessage[],
  options: ModelChatInvokeOptions | undefined,
  callbacks: ChatStreamCallbacks,
): Promise<ModelChatResult> {
  const body = { ...buildBody(route, messages, options), stream: true };
  const state = createAnthropicStreamState();
  await httpSse(
    "anthropic chat(stream)",
    `${route.upstream.config.baseUrl}/messages`,
    {
      method: "POST",
      headers: { ...buildRequestHeaders(route), Accept: "text/event-stream" },
      body: JSON.stringify(body),
      timeoutMs: timeout(route),
      ...(callbacks.signal ? { signal: callbacks.signal } : {}),
    },
    (payload) => {
      let event: unknown;
      try {
        event = JSON.parse(payload);
      } catch {
        return;
      }
      const delta = absorbAnthropicStreamEvent(state, event);
      if (delta.reasoning) callbacks.onReasoningDelta?.(delta.reasoning);
      if (delta.content) callbacks.onDelta?.(delta.content);
    },
  );
  return anthropicStreamStateToResult(state, route.model);
}

export const anthropicAdapter: ModelProtocolAdapter = {
  protocol: "anthropic",
  supportedCapabilities: ["chat"],
  chat,
  chatStream,
};
