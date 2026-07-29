import type {
  ModelCapability,
  ModelChatInvokeOptions,
  ModelChatMessage,
  ModelChatResult,
  ModelEmbeddingResult,
  ModelImageResult,
  ModelReasoningOptions,
  ModelRerankResult,
} from "@zakura/shared";
import type { ChatStreamCallbacks, ModelProtocolAdapter } from "./adapter.js";
import { isRetryableModelError, withModelRetries } from "./http.js";
import { normalizeToolCallHistory } from "./messages.js";
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

function normalizeInvokeReasoning(
  route: ResolvedRoute,
  reasoning: ModelReasoningOptions,
): ModelReasoningOptions | undefined {
  const levels = route.meta?.reasoningLevels?.map((v) => v.toLowerCase());
  if (levels && levels.length === 0) return undefined;
  if (levels && reasoning.enabled === false) {
    return levels.includes("none") ? { enabled: false } : undefined;
  }
  if (
    levels &&
    reasoning.effort &&
    !levels.includes(reasoning.effort.toLowerCase())
  ) {
    return undefined;
  }
  if (route.meta?.reasoning === false) return undefined;
  return reasoning;
}

export function applyInvokeRouteOptions(
  route: ResolvedRoute,
  options?: ModelChatInvokeOptions,
): ResolvedRoute {
  if (!options?.routeOptions || Object.keys(options.routeOptions).length === 0) {
    return route;
  }
  return {
    ...route,
    options: {
      ...route.options,
      ...options.routeOptions,
      ...(options.routeOptions.reasoning
        ? {
            reasoning: normalizeInvokeReasoning(
              route,
              options.routeOptions.reasoning,
            ),
          }
        : {}),
      extensions: {
        ...(route.options.extensions ?? {}),
        ...(options.routeOptions.extensions ?? {}),
      },
    },
  };
}

export async function executeChat(
  route: ResolvedRoute,
  messages: ModelChatMessage[],
  options?: ModelChatInvokeOptions,
): Promise<ModelChatResult> {
  const normalizedMessages = normalizeToolCallHistory(messages);
  return invokeWithAdapter(route, "chat", async (adapter) => {
    if (!adapter.chat) throw new Error(`协议 ${adapter.protocol} 未实现 chat`);
    return adapter.chat(applyInvokeRouteOptions(route, options), normalizedMessages, options);
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
  const normalizedMessages = normalizeToolCallHistory(messages);
  return invokeWithAdapter(route, "chat", async (adapter) => {
    const nextRoute = applyInvokeRouteOptions(route, options);
    if (adapter.chatStream) {
      return adapter.chatStream(nextRoute, normalizedMessages, options, callbacks);
    }
    if (!adapter.chat) throw new Error(`协议 ${adapter.protocol} 未实现 chat`);
    const result = await adapter.chat(nextRoute, normalizedMessages, options);
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
