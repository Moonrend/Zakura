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
import {
  createMicrosoft365Provider,
  injectMicrosoft365Runtime,
} from "./microsoft-365/index.js";
import { createGithubProvider, injectGithubRuntime } from "./github/index.js";
import { createSlackProvider, injectSlackRuntime } from "./slack/index.js";
import { createNotionProvider, injectNotionRuntime } from "./notion/index.js";
import { createLinearProvider, injectLinearRuntime } from "./linear/index.js";
import { createFeishuProvider, injectFeishuRuntime } from "./feishu/index.js";
import { createDiscordProvider, injectDiscordRuntime } from "./discord/index.js";
import { createGitlabProvider, injectGitlabRuntime } from "./gitlab/index.js";
import { createJiraProvider, injectJiraRuntime } from "./jira/index.js";

export function registerBuiltinProviders(): void {
  const providers = [
    createWebSearchProvider,
    createWebFetchProvider,
    createOpenVikingProvider,
    createGenericMcpProvider,
    createStdioMcpProvider,
    createGoogleWorkspaceProvider,
    createMicrosoft365Provider,
    createGithubProvider,
    createSlackProvider,
    createNotionProvider,
    createLinearProvider,
    createFeishuProvider,
    createDiscordProvider,
    createGitlabProvider,
    createJiraProvider,
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
    injectMicrosoft365Runtime(config, db);
    injectGithubRuntime(config, db);
    injectSlackRuntime(config, db);
    injectNotionRuntime(config, db);
    injectLinearRuntime(config, db);
    injectFeishuRuntime(config, db);
    injectDiscordRuntime(config, db);
    injectGitlabRuntime(config, db);
    injectJiraRuntime(config, db);
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
  createMicrosoft365Provider,
  injectMicrosoft365Runtime,
  createGithubProvider,
  injectGithubRuntime,
  createSlackProvider,
  injectSlackRuntime,
  createNotionProvider,
  injectNotionRuntime,
  createLinearProvider,
  injectLinearRuntime,
  createFeishuProvider,
  injectFeishuRuntime,
  createDiscordProvider,
  injectDiscordRuntime,
  createGitlabProvider,
  injectGitlabRuntime,
  createJiraProvider,
  injectJiraRuntime,
};
