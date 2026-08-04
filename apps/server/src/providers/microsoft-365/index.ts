import type { InstanceHandle, ProviderPlugin } from "@zakura/core";
import { textResult } from "@zakura/core";
import type { McpToolDef, ProviderConfigSchema } from "@zakura/shared";
import { eq } from "drizzle-orm";
import { componentInstances } from "../../db/schema.js";
import type { AppConfig } from "../../config.js";
import { McpUpstreamOauthService } from "../../services/mcp-upstream-oauth.js";
import { applyOauthTokensToConfig } from "../generic-mcp.js";

type MicrosoftProduct = "outlook" | "files" | "teams" | "directory";

const PRODUCTS: MicrosoftProduct[] = ["outlook", "files", "teams", "directory"];

const configSchema: ProviderConfigSchema = {
  type: "object",
  title: "Microsoft 365",
  required: ["product"],
  properties: {
    product: { type: "string", enum: PRODUCTS },
    oauthAccessToken: { type: "string", format: "password" },
    oauthRefreshToken: { type: "string", format: "password" },
    oauthExpiresAt: { type: "number" },
    oauthClientId: { type: "string" },
    oauthClientSecret: { type: "string", format: "password" },
    oauthTokenEndpoint: { type: "string" },
    authRequired: { type: "boolean" },
  },
};

let appConfigRef: AppConfig | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dbRef: any = null;

export function injectMicrosoft365Runtime(config: AppConfig, db: unknown): void {
  appConfigRef = config;
  dbRef = db;
}

export function microsoft365BuiltinUrl(product: MicrosoftProduct): string {
  return `zakura://microsoft-365/${product}`;
}

export function resolveMicrosoft365Product(value: string): MicrosoftProduct | null {
  const raw = value.trim().toLowerCase();
  if (PRODUCTS.includes(raw as MicrosoftProduct)) return raw as MicrosoftProduct;
  const matched = raw.match(/^zakura:\/\/microsoft-365\/(outlook|files|teams|directory)$/);
  return matched ? matched[1] as MicrosoftProduct : null;
}

function parseProduct(config: Record<string, unknown>): MicrosoftProduct {
  const value = typeof config.product === "string"
    ? config.product
    : typeof config.mcpUrl === "string" ? config.mcpUrl : "";
  const product = resolveMicrosoft365Product(value);
  if (!product) throw new Error("config.product 须为 outlook | files | teams | directory");
  return product;
}

async function graphFetch<T>(token: string, path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init?.json !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...init,
    headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    signal: init?.signal ?? AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Microsoft Graph ${response.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) as T : {} as T;
}

const toolDefs: Record<MicrosoftProduct, McpToolDef[]> = {
  outlook: [
    { name: "search_messages", description: "Search Outlook messages.", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, top: { type: "integer" } } } },
    { name: "get_message", description: "Get an Outlook message by id.", inputSchema: { type: "object", required: ["messageId"], properties: { messageId: { type: "string" } } } },
    { name: "create_draft", description: "Create an Outlook draft.", inputSchema: { type: "object", required: ["subject", "to"], properties: { subject: { type: "string" }, body: { type: "string" }, to: { type: "array", items: { type: "string" } } } } },
    { name: "send_mail", description: "Send an Outlook email.", inputSchema: { type: "object", required: ["subject", "to"], properties: { subject: { type: "string" }, body: { type: "string" }, to: { type: "array", items: { type: "string" } } } } },
    { name: "list_events", description: "List upcoming calendar events.", inputSchema: { type: "object", properties: { start: { type: "string" }, end: { type: "string" }, top: { type: "integer" } } } },
  ],
  files: [
    { name: "search_files", description: "Search OneDrive files.", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, top: { type: "integer" } } } },
    { name: "get_file", description: "Get OneDrive item metadata.", inputSchema: { type: "object", required: ["itemId"], properties: { itemId: { type: "string" } } } },
    { name: "list_recent_files", description: "List recently used files.", inputSchema: { type: "object", properties: { top: { type: "integer" } } } },
  ],
  teams: [
    { name: "list_teams", description: "List joined Microsoft Teams.", inputSchema: { type: "object", properties: {} } },
    { name: "list_channels", description: "List channels in a team.", inputSchema: { type: "object", required: ["teamId"], properties: { teamId: { type: "string" } } } },
    { name: "list_channel_messages", description: "List channel messages.", inputSchema: { type: "object", required: ["teamId", "channelId"], properties: { teamId: { type: "string" }, channelId: { type: "string" }, top: { type: "integer" } } } },
    { name: "send_channel_message", description: "Send a channel message.", inputSchema: { type: "object", required: ["teamId", "channelId", "content"], properties: { teamId: { type: "string" }, channelId: { type: "string" }, content: { type: "string" } } } },
  ],
  directory: [
    { name: "get_my_profile", description: "Get the signed-in Microsoft profile.", inputSchema: { type: "object", properties: {} } },
    { name: "search_users", description: "Search users in the organization directory.", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, top: { type: "integer" } } } },
    { name: "get_user", description: "Get an organization user by id or UPN.", inputSchema: { type: "object", required: ["userId"], properties: { userId: { type: "string" } } } },
  ],
};

function message(input: Record<string, unknown>) {
  const to = Array.isArray(input.to) ? input.to.map(String) : [];
  return {
    subject: String(input.subject ?? ""),
    body: { contentType: "Text", content: String(input.body ?? "") },
    toRecipients: to.map((address) => ({ emailAddress: { address } })),
  };
}

