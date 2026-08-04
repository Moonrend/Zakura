/**
 * 平台配置助手专用原生工具：仅 isPlatformAssistant(agent) 时经 listToolsForAgent 注入。
 * 不进 listToolsForTenant，不注册为独立 MCP Server。
 */
import { textResult } from "@zakura/core";
import type { McpToolAnnotations, McpToolResult } from "@zakura/shared";
import type { AgentNativeToolDef } from "./agent-tools.js";
import type { ConnectionCatalogService } from "./connection-catalog.js";
import type { IntegrationCatalogService } from "./integration-catalog.js";
import type { Orchestrator } from "./orchestrator.js";
import type { RuntimeNodeService } from "./runtime-nodes.js";
import { mapRuntimeNode } from "./runtime-nodes.js";

const PLATFORM_TOOL_NAMES = new Set([
  "search_connections",
  "install_connection",
  "list_connections",
  "bind_connection",
  "set_connector_credentials",
  "list_runners",
  "migrate_instance",
  "fetch_url",
]);

const FETCH_MAX_BYTES = 200 * 1024;

export function isPlatformAssistantToolName(localName: string): boolean {
  return PLATFORM_TOOL_NAMES.has(localName);
}

/** 可选：组件实例跨 Runner 迁移（尚无正式服务时可 stub） */
export type InstanceMigrationPort = {
  migrate(
    tenantId: string,
    instanceId: string,
    targetNodeId: string,
  ): Promise<unknown>;
};

export type PlatformAssistantToolContext = {
  tenantId: string;
  agentId: string;
  connectionCatalog?: ConnectionCatalogService | null;
  integrations?: IntegrationCatalogService | null;
  runtimeNodes?: RuntimeNodeService | null;
  orchestrator?: Orchestrator | null;
  instanceMigrations?: InstanceMigrationPort | null;
};

function tool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  opts?: { title?: string; annotations?: McpToolAnnotations },
): AgentNativeToolDef {
  return {
    qualifiedName: name.startsWith("re_") ? name : `re_${name}`,
    instanceId: null,
    providerId: "zakura-agent",
    localName: name,
    description,
    inputSchema,
    title: opts?.title,
    annotations: opts?.annotations,
    builtin: true,
    agentScoped: true,
  };
}

