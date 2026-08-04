import type { McpToolDef } from "@zakura/shared";
import { createOauthRestProvider, int, restJson, str } from "../oauth-rest.js";

const PRODUCTS = ["guilds", "user"] as const;

const toolDefs: Record<(typeof PRODUCTS)[number], McpToolDef[]> = {
  guilds: [
    { name: "list_guilds", description: "List guilds for the current user.", inputSchema: { type: "object", properties: { limit: { type: "integer" } } } },
    { name: "get_guild", description: "Get guild details (requires guilds scope + membership).", inputSchema: { type: "object", required: ["guild_id"], properties: { guild_id: { type: "string" } } } },
  ],
  user: [
    { name: "get_me", description: "Get the authorized Discord user.", inputSchema: { type: "object", properties: {} } },
    { name: "list_connections", description: "List linked account connections.", inputSchema: { type: "object", properties: {} } },
  ],
};

async function discordFetch<T>(token: string, path: string) {
  return restJson<T>(`https://discord.com/api/v10${path}`, token);
}

const factory = createOauthRestProvider({
  id: "discord",
  name: "Discord",
  description: "平台直接调用 Discord API，提供服务器与用户资料工具。",
  products: PRODUCTS,
  toolDefs,
  health: async (token) => {
    await discordFetch(token, "/users/@me");
  },
  async callTool(product, name, token, args) {
    if (product === "guilds") {
      if (name === "list_guilds") {
        const limit = int(args, "limit", 100);
        return discordFetch(token, `/users/@me/guilds?limit=${limit ?? 100}`);
      }
      if (name === "get_guild") {
        return discordFetch(token, `/guilds/${encodeURIComponent(str(args, "guild_id"))}`);
      }
    }
    if (product === "user") {
      if (name === "get_me") return discordFetch(token, "/users/@me");
      if (name === "list_connections") return discordFetch(token, "/users/@me/connections");
    }
    throw new Error(`Unknown Discord tool: ${name}`);
  },
});

export const createDiscordProvider = factory.createProvider;
export const injectDiscordRuntime = factory.injectRuntime;
export const resolveDiscordProduct = factory.resolveProduct;
export const discordBuiltinUrl = factory.builtinUrl;
