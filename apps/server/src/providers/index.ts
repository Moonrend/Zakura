import { globalRegistry } from "@zakura/core";
import type { Db } from "../db/client.js";
import { createWebSearchProvider } from "./web-search.js";
import { createWebFetchProvider } from "./web-fetch.js";
import { createMem0Provider, injectMem0Db } from "./mem0.js";
import { createOpenVikingProvider } from "./openviking.js";
import { createGenericMcpProvider, injectGenericMcpRuntime } from "./generic-mcp.js";
import { createStdioMcpProvider } from "./stdio-mcp.js";
import type { AppConfig } from "../config.js";

export function registerBuiltinProviders(): void {
  const providers = [
    createWebSearchProvider,
    createWebFetchProvider,
    createMem0Provider,
    createOpenVikingProvider,
    createGenericMcpProvider,
    createStdioMcpProvider,
  ];
  for (const factory of providers) {
    const id = factory().id;
    if (!globalRegistry.has(id)) {
      globalRegistry.register(factory);
    }
  }
}

/** Wire DB-backed builtin providers after createDb */
export function bindProviderRuntime(db: Db, config?: AppConfig): void {
  injectMem0Db(globalRegistry.get("mem0"), db);
  if (config) {
    injectGenericMcpRuntime(config, db);
  }
}

export {
  createWebSearchProvider,
  createWebFetchProvider,
  createMem0Provider,
  createOpenVikingProvider,
  createGenericMcpProvider,
  createStdioMcpProvider,
  injectMem0Db,
  injectGenericMcpRuntime,
};
