import { buildOpenAIChatCompletion, toModelChatResult } from "../openai-response.js";
import type { ModelProtocolAdapter } from "../adapter.js";
import { cursorPrompt } from "../../services/model-upstream-auth/providers/cursor.js";

function messagesToPrompt(
  messages: Array<{ role: string; content?: string | null }>,
): string {
  return messages
    .map((m) => {
      const body = m.content ?? "";
      if (!body) return "";
      if (m.role === "system") return `System:\n${body}`;
      if (m.role === "assistant") return `Assistant:\n${body}`;
      return `User:\n${body}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

export const cursorAdapter: ModelProtocolAdapter = {
  protocol: "cursor",
  supportedCapabilities: ["chat"],
  async chat(route, messages) {
    const apiKey = route.upstream.config.apiKey;
    if (!apiKey) throw new Error("尚未登录 Cursor");
    const text = await cursorPrompt({
      text: messagesToPrompt(messages),
      apiKey,
      model: route.model,
    });
    return toModelChatResult(
      buildOpenAIChatCompletion({
        model: route.model,
        content: text || null,
        finishReason: "stop",
      }),
    );
  },
};
