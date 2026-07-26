import type {
  ModelCapability,
  ModelChatInvokeOptions,
  ModelChatMessage,
  ModelChatResult,
  ModelEmbeddingResult,
  ModelImageResult,
  ModelRerankResult,
  ModelToolCall,
  ModelUpstreamProtocol,
} from "@zakura/shared";
import type { ResolvedRoute } from "./types.js";

export type ModelInvokeHandlers = {
  chat?(
    route: ResolvedRoute,
    messages: ModelChatMessage[],
    options?: ModelChatInvokeOptions,
  ): Promise<ModelChatResult>;
  embed?(route: ResolvedRoute, texts: string[]): Promise<ModelEmbeddingResult>;
  rerank?(
    route: ResolvedRoute,
    query: string,
    documents: string[],
  ): Promise<ModelRerankResult>;
  generateImage?(route: ResolvedRoute, prompt: string): Promise<ModelImageResult>;
};

/** 协议适配器：按能力声明支持范围，便于注册表校验与扩展 */
export interface ModelProtocolAdapter extends ModelInvokeHandlers {
  readonly protocol: ModelUpstreamProtocol;
  readonly supportedCapabilities: readonly ModelCapability[];
}

export function adapterSupports(
  adapter: ModelProtocolAdapter,
  capability: ModelCapability,
): boolean {
  return adapter.supportedCapabilities.includes(capability);
}

/** 从 OpenAI 兼容 choice.message 提取 tool_calls */
export function parseOpenAIToolCalls(raw: unknown): ModelToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const calls: ModelToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const fn = o.function;
    if (!fn || typeof fn !== "object") continue;
    const f = fn as Record<string, unknown>;
    if (typeof f.name !== "string") continue;
    calls.push({
      id: typeof o.id === "string" ? o.id : `call_${calls.length}`,
      type: "function",
      function: {
        name: f.name,
        arguments:
          typeof f.arguments === "string"
            ? f.arguments
            : JSON.stringify(f.arguments ?? {}),
      },
    });
  }
  return calls.length ? calls : undefined;
}
