import type { InstanceHandle, ProviderPlugin } from "@zakura/core";
import { textResult } from "@zakura/core";
import type { McpToolDef, ProviderConfigSchema } from "@zakura/shared";
import { eq } from "drizzle-orm";
import { componentInstances } from "../../db/schema.js";
import type { AppConfig } from "../../config.js";
import { McpUpstreamOauthService } from "../../services/mcp-upstream-oauth.js";
import { applyOauthTokensToConfig } from "../generic-mcp.js";

type SlackProduct = "channels" | "messages" | "users";
const PRODUCTS: SlackProduct[] = ["channels", "messages", "users"];

const configSchema: ProviderConfigSchema = {
  type: "object",
  title: "Slack",
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

export function injectSlackRuntime(config: AppConfig, db: unknown): void {
  appConfigRef = config;
  dbRef = db;
}

export function slackBuiltinUrl(product: SlackProduct): string {
  return `zakura://slack/${product}`;
}

export function resolveSlackProduct(value: string): SlackProduct | null {
  const raw = value.trim().toLowerCase();
  if (PRODUCTS.includes(raw as SlackProduct)) return raw as SlackProduct;
  const matched = raw.match(/^zakura:\/\/slack\/(channels|messages|users)$/);
  return matched ? (matched[1] as SlackProduct) : null;
}

function parseProduct(config: Record<string, unknown>): SlackProduct {
  const value =
    typeof config.product === "string"
      ? config.product
      : typeof config.mcpUrl === "string"
        ? config.mcpUrl
        : "";
  const product = resolveSlackProduct(value);
  if (!product) throw new Error("config.product 须为 channels | messages | users");
  return product;
}

async function slackApi<T>(
  token: string,
  method: string,
  params?: Record<string, string | undefined>,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = new URL(`https://slack.com/api/${method}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== "") url.searchParams.set(key, value);
    }
  }
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (body) headers.set("Content-Type", "application/json; charset=utf-8");
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await response.json()) as T & { ok?: boolean; error?: string };
  if (!response.ok || (json as { ok?: boolean }).ok === false) {
    throw new Error(`Slack ${method}: ${(json as { error?: string }).error ?? response.status}`);
  }
  return json;
}

const toolDefs: Record<SlackProduct, McpToolDef[]> = {
  channels: [
    { name: "list_channels", description: "List conversations the bot can see.", inputSchema: { type: "object", properties: { types: { type: "string" }, limit: { type: "integer" } } } },
    { name: "get_channel", description: "Get channel info by id.", inputSchema: { type: "object", required: ["channel"], properties: { channel: { type: "string" } } } },
  ],
  messages: [
    { name: "history", description: "Fetch recent channel messages.", inputSchema: { type: "object", required: ["channel"], properties: { channel: { type: "string" }, limit: { type: "integer" } } } },
    { name: "post_message", description: "Post a message to a channel.", inputSchema: { type: "object", required: ["channel", "text"], properties: { channel: { type: "string" }, text: { type: "string" }, thread_ts: { type: "string" } } } },
  ],
  users: [
    { name: "list_users", description: "List workspace users.", inputSchema: { type: "object", properties: { limit: { type: "integer" } } } },
    { name: "get_user", description: "Get a user by id.", inputSchema: { type: "object", required: ["user"], properties: { user: { type: "string" } } } },
  ],
};

async function callSlackTool(
  token: string,
  product: SlackProduct,
  name: string,
  args: Record<string, unknown>,
) {
  const limit = String(Math.min(Math.max(Number(args.limit) || 50, 1), 200));
  if (product === "channels") {
    if (name === "list_channels") {
      return slackApi(token, "conversations.list", {
        types: String(args.types ?? "public_channel,private_channel"),
        limit,
      });
    }
    if (name === "get_channel") {
      return slackApi(token, "conversations.info", { channel: String(args.channel) });
    }
  }
  if (product === "messages") {
    if (name === "history") {
      return slackApi(token, "conversations.history", {
        channel: String(args.channel),
        limit,
      });
    }
    if (name === "post_message") {
      return slackApi(token, "chat.postMessage", undefined, {
        channel: String(args.channel),
        text: String(args.text),
        thread_ts: args.thread_ts ? String(args.thread_ts) : undefined,
      });
    }
  }
  if (product === "users") {
    if (name === "list_users") return slackApi(token, "users.list", { limit });
    if (name === "get_user") return slackApi(token, "users.info", { user: String(args.user) });
  }
  throw new Error(`Unknown Slack tool: ${name}`);
}

async function accessToken(handle: InstanceHandle): Promise<string> {
  let current = { ...handle.config };
  const expiresAt = Number(current.oauthExpiresAt ?? 0);
  if (
    (!current.oauthAccessToken || expiresAt <= Math.floor(Date.now() / 1000) + 120) &&
    current.oauthRefreshToken &&
    current.oauthClientId &&
    appConfigRef
  ) {
    const tokenEndpoint = String(current.oauthTokenEndpoint ?? "").trim();
    if (!tokenEndpoint) throw new Error("Slack OAuth 配置缺少 token endpoint");
    const tokens = await new McpUpstreamOauthService(appConfigRef).refresh({
      accessToken: String(current.oauthAccessToken ?? ""),
      refreshToken: String(current.oauthRefreshToken),
      expiresAt,
      clientId: String(current.oauthClientId),
      clientSecret:
        typeof current.oauthClientSecret === "string" ? current.oauthClientSecret : undefined,
      tokenEndpoint,
    });
    current = applyOauthTokensToConfig(current, tokens);
    current.authRequired = false;
    handle.config = current;
    if (dbRef) {
      const { encryptJson } = await import("@zakura/core");
      await dbRef
        .update(componentInstances)
        .set({ configEnc: encryptJson(appConfigRef.secret, current), updatedAt: new Date() })
        .where(eq(componentInstances.id, handle.id));
    }
  }
  const token = String(current.oauthAccessToken ?? "").trim();
  if (!token) throw new Error("AUTH_REQUIRED: 请先完成 Slack OAuth 授权");
  return token;
}

export function createSlackProvider(): ProviderPlugin {
  return {
    id: "slack",
    name: "Slack",
    description: "平台直接调用 Slack Web API，提供频道、消息与用户工具。",
    version: "1.0.0",
    category: "connector",
    capabilities: ["tools", "builtin"],
    configSchema,
    validateConfig(config) {
      const product = parseProduct(config);
      return { ...config, product, mcpUrl: slackBuiltinUrl(product) };
    },
    createRuntimeSpec(config) {
      return { containers: [], endpointTemplate: slackBuiltinUrl(parseProduct(config)) };
    },
    async healthCheck(handle) {
      try {
        const token = await accessToken(handle);
        await slackApi(token, "auth.test");
        return { status: "healthy", message: `ok (${parseProduct(handle.config)})` };
      } catch (error) {
        return {
          status: "unhealthy",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async listTools(handle) {
      return toolDefs[parseProduct(handle.config)];
    },
    async callTool(handle, name, args) {
      try {
        return textResult(
          JSON.stringify(
            await callSlackTool(
              await accessToken(handle),
              parseProduct(handle.config),
              name,
              args,
            ),
            null,
            2,
          ),
        );
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  };
}
