import type { McpToolDef } from "@zakura/shared";
import { createOauthRestProvider, int, restJson, str } from "../oauth-rest.js";

const PRODUCTS = ["pages", "databases", "users"] as const;

const toolDefs: Record<(typeof PRODUCTS)[number], McpToolDef[]> = {
  pages: [
    { name: "search", description: "Search Notion pages and databases.", inputSchema: { type: "object", properties: { query: { type: "string" }, page_size: { type: "integer" } } } },
    { name: "get_page", description: "Retrieve a Notion page by id.", inputSchema: { type: "object", required: ["page_id"], properties: { page_id: { type: "string" } } } },
    { name: "create_page", description: "Create a Notion page under a parent.", inputSchema: { type: "object", required: ["parent", "properties"], properties: { parent: { type: "object" }, properties: { type: "object" }, children: { type: "array" } } } },
    { name: "append_blocks", description: "Append blocks to a page or block.", inputSchema: { type: "object", required: ["block_id", "children"], properties: { block_id: { type: "string" }, children: { type: "array" } } } },
    { name: "list_children", description: "List child blocks.", inputSchema: { type: "object", required: ["block_id"], properties: { block_id: { type: "string" }, page_size: { type: "integer" } } } },
  ],
  databases: [
    { name: "get_database", description: "Retrieve a database.", inputSchema: { type: "object", required: ["database_id"], properties: { database_id: { type: "string" } } } },
    { name: "query_database", description: "Query a database.", inputSchema: { type: "object", required: ["database_id"], properties: { database_id: { type: "string" }, filter: { type: "object" }, sorts: { type: "array" }, page_size: { type: "integer" } } } },
  ],
  users: [
    { name: "list_users", description: "List workspace users.", inputSchema: { type: "object", properties: { page_size: { type: "integer" } } } },
    { name: "get_me", description: "Get the bot/user identity.", inputSchema: { type: "object", properties: {} } },
  ],
};

async function notionFetch<T>(token: string, path: string, init?: RequestInit & { json?: unknown }) {
  return restJson<T>(`https://api.notion.com/v1${path}`, token, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      "Notion-Version": "2022-06-28",
    },
  });
}

const factory = createOauthRestProvider({
  id: "notion",
  name: "Notion",
  description: "平台直接调用 Notion API，提供页面、数据库与用户工具。",
  products: PRODUCTS,
  toolDefs,
  health: async (token) => {
    await notionFetch(token, "/users/me");
  },
  async callTool(product, name, token, args) {
    const pageSize = int(args, "page_size", 20);
    if (product === "pages") {
      if (name === "search") {
        return notionFetch(token, "/search", {
          method: "POST",
          json: { query: str(args, "query") || undefined, page_size: pageSize },
        });
      }
      if (name === "get_page") return notionFetch(token, `/pages/${encodeURIComponent(str(args, "page_id"))}`);
      if (name === "create_page") {
        return notionFetch(token, "/pages", {
          method: "POST",
          json: {
            parent: args.parent,
            properties: args.properties,
            children: args.children,
          },
        });
      }
      if (name === "append_blocks") {
        return notionFetch(token, `/blocks/${encodeURIComponent(str(args, "block_id"))}/children`, {
          method: "PATCH",
          json: { children: args.children },
        });
      }
      if (name === "list_children") {
        const qs = pageSize ? `?page_size=${pageSize}` : "";
        return notionFetch(token, `/blocks/${encodeURIComponent(str(args, "block_id"))}/children${qs}`);
      }
    }
    if (product === "databases") {
      if (name === "get_database") {
        return notionFetch(token, `/databases/${encodeURIComponent(str(args, "database_id"))}`);
      }
      if (name === "query_database") {
        return notionFetch(token, `/databases/${encodeURIComponent(str(args, "database_id"))}/query`, {
          method: "POST",
          json: {
            filter: args.filter,
            sorts: args.sorts,
            page_size: pageSize,
          },
        });
      }
    }
    if (product === "users") {
      if (name === "list_users") {
        const qs = pageSize ? `?page_size=${pageSize}` : "";
        return notionFetch(token, `/users${qs}`);
      }
      if (name === "get_me") return notionFetch(token, "/users/me");
    }
    throw new Error(`Unknown Notion tool: ${name}`);
  },
});

export const createNotionProvider = factory.createProvider;
export const injectNotionRuntime = factory.injectRuntime;
export const resolveNotionProduct = factory.resolveProduct;
export const notionBuiltinUrl = factory.builtinUrl;
