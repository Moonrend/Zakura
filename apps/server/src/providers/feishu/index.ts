import type { McpToolDef } from "@zakura/shared";
import { createOauthRestProvider, int, restJson, str } from "../oauth-rest.js";

const PRODUCTS = ["docs", "bitable", "im"] as const;

const toolDefs: Record<(typeof PRODUCTS)[number], McpToolDef[]> = {
  docs: [
    { name: "get_document", description: "Get a Feishu document meta.", inputSchema: { type: "object", required: ["document_id"], properties: { document_id: { type: "string" } } } },
    { name: "get_raw_content", description: "Get document plain text content.", inputSchema: { type: "object", required: ["document_id"], properties: { document_id: { type: "string" } } } },
    { name: "list_blocks", description: "List document blocks.", inputSchema: { type: "object", required: ["document_id"], properties: { document_id: { type: "string" }, page_size: { type: "integer" } } } },
  ],
  bitable: [
    { name: "list_tables", description: "List bitable tables.", inputSchema: { type: "object", required: ["app_token"], properties: { app_token: { type: "string" } } } },
    { name: "search_records", description: "Search bitable records.", inputSchema: { type: "object", required: ["app_token", "table_id"], properties: { app_token: { type: "string" }, table_id: { type: "string" }, page_size: { type: "integer" } } } },
  ],
  im: [
    { name: "get_current_user", description: "Get authorized Feishu user.", inputSchema: { type: "object", properties: {} } },
    { name: "list_chats", description: "List chats the user can access.", inputSchema: { type: "object", properties: { page_size: { type: "integer" } } } },
    { name: "send_message", description: "Send a text message to a chat.", inputSchema: { type: "object", required: ["receive_id", "text"], properties: { receive_id: { type: "string" }, receive_id_type: { type: "string" }, text: { type: "string" } } } },
  ],
};

async function feishuFetch<T>(token: string, path: string, init?: RequestInit & { json?: unknown }) {
  return restJson<T>(`https://open.feishu.cn/open-apis${path}`, token, init);
}

const factory = createOauthRestProvider({
  id: "feishu",
  name: "飞书",
  description: "平台直接调用飞书 Open API，提供文档、多维表格与即时消息工具。",
  products: PRODUCTS,
  toolDefs,
  health: async (token) => {
    await feishuFetch(token, "/authen/v1/user_info");
  },
  async callTool(product, name, token, args) {
    const pageSize = int(args, "page_size", 20);
    if (product === "docs") {
      const docId = encodeURIComponent(str(args, "document_id"));
      if (name === "get_document") return feishuFetch(token, `/docx/v1/documents/${docId}`);
      if (name === "get_raw_content") {
        return feishuFetch(token, `/docx/v1/documents/${docId}/raw_content`);
      }
      if (name === "list_blocks") {
        return feishuFetch(
          token,
          `/docx/v1/documents/${docId}/blocks?page_size=${pageSize ?? 20}`,
        );
      }
    }
    if (product === "bitable") {
      const app = encodeURIComponent(str(args, "app_token"));
      if (name === "list_tables") return feishuFetch(token, `/bitable/v1/apps/${app}/tables`);
      if (name === "search_records") {
        const table = encodeURIComponent(str(args, "table_id"));
        return feishuFetch(token, `/bitable/v1/apps/${app}/tables/${table}/records/search`, {
          method: "POST",
          json: { page_size: pageSize },
        });
      }
    }
    if (product === "im") {
      if (name === "get_current_user") return feishuFetch(token, "/authen/v1/user_info");
      if (name === "list_chats") {
        return feishuFetch(token, `/im/v1/chats?page_size=${pageSize ?? 20}`);
      }
      if (name === "send_message") {
        const idType = str(args, "receive_id_type") || "chat_id";
        return feishuFetch(token, `/im/v1/messages?receive_id_type=${encodeURIComponent(idType)}`, {
          method: "POST",
          json: {
            receive_id: str(args, "receive_id"),
            msg_type: "text",
            content: JSON.stringify({ text: str(args, "text") }),
          },
        });
      }
    }
    throw new Error(`Unknown Feishu tool: ${name}`);
  },
});

export const createFeishuProvider = factory.createProvider;
export const injectFeishuRuntime = factory.injectRuntime;
export const resolveFeishuProduct = factory.resolveProduct;
export const feishuBuiltinUrl = factory.builtinUrl;
