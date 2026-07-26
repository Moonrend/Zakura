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
  executeEmbed,
  executeImage,
  executeRerank,
  executeWithFallback,
  RouteResolver,
  type RouteResolveQuery,
} from "../model-router/index.js";

export type RouteResolveInput = RouteResolveQuery;

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
