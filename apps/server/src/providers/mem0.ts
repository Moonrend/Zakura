import { and, desc, eq, ilike } from "drizzle-orm";
import type { ProviderPlugin } from "@zakura/core";
import { textResult } from "@zakura/core";
import type {
  HealthResult,
  McpToolDef,
  McpToolResult,
  ProviderConfigSchema,
  RuntimeSpec,
} from "@zakura/shared";
import type { Db } from "../db/client.js";
import { memories, newId } from "../db/schema.js";

/**
 * Built-in / legacy catalog entry labeled "mem0".
 * This is NOT the real mem0 stack (no embedder / vector DB here).
 * Prefer tenant Memory Providers: builtin | traditional | mem0(remote) | openviking.
 */
const configSchema: ProviderConfigSchema = {
  type: "object",
  title: "记忆",
  required: [],
  properties: {
    enabled: {
      type: "boolean",
      title: "启用",
      default: true,
    },
    defaultUserId: {
      type: "string",
      title: "默认 user_id",
      default: "default",
    },
  },
};

function messagesToContent(messages: unknown): string {
  if (typeof messages === "string") return messages;
  if (!Array.isArray(messages)) return JSON.stringify(messages ?? "");
  return messages
    .map((m) => {
      if (!m || typeof m !== "object") return String(m);
      const row = m as { role?: string; content?: string };
      return `${row.role ?? "user"}: ${row.content ?? ""}`;
    })
    .join("\n");
}

type Injectable = ProviderPlugin & { __injectDb?: (db: Db) => void };

export function createMem0Provider(): ProviderPlugin {
  let dbRef: Db | undefined;

  const plugin: Injectable = {
    id: "mem0",
    name: "Memory (legacy)",
    description:
      "遗留能力面板：进程内关键词记忆。真·mem0 请在「记忆 Provider」里配置远程 mem0（需其侧 embedding+向量库）",
    version: "0.4.0",
    category: "memory",
    capabilities: ["memory", "tools", "builtin"],
    configSchema,

    __injectDb(db: Db) {
      dbRef = db;
    },

    validateConfig(config) {
      return {
        enabled: config.enabled !== false,
        defaultUserId:
          typeof config.defaultUserId === "string" && config.defaultUserId.trim()
            ? config.defaultUserId.trim()
            : "default",
      };
    },

    createRuntimeSpec(_config, ctx): RuntimeSpec {
      if (ctx.db) dbRef = ctx.db as Db;
      return { containers: [], endpointTemplate: "builtin://memory" };
    },

    async afterStart(_handle, ctx) {
      if (ctx.db) dbRef = ctx.db as Db;
    },

    async healthCheck(): Promise<HealthResult> {
      return { status: dbRef ? "healthy" : "unhealthy", message: dbRef ? "builtin" : "db not ready" };
    },

    async listTools(handle): Promise<McpToolDef[]> {
      if (handle.config.enabled === false) return [];
      return [
        {
          name: "add_memory",
          description: "写入记忆",
          inputSchema: {
            type: "object",
            required: ["messages"],
            properties: {
              messages: {
                type: "array",
                items: {
                  type: "object",
                  properties: { role: { type: "string" }, content: { type: "string" } },
                },
              },
              user_id: { type: "string" },
              agent_id: { type: "string" },
              metadata: { type: "object" },
            },
          },
        },
        {
          name: "search_memory",
          description: "搜索记忆",
          inputSchema: {
            type: "object",
            required: ["query"],
            properties: {
              query: { type: "string" },
              user_id: { type: "string" },
              agent_id: { type: "string" },
              limit: { type: "number", default: 5 },
            },
          },
        },
        {
          name: "list_memories",
          description: "列出记忆",
          inputSchema: {
            type: "object",
            properties: {
              user_id: { type: "string" },
              agent_id: { type: "string" },
              limit: { type: "number", default: 50 },
            },
          },
        },
      ];
    },

    async callTool(handle, toolName, args): Promise<McpToolResult> {
      try {
        if (handle.config.enabled === false) {
          return textResult("Memory is disabled", true);
        }
        if (!dbRef) return textResult("memory store not ready", true);
        const defaultUser = String(handle.config.defaultUserId ?? "default");

        if (toolName === "add_memory") {
          const content = messagesToContent(args.messages);
          const [row] = await dbRef
            .insert(memories)
            .values({
              id: newId(),
              tenantId: handle.tenantId,
              instanceId: handle.id,
              userId: typeof args.user_id === "string" ? args.user_id : defaultUser,
              agentId: typeof args.agent_id === "string" ? args.agent_id : null,
              content,
              metadataJson: JSON.stringify(args.metadata ?? {}),
            })
            .returning();
          return textResult(JSON.stringify({ id: row.id, content: row.content }, null, 2));
        }

        if (toolName === "search_memory") {
          const query = String(args.query ?? "").trim();
          if (!query) return textResult("query is required", true);
          const limit = typeof args.limit === "number" ? args.limit : 5;
          const conditions = [
            eq(memories.tenantId, handle.tenantId),
            eq(memories.instanceId, handle.id),
            ilike(memories.content, `%${query.replace(/[%_]/g, "\\$&")}%`),
          ];
          if (typeof args.user_id === "string") conditions.push(eq(memories.userId, args.user_id));
          if (typeof args.agent_id === "string") {
            conditions.push(eq(memories.agentId, args.agent_id));
          }

          const rows = await dbRef
            .select()
            .from(memories)
            .where(and(...conditions))
            .orderBy(desc(memories.createdAt))
            .limit(limit);

          return textResult(
            JSON.stringify(
              {
                results: rows.map((r) => ({
                  id: r.id,
                  memory: r.content,
                  user_id: r.userId,
                  agent_id: r.agentId,
                  created_at: r.createdAt,
                })),
              },
              null,
              2,
            ),
          );
        }

        if (toolName === "list_memories") {
          const limit = typeof args.limit === "number" ? args.limit : 50;
          const conditions = [
            eq(memories.tenantId, handle.tenantId),
            eq(memories.instanceId, handle.id),
          ];
          if (typeof args.user_id === "string") conditions.push(eq(memories.userId, args.user_id));
          if (typeof args.agent_id === "string") {
            conditions.push(eq(memories.agentId, args.agent_id));
          }

          const rows = await dbRef
            .select()
            .from(memories)
            .where(and(...conditions))
            .orderBy(desc(memories.createdAt))
            .limit(limit);

          return textResult(
            JSON.stringify(
              {
                memories: rows.map((r) => ({
                  id: r.id,
                  memory: r.content,
                  user_id: r.userId,
                  agent_id: r.agentId,
                  created_at: r.createdAt,
                })),
              },
              null,
              2,
            ),
          );
        }

        return textResult(`Unknown tool: ${toolName}`, true);
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  };

  return plugin;
}

export function injectMem0Db(plugin: ProviderPlugin, db: Db): void {
  (plugin as Injectable).__injectDb?.(db);
}
