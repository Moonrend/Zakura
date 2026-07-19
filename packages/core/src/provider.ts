import type {
  HealthResult,
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
}

export type ProviderFactory = () => ProviderPlugin;
