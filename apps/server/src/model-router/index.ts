export { registerBuiltinModelAdapters } from "./adapters/index.js";
export type { ChatStreamCallbacks, ModelProtocolAdapter } from "./adapter.js";
export {
  registerModelAdapter,
  getModelAdapter,
  listModelAdapters,
  resolveAdapterForCapability,
} from "./registry.js";
export { RouteResolver, type RouteResolveQuery } from "./resolver.js";
export {
  executeChat,
  executeChatStream,
  executeEmbed,
  executeRerank,
  executeImage,
  executeWithFallback,
} from "./executor.js";
export {
  isRetryableModelError,
  withModelRetries,
  UpstreamHttpError,
} from "./http.js";
export { weightedShuffle, orderRoutesForStrategy } from "./strategy.js";
export {
  absorbChatStreamChunk,
  buildOpenAIChatCompletion,
  chatStreamStateToResult,
  createChatStreamState,
  toModelChatResult,
  type ChatStreamState,
} from "./openai-response.js";
export {
  parseJsonRecord,
  parseUpstreamConfig,
  parseRouteOptions,
  rowToResolvedRoute,
  type ResolvedRoute,
} from "./types.js";
