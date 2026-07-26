import type {
  ModelCapability,
  ModelChatInvokeOptions,
  ModelChatMessage,
  ModelChatResult,
  ModelEmbeddingResult,
  ModelImageResult,
  ModelRerankResult,
} from "@zakura/shared";
import type { ChatStreamCallbacks, ModelProtocolAdapter } from "./adapter.js";
import { isRetryableModelError, withModelRetries } from "./http.js";
import { resolveAdapterForCapability } from "./registry.js";
import type { ResolvedRoute } from "./types.js";

function assertCapability(route: ResolvedRoute, expected: ModelCapability): void {
  if (route.capability !== expected) {
    throw new Error(`路由 ${route.routeSlug} 能力为 ${route.capability}，无法用于 ${expected}`);
  }
}

async function invokeWithAdapter<T>(
  route: ResolvedRoute,
  capability: ModelCapability,
  run: (adapter: ModelProtocolAdapter) => Promise<T>,
): Promise<T> {
  assertCapability(route, capability);
  const adapter = resolveAdapterForCapability(route.upstream.protocol, capability);
  return run(adapter);
}

export async function executeChat(
  route: ResolvedRoute,
  messages: ModelChatMessage[],
  options?: ModelChatInvokeOptions,
): Promise<ModelChatResult> {
  return invokeWithAdapter(route, "chat", async (adapter) => {
    if (!adapter.chat) throw new Error(`协议 ${adapter.protocol} 未实现 chat`);
    return adapter.chat(route, messages, options);
  });
}

/**
 * 流式 chat：协议支持 chatStream 时边生成边回调；
 * 否则回退非流式并在完成时整块回调一次。
 */
export async function executeChatStream(
  route: ResolvedRoute,
  messages: ModelChatMessage[],
  options: ModelChatInvokeOptions | undefined,
  callbacks: ChatStreamCallbacks,
): Promise<ModelChatResult> {
  return invokeWithAdapter(route, "chat", async (adapter) => {
    if (adapter.chatStream) {
      return adapter.chatStream(route, messages, options, callbacks);
    }
    if (!adapter.chat) throw new Error(`协议 ${adapter.protocol} 未实现 chat`);
    const result = await adapter.chat(route, messages, options);
    if (result.content) callbacks.onDelta?.(result.content);
    return result;
  });
}

export async function executeEmbed(
  route: ResolvedRoute,
  texts: string[],
): Promise<ModelEmbeddingResult> {
  return invokeWithAdapter(route, "embedding", async (adapter) => {
    if (!adapter.embed) throw new Error(`协议 ${adapter.protocol} 未实现 embed`);
    return adapter.embed(route, texts);
  });
}

export async function executeRerank(
  route: ResolvedRoute,
  query: string,
  documents: string[],
): Promise<ModelRerankResult> {
  return invokeWithAdapter(route, "rerank", async (adapter) => {
    if (!adapter.rerank) throw new Error(`协议 ${adapter.protocol} 未实现 rerank`);
    return adapter.rerank(route, query, documents);
  });
}

export async function executeImage(
  route: ResolvedRoute,
  prompt: string,
): Promise<ModelImageResult> {
  return invokeWithAdapter(route, "image", async (adapter) => {
    if (!adapter.generateImage) {
      throw new Error(`协议 ${adapter.protocol} 未实现 generateImage`);
    }
    return adapter.generateImage(route, prompt);
  });
}

/**
 * 按已排序的候选链依次尝试，首个成功即返回。
 * 瞬时错误（网络中断/超时/429/5xx）在切换路由前会先在原路由上重试一次。
 * 全部失败时抛出的聚合错误带 retryable 标记（任一路由错误为瞬时即视为可重试）。
 */
export async function executeWithFallback<T>(
  routes: ResolvedRoute[],
  capability: ModelCapability,
  fn: (adapter: ModelProtocolAdapter, route: ResolvedRoute) => Promise<T>,
): Promise<{ result: T; route: ResolvedRoute }> {
  if (routes.length === 0) {
    throw new Error(`未配置 ${capability} 模型路由`);
  }
  const errors: string[] = [];
  let anyRetryable = false;
  for (const route of routes) {
    try {
      const adapter = resolveAdapterForCapability(route.upstream.protocol, capability);
      const result = await withModelRetries(() => fn(adapter, route), { attempts: 2 });
      return { result, route };
    } catch (err) {
      if (isRetryableModelError(err)) anyRetryable = true;
      errors.push(
        `${route.routeSlug}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const aggregate = new Error(`所有 ${capability} 路由均失败:\n${errors.join("\n")}`);
  (aggregate as { retryable?: boolean }).retryable = anyRetryable;
  throw aggregate;
}