function okJson(data: unknown): McpToolResult {
  return textResult(JSON.stringify(data, null, 2));
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function listPlatformAssistantTools(): AgentNativeToolDef[] {
  return [
    tool(
      "search_connections",
      "Search the unified connection catalog (platform connectors, MCP store, skills). Returns install_ref strings for re_install_connection.",
      {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords" },
          source: {
            type: "string",
            description:
              "Filter source: all | platform | mcp | mcp-official | skill | skill-curated | …",
          },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 40 },
          offset: { type: "integer", minimum: 0, default: 0 },
        },
      },
      { annotations: { readOnlyHint: true, openWorldHint: true } },
    ),
    tool(
      "install_connection",
      "Install a connection from an install_ref (mcp:…, curated:…, platform:…, zakura:…, skill source). Optionally bind to agents and pick a Runner for stdio MCP.",
      {
        type: "object",
        required: ["source"],
        properties: {
          source: { type: "string", description: "install_ref from search_connections" },
          name: { type: "string" },
          runtime_node_id: {
            type: "string",
            description: "Runner node id for stdio/Docker MCP (from list_runners)",
          },
          agent_ids: {
            type: "array",
            items: { type: "string" },
            description: "Agent ids to bind after install",
          },
          config: {
            type: "object",
            description: "Install extras: prefer, env, apiKey, remoteUrl, packageIndex, …",
          },
        },
      },
      { annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false } },
    ),
    tool(
      "list_connections",
      "List installed connections for this tenant (MCP instances + skills).",
      { type: "object", properties: {} },
      { annotations: { readOnlyHint: true, idempotentHint: true } },
    ),
    tool(
      "bind_connection",
      "Bind an installed connection to an agent. connection_id is like instance:<id> or skill:<id>.",
      {
        type: "object",
        required: ["connection_id", "agent_id"],
        properties: {
          connection_id: { type: "string" },
          agent_id: { type: "string" },
        },
      },
      { annotations: { readOnlyHint: false, idempotentHint: true } },
    ),
    tool(
      "set_connector_credentials",
      "Save credentials for a named connector auth profile (schema-driven fields). Connectors reference profiles by name, so one profile can serve several connectors. Never echoes secret values back — only configured field names / enabled state.",
      {
        type: "object",
        required: ["profile"],
        properties: {
          profile: {
            type: "string",
            description: "Auth profile key, e.g. the `auth.profile` of a connector from the connectors list",
          },
          connector_ref: {
            type: "string",
            description: "Alternative to `profile`: a connector ref whose profile should be configured",
          },
          values: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Field key → value map",
          },
          enabled: { type: "boolean", default: true },
          scope: {
            type: "string",
            enum: ["tenant", "platform"],
            default: "tenant",
          },
        },
      },
      { annotations: { readOnlyHint: false, destructiveHint: false } },
    ),
    tool(
      "list_runners",
      "List runtime nodes (local + remote runners) available for this tenant. Use ids with install_connection / migrate_instance.",
      { type: "object", properties: {} },
      { annotations: { readOnlyHint: true, idempotentHint: true } },
    ),
    tool(
      "migrate_instance",
      "Migrate a container/stdio MCP instance to another Runner (stop → move → start). Pass instance id (with or without instance: prefix).",
      {
        type: "object",
        required: ["instance_id", "target_node_id"],
        properties: {
          instance_id: { type: "string" },
          target_node_id: { type: "string" },
        },
      },
      { annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } },
    ),
    tool(
      "fetch_url",
      "Fetch a URL as plain text (max 200KB). Use for marketplace manifests, SKILL.md, or prompt files.",
      {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", description: "http(s) URL" },
        },
      },
      { annotations: { readOnlyHint: true, openWorldHint: true } },
    ),
  ];
}

