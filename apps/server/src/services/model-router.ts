import type {
  ModelCapability,
  ModelChatInvokeOptions,
  ModelChatMessage,
  ModelChatResult,
  ModelEmbeddingResult,
  ModelImageResult,
  ModelRerankResult,
} from "@zakura/shared";
import type { Db } from "../db/client.js";
import {
  executeChat,
  executeChatStream,
  executeEmbed,
  executeImage,
  executeRerank,
  executeWithFallback,
  isAbortError,
  isRetryableModelError,
  withModelRetries,
  RouteResolver,
  type ChatStreamCallbacks,
  type RouteResolveQuery,
} from "../model-router/index.js";

export type RouteResolveInput = RouteResolveQuery;

/**
 * 流式 chat 在「已向调用方输出增量后」失败时抛出：
 * 不能原地重试/换路由（会产生重复文本），由上层决定是否回滚重来。
 */
export class ChatStreamPartialError extends Error {
  readonly emitted = true;
  readonly retryable = true;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ChatStreamPartialError";
    if (cause !== undefined) this.cause = cause;
  }
}

type RoutedResult<T> = T & {
  routeId: string;
  routeSlug: string;
  alias: string;
  upstreamId: string;
};

export class ModelRouterService {
  private readonly resolver: RouteResolver;

  constructor(db: Db) {
    this.resolver = new RouteResolver(db);
  }

  invalidateCache(tenantId: string): void {
    this.resolver.invalidateTenant(tenantId);
  }

  async resolveRoute(tenantId: string, input: RouteResolveInput) {
    const chain = await this.resolver.resolveChain(tenantId, input);
    return chain[0] ?? null;
  }

  private async invoke<T>(
    tenantId: string,
    capability: ModelCapability,
    input: RouteResolveInput,
    executor: (route: import("../model-router/types.js").ResolvedRoute) => Promise<T>,
  ): Promise<RoutedResult<T>> {
    const chain = await this.resolver.resolveChain(tenantId, {
      strategy: "weighted",
      ...input,
    });
    const { result, route } = await executeWithFallback(
      chain,
      capability,
      async (_adapter, r) => executor(r),
    );
    return {
      ...result,
      routeId: route.routeId,
      routeSlug: route.routeSlug,
      alias: route.alias,
      upstreamId: route.upstream.id,
    };
  }

  chat(
    tenantId: string,
    messages: ModelChatMessage[],
    input: RouteResolveInput,
    options?: ModelChatInvokeOptions,
  ): Promise<RoutedResult<ModelChatResult>> {
    return this.invoke(tenantId, "chat", input, (route) =>
      executeChat(route, messages, options),
    );
  }

  /**
   * 流式 chat：onDelta 边生成边回调（协议不支持流式时完成后整块回调一次）。
   * 瞬时错误在「尚未输出任何增量」时先在原路由重试、再故障转移下一路由；
   * 流已开始后失败抛 ChatStreamPartialError（重试会导致重复文本，由上层
   * 决定是否回滚已发布的增量后整体重来）。
   */
  async chatStream(
    tenantId: string,
    messages: ModelChatMessage[],
    input: RouteResolveInput,
    options: ModelChatInvokeOptions | undefined,
    callbacks: ChatStreamCallbacks,
  ): Promise<RoutedResult<ModelChatResult>> {
    const chain = await this.resolver.resolveChain(tenantId, {
      strategy: "weighted",
      ...input,
    });
    if (chain.length === 0) throw new Error("未配置 chat 模型路由");
    const errors: string[] = [];
    let anyRetryable = false;
    for (const route of chain) {
      let emitted = false;
      const gated: ChatStreamCallbacks = {
        onDelta: (text) => {
          if (text) emitted = true;
          callbacks.onDelta?.(text);
        },
      };
      try {
        const result = await withModelRetries(
          () => executeChatStream(route, messages, options, gated),
          {
            attempts: 2,
            shouldRetry: (err) => !emitted && isRetryableModelError(err),
          },
        );
        return {
          ...result,
          routeId: route.routeId,
          routeSlug: route.routeSlug,
          alias: route.alias,
          upstreamId: route.upstream.id,
        };
      } catch (err) {
        // 调用方取消：不重试、不故障转移，原样抛给上层走取消收尾
        if (isAbortError(err)) throw err;
        if (emitted) {
          throw new ChatStreamPartialError(
            `${route.routeSlug}: 流式输出中断（${err instanceof Error ? err.message : String(err)}）`,
            err,
          );
        }
        if (isRetryableModelError(err)) anyRetryable = true;
        errors.push(
          `${route.routeSlug}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const aggregate = new Error(`所有 chat 路由均失败:\n${errors.join("\n")}`);
    (aggregate as { retryable?: boolean }).retryable = anyRetryable;
    throw aggregate;
  }

  embed(
    tenantId: string,
    texts: string[],
    input: RouteResolveInput,
  ): Promise<RoutedResult<ModelEmbeddingResult>> {
    return this.invoke(tenantId, "embedding", input, (route) => executeEmbed(route, texts));
  }

  rerank(
    tenantId: string,
    query: string,
    documents: string[],
    input: RouteResolveInput,
  ): Promise<RoutedResult<ModelRerankResult>> {
    return this.invoke(tenantId, "rerank", input, (route) =>
      executeRerank(route, query, documents),
    );
  }

  generateImage(
    tenantId: string,
    prompt: string,
    input: RouteResolveInput,
  ): Promise<RoutedResult<ModelImageResult>> {
    return this.invoke(tenantId, "image", input, (route) => executeImage(route, prompt));
  }
}
