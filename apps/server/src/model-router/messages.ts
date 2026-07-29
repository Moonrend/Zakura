import type { ModelChatMessage, ModelToolCall } from "@zakura/shared";

const REPAIRED_TOOL_RESULT = "（该工具调用没有可用结果：历史上下文已自动修复）";

function validToolCalls(calls: ModelToolCall[] | undefined): ModelToolCall[] {
  if (!calls?.length) return [];
  const seen = new Set<string>();
  const out: ModelToolCall[] = [];
  for (const call of calls) {
    if (!call.id || seen.has(call.id)) continue;
    seen.add(call.id);
    out.push(call);
  }
  return out;
}

/**
 * OpenAI-compatible providers are strict about tool history:
 * every tool message must immediately answer a preceding assistant.tool_calls item.
 */
export function normalizeToolCallHistory(
  messages: ModelChatMessage[],
): ModelChatMessage[] {
  const out: ModelChatMessage[] = [];
  let pending: Map<string, string> | null = null;

  const closePending = () => {
    if (!pending?.size) {
      pending = null;
      return;
    }
    for (const [id, name] of pending) {
      out.push({
        role: "tool",
        content: REPAIRED_TOOL_RESULT,
        toolCallId: id,
        name,
      });
    }
    pending = null;
  };

  for (const message of messages) {
    if (message.role === "tool") {
      if (!pending?.size) continue;
      let id = message.toolCallId;
      if ((!id || !pending.has(id)) && pending.size === 1) {
        id = pending.keys().next().value;
      }
      if (!id || !pending.has(id)) continue;
      out.push({
        ...message,
        toolCallId: id,
        name: message.name ?? pending.get(id),
      });
      pending.delete(id);
      continue;
    }

    closePending();

    if (message.role !== "assistant") {
      out.push(message);
      continue;
    }

    const toolCalls = validToolCalls(message.toolCalls);
    if (!toolCalls.length) {
      out.push({ ...message, toolCalls: undefined });
      continue;
    }
    out.push({ ...message, toolCalls });
    pending = new Map(toolCalls.map((call) => [call.id, call.function.name]));
  }

  closePending();
  return out;
}