async function callGraphTool(token: string, product: MicrosoftProduct, name: string, args: Record<string, unknown>) {
  const top = Math.min(Math.max(Number(args.top) || 20, 1), 50);
  if (product === "outlook") {
    if (name === "search_messages") {
      const query = new URLSearchParams({ $search: `\"${String(args.query)}\"`, $top: String(top) });
      return graphFetch(token, `/me/messages?${query}`);
    }
    if (name === "get_message") return graphFetch(token, `/me/messages/${encodeURIComponent(String(args.messageId))}`);
    if (name === "create_draft") return graphFetch(token, "/me/messages", { method: "POST", json: message(args) });
    if (name === "send_mail") return graphFetch(token, "/me/sendMail", { method: "POST", json: { message: message(args), saveToSentItems: true } });
    if (name === "list_events") {
      const start = String(args.start ?? new Date().toISOString());
      const end = String(args.end ?? new Date(Date.now() + 7 * 86400_000).toISOString());
      const query = new URLSearchParams({ startDateTime: start, endDateTime: end, $top: String(top) });
      return graphFetch(token, `/me/calendarView?${query}`);
    }
  }
  if (product === "files") {
    if (name === "search_files") {
      const value = String(args.query).replaceAll("'", "''");
      const literal = encodeURIComponent(`'${value}'`).replaceAll("'", "%27");
      return graphFetch(token, `/me/drive/root/search(q=${literal})?${new URLSearchParams({ $top: String(top) })}`);
    }
    if (name === "get_file") return graphFetch(token, `/me/drive/items/${encodeURIComponent(String(args.itemId))}`);
    if (name === "list_recent_files") return graphFetch(token, `/me/drive/recent?$top=${top}`);
  }
  if (product === "teams") {
    if (name === "list_teams") return graphFetch(token, "/me/joinedTeams");
    const teamId = encodeURIComponent(String(args.teamId));
    if (name === "list_channels") return graphFetch(token, `/teams/${teamId}/channels`);
    const channelId = encodeURIComponent(String(args.channelId));
    if (name === "list_channel_messages") return graphFetch(token, `/teams/${teamId}/channels/${channelId}/messages?$top=${top}`);
    if (name === "send_channel_message") return graphFetch(token, `/teams/${teamId}/channels/${channelId}/messages`, { method: "POST", json: { body: { content: String(args.content) } } });
  }
  if (product === "directory") {
    if (name === "get_my_profile") return graphFetch(token, "/me");
    if (name === "search_users") {
      const q = String(args.query).replaceAll("'", "''");
      const query = new URLSearchParams({
        $filter: `startsWith(displayName,'${q}') or startsWith(mail,'${q}')`,
        $top: String(top),
      });
      return graphFetch(token, `/users?${query}`);
    }
    if (name === "get_user") return graphFetch(token, `/users/${encodeURIComponent(String(args.userId))}`);
  }
  throw new Error(`Unknown Microsoft 365 tool: ${name}`);
}

async function accessToken(handle: InstanceHandle): Promise<string> {
  let current = { ...handle.config };
  const expiresAt = Number(current.oauthExpiresAt ?? 0);
  if ((!current.oauthAccessToken || expiresAt <= Math.floor(Date.now() / 1000) + 120) && current.oauthRefreshToken && current.oauthClientId && appConfigRef) {
    const tokenEndpoint = String(current.oauthTokenEndpoint ?? "").trim();
    if (!tokenEndpoint) throw new Error("Microsoft OAuth 配置缺少 token endpoint");
    const tokens = await new McpUpstreamOauthService(appConfigRef).refresh({
      accessToken: String(current.oauthAccessToken ?? ""),
      refreshToken: String(current.oauthRefreshToken),
      expiresAt,
      clientId: String(current.oauthClientId),
      clientSecret: typeof current.oauthClientSecret === "string" ? current.oauthClientSecret : undefined,
      tokenEndpoint,
    });
    current = applyOauthTokensToConfig(current, tokens);
    current.authRequired = false;
    handle.config = current;
    if (dbRef) {
      const { encryptJson } = await import("@zakura/core");
      await dbRef.update(componentInstances).set({ configEnc: encryptJson(appConfigRef.secret, current), updatedAt: new Date() }).where(eq(componentInstances.id, handle.id));
    }
  }
  const token = String(current.oauthAccessToken ?? "").trim();
  if (!token) throw new Error("AUTH_REQUIRED: 请先完成 Microsoft OAuth 授权");
  return token;
}

export function createMicrosoft365Provider(): ProviderPlugin {
  return {
    id: "microsoft-365",
    name: "Microsoft 365",
    description: "平台直接调用 Microsoft Graph，提供 Outlook、文件、Teams 和组织目录工具。",
    version: "1.0.0",
    category: "connector",
    capabilities: ["tools", "builtin"],
    configSchema,
    validateConfig(config) {
      const product = parseProduct(config);
      return { ...config, product, mcpUrl: microsoft365BuiltinUrl(product) };
    },
    createRuntimeSpec(config) {
      return { containers: [], endpointTemplate: microsoft365BuiltinUrl(parseProduct(config)) };
    },
    async healthCheck(handle) {
      try {
        const token = await accessToken(handle);
        await graphFetch(token, "/me?$select=id");
        return { status: "healthy", message: `ok (${parseProduct(handle.config)})` };
      } catch (error) {
        return { status: "unhealthy", message: error instanceof Error ? error.message : String(error) };
      }
    },
    async listTools(handle) { return toolDefs[parseProduct(handle.config)]; },
    async callTool(handle, name, args) {
      try { return textResult(JSON.stringify(await callGraphTool(await accessToken(handle), parseProduct(handle.config), name, args), null, 2)); }
      catch (error) { return textResult(error instanceof Error ? error.message : String(error), true); }
    },
  };
}
