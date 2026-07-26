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
