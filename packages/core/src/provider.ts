import type {
  HealthResult,
  McpCompleteParams,
  McpCompleteResult,
  McpGetPromptResult,
  McpPromptDef,
  McpReadResourceResult,
  McpResourceDef,
  McpResourceTemplateDef,
  McpToolDef,
  McpToolResult,
  ProviderCapability,
  ProviderCategory,
  ProviderConfigSchema,
  RuntimeSpec,
} from "@zakura/shared";

/** Live handle to a running (or registered) component instance */
export interface InstanceHandle {
  id: string;
  tenantId: string;
  providerId: string;
  name: string;
  slug: string;
  /** Decrypted runtime config */
  config: Record<string, unknown>;
  endpointUrl?: string | null;
  /** Docker container IDs keyed by spec name */
  containers: Record<string, string>;
}

export interface ProviderContext {
  tenantId: string;
  instanceId: string;
  dataDir: string;
  /** Resolve host-accessible URL for a published port */
  resolveEndpoint: (hostPort: number, path?: string) => string;
  /** Optional DB handle for builtin (in-process) providers */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/**
 * Extensible provider plugin contract.
 * New AI components = implement this interface + register once.
 */
export interface ProviderPlugin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly category: ProviderCategory;
  readonly capabilities: ProviderCapability[];
  readonly configSchema: ProviderConfigSchema;

  /** Validate & normalize user config before persist */
  validateConfig?(config: Record<string, unknown>): Record<string, unknown>;

  /** Produce container specs for orchestrator (empty = builtin / in-process) */
  createRuntimeSpec(config: Record<string, unknown>, ctx: ProviderContext): RuntimeSpec | Promise<RuntimeSpec>;

  /** Optional post-start hook (seed DB, create API key, etc.) */
  afterStart?(handle: InstanceHandle, ctx: ProviderContext): Promise<void>;

  healthCheck(handle: InstanceHandle): Promise<HealthResult>;

  listTools(handle: InstanceHandle): Promise<McpToolDef[]>;

  callTool(
    handle: InstanceHandle,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult>;

  /** 可选：上游 MCP resources/list */
  listResources?(handle: InstanceHandle): Promise<McpResourceDef[]>;

  /** 可选：上游 MCP resources/read */
  readResource?(
    handle: InstanceHandle,
    uri: string,
  ): Promise<McpReadResourceResult>;

  /** 可选：上游 MCP prompts/list */
  listPrompts?(handle: InstanceHandle): Promise<McpPromptDef[]>;

  /** 可选：上游 MCP prompts/get */
  getPrompt?(
    handle: InstanceHandle,
    name: string,
    args?: Record<string, string>,
  ): Promise<McpGetPromptResult>;

  /** 可选：上游 MCP resources/templates/list */
  listResourceTemplates?(handle: InstanceHandle): Promise<McpResourceTemplateDef[]>;

  /** 可选：上游 MCP completion/complete */
  complete?(
    handle: InstanceHandle,
    params: McpCompleteParams,
  ): Promise<McpCompleteResult>;

  /**
   * 可选：任意上游 JSON-RPC（用于 tasks/get 等透传）。
   * 未实现时网关无法代理该实例的异步任务。
   */
  invokeRaw?(
    handle: InstanceHandle,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
}

export type ProviderFactory = () => ProviderPlugin;
