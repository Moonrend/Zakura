import { createId } from "@paralleldrive/cuid2";
import type {
  ModelChatResult,
  ModelToolCall,
  OpenAIChatCompletion,
} from "@zakura/shared";

/** 构造统一的 OpenAI Chat Completions 响应（各协议适配器最终输出此形状） */
export function buildOpenAIChatCompletion(input: {
  model: string;
  content: string | null;
  toolCalls?: ModelToolCall[];
  finishReason?: string | null;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  id?: string;
  created?: number;
}): OpenAIChatCompletion {
  const usage =
    input.usage &&
    (input.usage.promptTokens != null ||
      input.usage.completionTokens != null ||
      input.usage.totalTokens != null)
      ? {
          prompt_tokens: input.usage.promptTokens ?? 0,
          completion_tokens: input.usage.completionTokens ?? 0,
          total_tokens:
            input.usage.totalTokens ??
            (input.usage.promptTokens ?? 0) + (input.usage.completionTokens ?? 0),
        }
      : undefined;

  return {
    id: input.id ?? `chatcmpl-${createId()}`,
    object: "chat.completion",
    created: input.created ?? Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: input.content,
          ...(input.toolCalls?.length ? { tool_calls: input.toolCalls } : {}),
        },
        finish_reason: input.finishReason ?? (input.toolCalls?.length ? "tool_calls" : "stop"),
      },
    ],
    usage,
  };
}

/** OpenAI 流式 chunk 中 choices[0].delta 的累积状态 */
export type ChatStreamState = {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
  model: string | null;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
};

export function createChatStreamState(): ChatStreamState {
  return { content: "", toolCalls: [], finishReason: null, model: null };
}

/**
 * 吸收一个已解析的流式 chunk（chat.completion.chunk）。
 * 返回本 chunk 新增的文本增量（无则空串）。
 */
export function absorbChatStreamChunk(state: ChatStreamState, chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") return "";
  const o = chunk as {
    model?: string;
    choices?: Array<{
      delta?: {
        content?: string | null;
        tool_calls?: Array<{
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      finish_reason?: string | null;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  if (typeof o.model === "string" && o.model) state.model = o.model;
  if (o.usage) {
    state.usage = {
      promptTokens: o.usage.prompt_tokens,
      completionTokens: o.usage.completion_tokens,
      totalTokens: o.usage.total_tokens,
    };
  }
  const choice = o.choices?.[0];
  if (!choice) return "";
  if (choice.finish_reason) state.finishReason = choice.finish_reason;
  const delta = choice.delta;
  if (!delta) return "";
  for (const tc of delta.tool_calls ?? []) {
    const idx = tc.index ?? state.toolCalls.length;
    while (state.toolCalls.length <= idx) {
      state.toolCalls.push({ id: "", name: "", arguments: "" });
    }
    const slot = state.toolCalls[idx]!;
    if (tc.id) slot.id = tc.id;
    if (tc.function?.name) slot.name += tc.function.name;
    if (tc.function?.arguments) slot.arguments += tc.function.arguments;
  }
  if (typeof delta.content === "string" && delta.content) {
    state.content += delta.content;
    return delta.content;
  }
  return "";
}

/** 将累积状态封为统一 ModelChatResult */
export function chatStreamStateToResult(
  state: ChatStreamState,
  fallbackModel: string,
): ModelChatResult {
  const toolCalls: ModelToolCall[] | undefined = state.toolCalls.length
    ? state.toolCalls.map((t, i) => ({
        id: t.id || `call_${i}`,
        type: "function" as const,
        function: { name: t.name || "tool", arguments: t.arguments || "{}" },
      }))
    : undefined;
  const openai = buildOpenAIChatCompletion({
    model: state.model ?? fallbackModel,
    content: state.content || null,
    toolCalls,
    finishReason: state.finishReason,
    usage: state.usage,
  });
  return toModelChatResult(openai);
}

export function toModelChatResult(
  openai: OpenAIChatCompletion,
  raw?: unknown,
): ModelChatResult {
  const choice = openai.choices[0];
  const message = choice?.message;
  return {
    content: message?.content ?? null,
    model: openai.model,
    finishReason: choice?.finish_reason ?? null,
    toolCalls: message?.tool_calls,
    usage: openai.usage
      ? {
          promptTokens: openai.usage.prompt_tokens,
          completionTokens: openai.usage.completion_tokens,
          totalTokens: openai.usage.total_tokens,
        }
      : undefined,
    openai,
    raw,
  };
}
