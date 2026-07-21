import { globalRegistry } from "@zakura/core";
import type { Db } from "../db/client.js";
import { createWebSearchProvider } from "./web-search.js";
import { createWebFetchProvider } from "./web-fetch.js";
import { createOpenVikingProvider } from "./openviking.js";
import { createGenericMcpProvider, injectGenericMcpRuntime } from "./generic-mcp.js";
import { createStdioMcpProvider } from "./stdio-mcp.js";
import {
  createGoogleWorkspaceProvider,
  injectGoogleWorkspaceRuntime,
} from "./google-workspace/index.js";
import type { AppConfig } from "../config.js";

export function registerBuiltinProviders(): void {
  const providers = [
    createWebSearchProvider,
    createWebFetchProvider,
    createOpenVikingProvider,
    createGenericMcpProvider,
    createStdioMcpProvider,
    createGoogleWorkspaceProvider,
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
  if (config) {
    injectGenericMcpRuntime(config, db);
    injectGoogleWorkspaceRuntime(config, db);
  }
}

export {
  createWebSearchProvider,
  createWebFetchProvider,
  createOpenVikingProvider,
  createGenericMcpProvider,
  createStdioMcpProvider,
  createGoogleWorkspaceProvider,
  injectGenericMcpRuntime,
  injectGoogleWorkspaceRuntime,
};
