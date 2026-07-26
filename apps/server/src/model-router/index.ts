export { registerBuiltinModelAdapters } from "./adapters/index.js";
export type { ModelProtocolAdapter } from "./adapter.js";
export {
  registerModelAdapter,
  getModelAdapter,
  listModelAdapters,
  resolveAdapterForCapability,
} from "./registry.js";
export { RouteResolver, type RouteResolveQuery } from "./resolver.js";
export {
  executeChat,
  executeEmbed,
  executeRerank,
  executeImage,
  executeWithFallback,
} from "./executor.js";
export { weightedShuffle, orderRoutesForStrategy } from "./strategy.js";
export {
  buildOpenAIChatCompletion,
  toModelChatResult,
} from "./openai-response.js";
export {
  parseJsonRecord,
  parseUpstreamConfig,
  parseRouteOptions,
  rowToResolvedRoute,
  type ResolvedRoute,
} from "./types.js";
