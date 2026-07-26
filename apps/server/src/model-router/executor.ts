import type {
  ModelCapability,
  ModelChatInvokeOptions,
  ModelChatMessage,
  ModelChatResult,
  ModelEmbeddingResult,
  ModelImageResult,
  ModelRerankResult,
} from "@zakura/shared";
import type { ModelProtocolAdapter } from "./adapter.js";
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

/** 按已排序的候选链依次尝试，首个成功即返回 */
export async function executeWithFallback<T>(
  routes: ResolvedRoute[],
  capability: ModelCapability,
  fn: (adapter: ModelProtocolAdapter, route: ResolvedRoute) => Promise<T>,
): Promise<{ result: T; route: ResolvedRoute }> {
  if (routes.length === 0) {
    throw new Error(`未配置 ${capability} 模型路由`);
  }
  const errors: string[] = [];
  for (const route of routes) {
    try {
      const adapter = resolveAdapterForCapability(route.upstream.protocol, capability);
      const result = await fn(adapter, route);
      return { result, route };
    } catch (err) {
      errors.push(
        `${route.routeSlug}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  throw new Error(`所有 ${capability} 路由均失败:\n${errors.join("\n")}`);
}
