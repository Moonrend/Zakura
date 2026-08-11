/**
 * OpenAI Responses API：tool_search 官方路径。
 * 失败时由调用方回退 Chat Completions。
 *
 * @see https://developers.openai.com/api/docs/guides/tools-tool-search
 */
import { createId } from "@paralleldrive/cuid2";
import type {
  ModelChatMessage,
  ModelChatResult,
  ModelToolCall,
  ModelToolChoice,
} from "@zakura/shared";
import { apiError, buildHeaders, httpJson, httpSse } from "./http.js";
import {
  buildOpenAIChatCompletion,
  toModelChatResult,
} from "./openai-response.js";
import type { ChatStreamCallbacks } from "./adapter.js";
import type { ResolvedRoute } from "./types.js";

export function responsesUrl(route: ResolvedRoute): string {
  const { config, protocol } = route.upstream;
  if (protocol === "azure-openai") {
    const deployment = config.deploymentId ?? route.model;
    const ver = config.apiVersion ?? "2024-08-01-preview";
    return `${config.baseUrl}/openai/deployments/${encodeURIComponent(deployment)}/responses?api-version=${encodeURIComponent(ver)}`;
  }
  return `${config.baseUrl}/responses`;
}

function timeout(route: ResolvedRoute): number {
  return route.upstream.config.timeoutMs ?? 60000;
}

/** Chat messages → Responses `input` + 可选 `instructions` */
export function mapMessagesToResponsesInput(messages: ModelChatMessage[]): {
  instructions?: string;
  input: unknown[];
} {
  const instructionsParts: string[] = [];
  const input: unknown[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content === "string" && m.content) instructionsParts.push(m.content);
      continue;
    }
    if (m.role === "user") {
      if (m.parts?.length) {
        const content = m.parts.map((p) => {
          if (p.type === "image_url") {
            return { type: "input_image", image_url: p.imageUrl.url };
          }
          return { type: "input_text", text: p.text };
        });
        input.push({ role: "user", content });
      } else {
        input.push({ role: "user", content: m.content ?? "" });
      }
      continue;
    }
    if (m.role === "assistant") {
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments || "{}",
          });
        }
      }
      if (m.content) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: m.content }],
        });
      }
      continue;
    }
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.toolCallId ?? "",
        output: m.content ?? "",
      });
    }
  }

  const instructions = instructionsParts.length
    ? instructionsParts.join("\n\n")
    : undefined;
  return { ...(instructions ? { instructions } : {}), input };
}

function mapToolChoice(toolChoice: ModelToolChoice | undefined): unknown {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return toolChoice;
  }
  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    return { type: "function", name: toolChoice.function.name };
  }
  return undefined;
}

export function parseResponsesOutput(data: {
  id?: string;
  created_at?: number;
  model?: string;
  output?: Array<Record<string, unknown>>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}): {
  content: string | null;
  toolCalls?: ModelToolCall[];
  finishReason: string;
} {
  const output = data.output ?? [];
  const textParts: string[] = [];
  const toolCalls: ModelToolCall[] = [];

  for (const item of output) {
    const type = String(item.type ?? "");
    // hosted tool_search 中间态：忽略，等真正的 function_call
    if (type === "tool_search_call" || type === "tool_search_output") continue;
    if (type === "message") {
      const content = item.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          const p = part as { type?: string; text?: string };
          if ((p.type === "output_text" || p.type === "text") && typeof p.text === "string") {
            textParts.push(p.text);
          }
        }
      } else if (typeof content === "string") {
        textParts.push(content);
      }
      continue;
    }
    if (type === "function_call") {
      const name = typeof item.name === "string" ? item.name : "";
      if (!name) continue;
      const callId =
        (typeof item.call_id === "string" && item.call_id) ||
        (typeof item.id === "string" && item.id) ||
        `call_${createId()}`;
      const args =
        typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments ?? {});
      toolCalls.push({
        id: callId,
        type: "function",
        function: { name, arguments: args },
      });
    }
  }

  const content = textParts.length ? textParts.join("") : null;
  return {
    content,
    ...(toolCalls.length ? { toolCalls } : {}),
    finishReason: toolCalls.length ? "tool_calls" : "stop",
  };
}

