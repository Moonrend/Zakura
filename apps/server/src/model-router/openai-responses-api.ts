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
  absorbChatStreamChunk,
  buildOpenAIChatCompletion,
  createChatStreamState,
  toModelChatResult,
  type ChatStreamState,
} from "./openai-response.js";
import type { ChatStreamCallbacks } from "./adapter.js";
import type { ResolvedRoute } from "./types.js";

export function responsesUrl(route: ResolvedRoute): string {
  const { config, protocol } = route.upstream;
  if (protocol === "codex") {
    return `${config.baseUrl}/backend-api/codex/responses`;
  }
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
export function mapMessagesToResponsesInput(
  messages: ModelChatMessage[],
  packedTools: unknown[] = [],
): {
  instructions?: string;
  input: unknown[];
} {
  const instructionsParts: string[] = [];
  const input: unknown[] = [];
  // Restore legacy calls and use the current namespace after sharding/overflow
  // packing. Flat functions must also clear any historical namespace.
  const namespaces = new Map<string, string | undefined>();
  for (const value of packedTools) {
    if (!value || typeof value !== "object") continue;
    const tool = value as { type?: string; name?: string; tools?: Array<{ name?: string }> };
    if (tool.type === "function" && tool.name) namespaces.set(tool.name, undefined);
    if (tool.type === "namespace" && tool.name && Array.isArray(tool.tools)) {
      for (const fn of tool.tools) {
        if (fn.name) namespaces.set(fn.name, tool.name);
      }
    }
  }

  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content === "string" && m.content) instructionsParts.push(m.content);
      continue;
    }
    if (m.role === "user") {
      if (m.parts?.length) {
        const content = m.parts.map((p) => {
          if (p.type === "image_url") {
            return { type: "input_image", image_url: p.imageUrl.url, ...(p.imageUrl.detail ? { detail: p.imageUrl.detail } : {}) };
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
          const namespace = namespaces.has(tc.function.name)
            ? namespaces.get(tc.function.name)
            : tc.namespace;
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            ...(namespace ? { namespace } : {}),
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
        output: m.parts?.length ? m.parts.map((part) => part.type === "image_url"
          ? { type: "input_image", image_url: part.imageUrl.url, ...(part.imageUrl.detail ? { detail: part.imageUrl.detail } : {}) }
          : { type: "input_text", text: part.text }) : m.content ?? "",
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

type ResponsesData = {
  id?: string;
  created_at?: number;
  model?: string;
  output?: Array<Record<string, unknown>>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  status?: string;
  error?: { code?: string; message?: string } | null;
  incomplete_details?: { reason?: string } | null;
};

function responsesFailure(data: ResponsesData, status = data.status ?? "error"): Error {
  return new Error(`responses ${status}: ${data.error?.message ?? data.incomplete_details?.reason ?? "upstream returned no text or function calls"}`);
}

// Extract usable output independently of status: compatible gateways may keep
// an in_progress/incomplete status even inside a response.completed snapshot.
export function parseResponsesOutput(data: ResponsesData): {
  content: string | null;
  toolCalls?: ModelToolCall[];
  finishReason: string;
} {
  const output = Array.isArray(data.output) ? data.output : [];
  const textParts: string[] = [];
  const toolCalls: ModelToolCall[] = [];

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
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
        ...(typeof item.namespace === "string" && item.namespace ? { namespace: item.namespace } : {}),
        function: { name, arguments: args },
      });
    }
  }

  const content = textParts.length ? textParts.join("") : null;
  return {
    content,
    ...(toolCalls.length ? { toolCalls } : {}),
    finishReason: toolCalls.length
      ? "tool_calls"
      : data.incomplete_details?.reason === "max_output_tokens" ? "length" : "stop",
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
  const mapped = mapMessagesToResponsesInput(messages, packedTools);
  const body: Record<string, unknown> = {
    model: route.model,
    ...mapped,
    ...(packedTools.length ? { tools: packedTools } : {}),
  };
  if (route.upstream.protocol === "codex") {
    body.store = false;
    if (body.instructions == null) body.instructions = "";
  } else {
    if (options?.temperature != null) body.temperature = options.temperature;
    if (options?.maxTokens != null) body.max_output_tokens = options.maxTokens;
  }
  const tc = mapToolChoice(options?.toolChoice);
  if (tc !== undefined) body.tool_choice = tc;

  const res = await httpJson<ResponsesData>(responsesUrl(route), {
    method: "POST",
    headers: buildHeaders(route.upstream.config, route.upstream.protocol),
    body: JSON.stringify(body),
    timeoutMs: timeout(route),
  });
  if (!res.ok) throw apiError("responses", res.status, res.data, res.text);
  if (res.data?.error) throw responsesFailure(res.data);

  const parsed = parseResponsesOutput(res.data ?? {});
  if (!parsed.content && !parsed.toolCalls?.length) throw responsesFailure(res.data ?? {});
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

type ResponsesToolCallState = { id: string; name: string; arguments: string; namespace?: string };

type ResponsesStreamState = {
  content: string;
  toolCalls: Map<number, ResponsesToolCallState>;
  /** item id → slot for argument deltas */
  byItemId: Map<string, ResponsesToolCallState>;
  chat: ChatStreamState;
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
  const mapped = mapMessagesToResponsesInput(messages, packedTools);
  const body: Record<string, unknown> = {
    model: route.model,
    ...mapped,
    ...(packedTools.length ? { tools: packedTools } : {}),
    stream: true,
  };
  if (route.upstream.protocol === "codex") {
    body.store = false;
    if (body.instructions == null) body.instructions = "";
  } else {
    if (options?.temperature != null) body.temperature = options.temperature;
    if (options?.maxTokens != null) body.max_output_tokens = options.maxTokens;
  }
  const tc = mapToolChoice(options?.toolChoice);
  if (tc !== undefined) body.tool_choice = tc;

  const state: ResponsesStreamState = {
    content: "",
    toolCalls: new Map(),
    byItemId: new Map(),
    chat: createChatStreamState(),
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
      if (absorbResponsesStreamEvent(state, chunk, callbacks)) {
        stopped = true;
        return false;
      }
    },
  );

  const toolCalls: ResponsesToolCallState[] = [
    ...state.toolCalls.values(),
    ...state.byItemId.values(),
    ...state.chat.toolCalls,
  ].filter((t) => t.name.trim());
  // Both Responses maps reference the same slots. Calls without IDs still
  // represent distinct Chat indices, even when they call the same function.
  const seen = new Set<string | ResponsesToolCallState>();
  const unique = toolCalls.filter((t) => {
    const key = t.id || t;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const mappedCalls = unique.length
    ? unique.map((t, i) => ({
        id: t.id || `call_${i}`,
        type: "function" as const,
        ...(t.namespace ? { namespace: t.namespace } : {}),
        function: { name: t.name, arguments: t.arguments || "{}" },
      }))
    : undefined;

  // [DONE] and clean EOF are normal endings for compatible gateways. Never
  // discard parsed calls/text just because response.completed was omitted.
  if (!state.content && !mappedCalls?.length) {
    throw new Error("responses stream ended without text or function calls");
  }
  const openai = buildOpenAIChatCompletion({
    model: state.model ?? route.model,
    content: state.content || null,
    toolCalls: mappedCalls,
    finishReason: mappedCalls?.length ? "tool_calls" : state.finishReason ?? "stop",
    usage: state.usage,
  });
  return toModelChatResult(openai);
}

function absorbResponsesToolCall(
  state: ResponsesStreamState,
  item: Record<string, unknown>,
  outputIndex?: number,
): void {
  if (item.type !== "function_call") return;
  const itemId = typeof item.id === "string" ? item.id : "";
  const callId = typeof item.call_id === "string" ? item.call_id : "";
  const slot: ResponsesToolCallState = (itemId ? state.byItemId.get(itemId) : undefined)
    ?? (callId ? [...state.toolCalls.values()].find((call) => call.id === callId) : undefined)
    ?? (outputIndex != null ? state.toolCalls.get(outputIndex) : undefined)
    ?? { id: "", name: "", arguments: "" };
  slot.id = callId || slot.id || itemId || `call_${createId()}`;
  if (typeof item.name === "string" && item.name) slot.name = item.name;
  if (typeof item.arguments === "string") {
    if (item.arguments || !slot.arguments) slot.arguments = item.arguments;
  } else if (item.arguments != null) {
    slot.arguments = JSON.stringify(item.arguments);
  }
  if (typeof item.namespace === "string" && item.namespace) slot.namespace = item.namespace;
  if (itemId) state.byItemId.set(itemId, slot);
  if (outputIndex != null) {
    state.toolCalls.set(outputIndex, slot);
  } else if (![...state.toolCalls.values()].includes(slot)) {
    let index = state.toolCalls.size;
    while (state.toolCalls.has(index)) index++;
    state.toolCalls.set(index, slot);
  }
}

function absorbResponsesStreamEvent(
  state: ResponsesStreamState,
  chunk: unknown,
  callbacks: ChatStreamCallbacks,
): boolean | void {
  if (!chunk || typeof chunk !== "object") return;
  const ev = chunk as Record<string, unknown>;
  const type = typeof ev.type === "string" ? ev.type : "";

  if (ev.error || type === "error" || type === "response.error") {
    const error = ev.error as ResponsesData["error"];
    throw responsesFailure({ error: { message: error?.message ?? (typeof ev.message === "string" ? ev.message : "upstream stream error") } });
  }
  if (type === "response.failed" || type === "response.cancelled") {
    throw responsesFailure((ev.response ?? {}) as ResponsesData, type.slice("response.".length));
  }

  if (typeof ev.model === "string" && ev.model) state.model = ev.model;

  // Some gateways return Chat SSE from /responses. Reuse the Chat accumulator
  // so fragmented/parallel tool calls, reasoning and usage survive as well.
  if (Array.isArray((ev as { choices?: unknown }).choices)) {
    const delta = absorbChatStreamChunk(state.chat, chunk);
    state.model = state.chat.model ?? state.model;
    state.usage = state.chat.usage ?? state.usage;
    state.finishReason = state.chat.finishReason ?? state.finishReason;
    if (delta.content) {
      state.content += delta.content;
      callbacks.onDelta?.(delta.content);
    }
    if (delta.reasoning) callbacks.onReasoningDelta?.(delta.reasoning);
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

  if (type === "response.output_item.added" || type === "response.output_item.done") {
    const item = ev.item as Record<string, unknown> | undefined;
    if (item) absorbResponsesToolCall(state, item, typeof ev.output_index === "number" ? ev.output_index : undefined);
    return;
  }

  if (
    type === "response.function_call_arguments.delta" ||
    type === "response.output_item.function_call_arguments.delta" ||
    type === "response.function_call_arguments.done"
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
    if (slot) {
      if (type === "response.function_call_arguments.done" && typeof ev.arguments === "string") {
        slot.arguments = ev.arguments;
      } else if (delta) {
        slot.arguments += delta;
      }
    }
    return;
  }

  if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
    const resp = (ev.response as Record<string, unknown> | undefined) ?? ev;
    if (resp && typeof resp === "object") {
      const parsed = parseResponsesOutput(resp as ResponsesData);
      if (parsed.content && !state.content) {
        state.content = parsed.content;
        callbacks.onDelta?.(parsed.content);
      }
      // Terminal snapshots may omit calls, arguments or namespaces seen in
      // deltas. Merge them without clearing already parsed tool calls.
      if (Array.isArray(resp.output)) {
        for (const item of resp.output) {
          if (item && typeof item === "object") absorbResponsesToolCall(state, item);
        }
      }
      state.finishReason = parsed.finishReason;
      if (typeof resp.model === "string" && resp.model) state.model = resp.model;
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
    return true;
  }
}