export async function callPlatformAssistantTool(
  name: string,
  args: Record<string, unknown>,
  ctx: PlatformAssistantToolContext,
): Promise<McpToolResult> {
  try {
    switch (name) {
      case "search_connections": {
        if (!ctx.connectionCatalog) {
          return textResult("ConnectionCatalogService 未挂载", true);
        }
        const result = await ctx.connectionCatalog.search({
          tenantId: ctx.tenantId,
          q: str(args.query),
          source: str(args.source) ?? "all",
          limit: typeof args.limit === "number" ? args.limit : 40,
          offset: typeof args.offset === "number" ? args.offset : 0,
        });
        return okJson({
          total: result.total,
          items: result.items.map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description,
            kind: item.kind,
            source: item.source,
            auth: item.auth,
            needs_runner: item.needsRunner,
            install_ref: item.installRef,
            connector_id: item.connectorId,
            credential_fields: item.credentialFields,
          })),
          hint: "用 install_connection 传 source=<install_ref>；stdio 包先 list_runners 再传 runtime_node_id。",
        });
      }

      case "install_connection": {
        if (!ctx.connectionCatalog) {
          return textResult("ConnectionCatalogService 未挂载", true);
        }
        const source = str(args.source);
        if (!source) return textResult("source is required", true);
        const agentIds = Array.isArray(args.agent_ids)
          ? args.agent_ids.filter((id): id is string => typeof id === "string" && !!id.trim())
          : undefined;
        const result = await ctx.connectionCatalog.install(ctx.tenantId, {
          source,
          name: str(args.name),
          runtimeNodeId: str(args.runtime_node_id) ?? null,
          agentIds,
          config:
            args.config && typeof args.config === "object" && !Array.isArray(args.config)
              ? (args.config as Record<string, unknown>)
              : undefined,
        });
        return okJson(result);
      }

      case "list_connections": {
        if (!ctx.connectionCatalog) {
          return textResult("ConnectionCatalogService 未挂载", true);
        }
        const items = await ctx.connectionCatalog.listInstalled(ctx.tenantId);
        return okJson({ connections: items });
      }

      case "bind_connection": {
        if (!ctx.connectionCatalog) {
          return textResult("ConnectionCatalogService 未挂载", true);
        }
        const connectionId = str(args.connection_id);
        const agentId = str(args.agent_id);
        if (!connectionId || !agentId) {
          return textResult("connection_id and agent_id are required", true);
        }
        await ctx.connectionCatalog.bind(ctx.tenantId, connectionId, agentId);
        return okJson({ ok: true, connection_id: connectionId, agent_id: agentId });
      }

      case "set_connector_credentials": {
        if (!ctx.integrations) {
          return textResult("IntegrationCatalogService 未挂载", true);
        }
        const scope = str(args.scope) === "platform" ? "platform" : "tenant";
        const scopeKey = scope === "platform" ? "platform" : ctx.tenantId;
        const connectorRef = str(args.connector_ref);
        let profileKey = str(args.profile);
        if (!profileKey && connectorRef) {
          const connector = (await ctx.integrations.listConnectors(scopeKey)).find(
            (item) => item.ref === connectorRef,
          );
          profileKey = connector?.auth.profile ?? "";
        }
        if (!profileKey) return textResult("profile or connector_ref is required", true);
        const values =
          args.values && typeof args.values === "object" && !Array.isArray(args.values)
            ? (args.values as Record<string, unknown>)
            : {};
        const saved = await ctx.integrations.saveProfile(scopeKey, profileKey, {
          enabled: typeof args.enabled === "boolean" ? args.enabled : true,
          values,
        });
        // 不回显 values / secrets
        return okJson({
          ok: true,
          profile: saved?.key ?? profileKey,
          label: saved?.label,
          kind: saved?.kind,
          enabled: saved?.enabled ?? false,
          configured_fields: saved?.configuredFields ?? [],
          connector_refs: saved?.connectorRefs ?? [],
          scope,
        });
      }

      case "list_runners": {
        if (!ctx.runtimeNodes) {
          return textResult("RuntimeNodeService 未挂载", true);
        }
        const nodes = await ctx.runtimeNodes.listAccessible(ctx.tenantId);
        return okJson({
          runners: nodes.map((n) =>
            mapRuntimeNode(n, { access: n.access }),
          ),
        });
      }

      case "migrate_instance": {
        const rawId = str(args.instance_id);
        const targetNodeId = str(args.target_node_id);
        if (!rawId || !targetNodeId) {
          return textResult("instance_id and target_node_id are required", true);
        }
        const instanceId = rawId.startsWith("instance:")
          ? rawId.slice("instance:".length)
          : rawId;
        if (!ctx.instanceMigrations) {
          return textResult("Instance migration not implemented", true);
        }
        const result = await ctx.instanceMigrations.migrate(
          ctx.tenantId,
          instanceId,
          targetNodeId,
        );
        return okJson(result);
      }

      case "fetch_url": {
        const url = str(args.url);
        if (!url) return textResult("url is required", true);
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return textResult("Invalid URL", true);
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return textResult("Only http(s) URLs are allowed", true);
        }
        const res = await fetch(parsed, {
          redirect: "follow",
          headers: { Accept: "text/*, application/json, */*" },
        });
        if (!res.ok) {
          return textResult(`HTTP ${res.status} ${res.statusText}`, true);
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        const truncated = buf.byteLength > FETCH_MAX_BYTES;
        const slice = truncated ? buf.subarray(0, FETCH_MAX_BYTES) : buf;
        const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
        if (truncated) {
          return textResult(
            `${text}\n\n…(truncated at ${FETCH_MAX_BYTES} bytes; original ${buf.byteLength})`,
          );
        }
        return textResult(text);
      }

      default:
        return textResult(`Unknown platform assistant tool: ${name}`, true);
    }
  } catch (err) {
    return textResult(err instanceof Error ? err.message : String(err), true);
  }
}
