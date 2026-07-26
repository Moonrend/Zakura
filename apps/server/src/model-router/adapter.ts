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

/** 流式回调：onDelta 收到增量文本；结束后仍返回完整 ModelChatResult */
export type ChatStreamCallbacks = {
  onDelta?: (text: string) => void;
};

export type ModelInvokeHandlers = {
  chat?(
    route: ResolvedRoute,
    messages: ModelChatMessage[],
    options?: ModelChatInvokeOptions,
  ): Promise<ModelChatResult>;
  /** 可选流式 chat；未实现的协议由 executor 回退到非流式 */
  chatStream?(
    route: ResolvedRoute,
    messages: ModelChatMessage[],
    options: ModelChatInvokeOptions | undefined,
    callbacks: ChatStreamCallbacks,
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

/** 解析 data: URI（多模态图片）；非 data URI 返回 null */
export function parseDataUri(url: string): { mimeType: string; base64: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!m) return null;
  return { mimeType: m[1]!, base64: m[2]! };
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