export async function responsesChat(
  route: ResolvedRoute,
  messages: ModelChatMessage[],
  packedTools: unknown[],
  options?: {
    toolChoice?: ModelToolChoice;
    temperature?: number;
    maxTokens?: number;
  },
): Promise<ModelChatResult> {
  const mapped = mapMessagesToResponsesInput(messages);
  const body: Record<string, unknown> = {
    model: route.model,
    ...mapped,
    tools: packedTools,
  };
  if (options?.temperature != null) body.temperature = options.temperature;
  if (options?.maxTokens != null) body.max_output_tokens = options.maxTokens;
  const tc = mapToolChoice(options?.toolChoice);
  if (tc !== undefined) body.tool_choice = tc;

  const res = await httpJson<{
    id?: string;
    created_at?: number;
    model?: string;
    output?: Array<Record<string, unknown>>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
    error?: { message?: string };
  }>(responsesUrl(route), {
    method: "POST",
    headers: buildHeaders(route.upstream.config, route.upstream.protocol),
    body: JSON.stringify(body),
    timeoutMs: timeout(route),
  });
  if (!res.ok) throw apiError("responses", res.status, res.data, res.text);

  const parsed = parseResponsesOutput(res.data ?? {});
  const openai = buildOpenAIChatCompletion({
    id: res.data?.id,
    created: res.data?.created_at,
    model: res.data?.model ?? route.model,
    content: parsed.content,
    toolCalls: parsed.toolCalls,
    finishReason: parsed.finishReason,
    usage: res.data?.usage
      ? {
          promptTokens: res.data.usage.input_tokens,
          completionTokens: res.data.usage.output_tokens,
          totalTokens: res.data.usage.total_tokens,
        }
      : undefined,
  });
  return toModelChatResult(openai, res.data);
}

type ResponsesStreamState = {
  content: string;
  toolCalls: Map<
    number,
    { id: string; name: string; arguments: string }
  >;
  /** call_id → slot for argument deltas that key by item id */
  byItemId: Map<string, { id: string; name: string; arguments: string }>;
  finishReason: string | null;
  model: string | null;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
};

/**
 * Responses SSE：尽量兼容常见 event/data 形态；解析失败则抛错让上层回退 Chat。
 */
