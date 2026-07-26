import type {
  ModelChatInvokeOptions,
  ModelChatMessage,
  ModelChatResult,
} from "@zakura/shared";
import type { ModelProtocolAdapter } from "../adapter.js";
import { apiError, httpJson } from "../http.js";
import { buildOpenAIChatCompletion, toModelChatResult } from "../openai-response.js";
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
  | { type: "tool_result"; tool_use_id: string; content: string };

function toAnthropicMessages(messages: ModelChatMessage[]): {
  system?: string;
  messages: Array<{ role: string; content: string | AnthropicContentBlock[] }>;
} {
  const systemParts: string[] = [];
  const out: Array<{ role: string; content: string | AnthropicContentBlock[] }> = [];

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

async function chat(
  route: ResolvedRoute,
  messages: ModelChatMessage[],
  options?: ModelChatInvokeOptions,
): Promise<ModelChatResult> {
  const mapped = toAnthropicMessages(messages);
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
  if (options?.extensions) Object.assign(body, options.extensions);

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
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-api-key": apiKey(route),
      "anthropic-version": version(route),
      ...(route.upstream.config.extraHeaders ?? {}),
    },
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

  const finishMap: Record<string, string> = {
    end_turn: "stop",
    max_tokens: "length",
    stop_sequence: "stop",
    tool_use: "tool_calls",
  };
  const finishReason = res.data?.stop_reason
    ? (finishMap[res.data.stop_reason] ?? res.data.stop_reason)
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

export const anthropicAdapter: ModelProtocolAdapter = {
  protocol: "anthropic",
  supportedCapabilities: ["chat"],
  chat,
};