export async function responsesChatStream(
  route: ResolvedRoute,
  messages: ModelChatMessage[],
  packedTools: unknown[],
  options: {
    toolChoice?: ModelToolChoice;
    temperature?: number;
    maxTokens?: number;
  } | undefined,
  callbacks: ChatStreamCallbacks,
): Promise<ModelChatResult> {
  const mapped = mapMessagesToResponsesInput(messages);
  const body: Record<string, unknown> = {
    model: route.model,
    ...mapped,
    tools: packedTools,
    stream: true,
  };
  if (options?.temperature != null) body.temperature = options.temperature;
  if (options?.maxTokens != null) body.max_output_tokens = options.maxTokens;
  const tc = mapToolChoice(options?.toolChoice);
  if (tc !== undefined) body.tool_choice = tc;

  const state: ResponsesStreamState = {
    content: "",
    toolCalls: new Map(),
    byItemId: new Map(),
    finishReason: null,
    model: null,
  };

  let stopped = false;
  await httpSse(
    "responses(stream)",
    responsesUrl(route),
    {
      method: "POST",
      headers: {
        ...buildHeaders(route.upstream.config, route.upstream.protocol),
        Accept: "text/event-stream",
      },
      ...(callbacks.signal ? { signal: callbacks.signal } : {}),
      body: JSON.stringify(body),
      timeoutMs: timeout(route),
    },
    (payload) => {
      if (stopped) return;
      if (payload === "[DONE]") {
        stopped = true;
        return false;
      }
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return;
      }
      absorbResponsesStreamEvent(state, chunk, callbacks);
    },
  );

  const toolCalls = [...state.toolCalls.values(), ...state.byItemId.values()].filter(
    (t) => t.name.trim(),
  );
  // dedupe by id
  const seen = new Set<string>();
  const unique = toolCalls.filter((t) => {
    const key = t.id || t.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const mappedCalls = unique.length
    ? unique.map((t, i) => ({
        id: t.id || `call_${i}`,
        type: "function" as const,
        function: { name: t.name, arguments: t.arguments || "{}" },
      }))
    : undefined;

  const openai = buildOpenAIChatCompletion({
    model: state.model ?? route.model,
    content: state.content || null,
    toolCalls: mappedCalls,
    finishReason:
      state.finishReason ?? (mappedCalls?.length ? "tool_calls" : "stop"),
    usage: state.usage,
  });
  return toModelChatResult(openai);
}

function absorbResponsesStreamEvent(
  state: ResponsesStreamState,
  chunk: unknown,
  callbacks: ChatStreamCallbacks,
): void {
  if (!chunk || typeof chunk !== "object") return;
  const ev = chunk as Record<string, unknown>;
  const type = typeof ev.type === "string" ? ev.type : "";

  if (typeof ev.model === "string" && ev.model) state.model = ev.model;

  // Chat Completions 风格误路由时也能吃
  if (Array.isArray((ev as { choices?: unknown }).choices)) {
    const choice = (ev as { choices: Array<{ delta?: { content?: string } }> }).choices[0];
    const delta = choice?.delta?.content;
    if (typeof delta === "string" && delta) {
      state.content += delta;
      callbacks.onDelta?.(delta);
    }
    return;
  }

  if (type === "response.output_text.delta" || type === "response.text.delta") {
    const delta = typeof ev.delta === "string" ? ev.delta : "";
    if (delta) {
      state.content += delta;
      callbacks.onDelta?.(delta);
    }
    return;
  }

  if (type === "response.output_item.added") {
    const item = ev.item as Record<string, unknown> | undefined;
    if (!item || item.type !== "function_call") return;
    const name = typeof item.name === "string" ? item.name : "";
    const callId =
      (typeof item.call_id === "string" && item.call_id) ||
      (typeof item.id === "string" && item.id) ||
      `call_${createId()}`;
    const slot = { id: callId, name, arguments: "" };
    if (typeof item.id === "string") state.byItemId.set(item.id, slot);
    const idx = state.toolCalls.size;
    state.toolCalls.set(idx, slot);
    return;
  }

  if (
    type === "response.function_call_arguments.delta" ||
    type === "response.output_item.function_call_arguments.delta"
  ) {
    const delta = typeof ev.delta === "string" ? ev.delta : "";
    const itemId = typeof ev.item_id === "string" ? ev.item_id : "";
    const outputIndex = typeof ev.output_index === "number" ? ev.output_index : undefined;
    let slot =
      (itemId && state.byItemId.get(itemId)) ||
      (outputIndex != null ? state.toolCalls.get(outputIndex) : undefined);
    if (!slot && state.toolCalls.size) {
      slot = [...state.toolCalls.values()].at(-1);
    }
    if (slot && delta) slot.arguments += delta;
    return;
  }

  if (type === "response.completed" || type === "response.done") {
    const resp = (ev.response as Record<string, unknown> | undefined) ?? ev;
    if (resp && typeof resp === "object") {
      const parsed = parseResponsesOutput({
        output: Array.isArray(resp.output)
          ? (resp.output as Array<Record<string, unknown>>)
          : undefined,
        usage: resp.usage as
          | {
              input_tokens?: number;
              output_tokens?: number;
              total_tokens?: number;
            }
          | undefined,
        model: typeof resp.model === "string" ? resp.model : undefined,
      });
      if (parsed.content && !state.content) {
        state.content = parsed.content;
        callbacks.onDelta?.(parsed.content);
      }
      if (parsed.toolCalls?.length && state.toolCalls.size === 0 && state.byItemId.size === 0) {
        parsed.toolCalls.forEach((tc, i) => {
          state.toolCalls.set(i, {
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        });
      }
      if (resp.usage && typeof resp.usage === "object") {
        const u = resp.usage as {
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
        };
        state.usage = {
          promptTokens: u.input_tokens,
          completionTokens: u.output_tokens,
          totalTokens: u.total_tokens,
        };
      }
    }
    state.finishReason =
      state.toolCalls.size || state.byItemId.size ? "tool_calls" : "stop";
  }
}
