/**
 * 平台 OAuth REST 连接器共用底座：token 刷新、健康检查、工具分发。
 * 各厂商只声明 product / tools / HTTP 调用。
 */
import type { InstanceHandle, ProviderPlugin } from "@zakura/core";
import { textResult } from "@zakura/core";
import type { McpToolDef, ProviderConfigSchema } from "@zakura/shared";
import { eq } from "drizzle-orm";
import { componentInstances } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import { McpUpstreamOauthService } from "../services/mcp-upstream-oauth.js";
import { applyOauthTokensToConfig } from "./generic-mcp.js";

export type OauthRestCallTool = (
  product: string,
  toolName: string,
  token: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export type OauthRestHealth = (token: string) => Promise<void>;

export type OauthRestProviderSpec = {
  id: string;
  name: string;
  description: string;
  products: readonly string[];
  toolDefs: Record<string, McpToolDef[]>;
  callTool: OauthRestCallTool;
  health?: OauthRestHealth;
};

type RuntimeSlot = { config: AppConfig | null; db: unknown };

export function createOauthRestProvider(spec: OauthRestProviderSpec) {
  const runtime: RuntimeSlot = { config: null, db: null };
  const productSet = new Set(spec.products);

  function builtinUrl(product: string): string {
    return `zakura://${spec.id}/${product}`;
  }

  function resolveProduct(value: string): string | null {
    const raw = value.trim().toLowerCase();
    if (productSet.has(raw)) return raw;
    const matched = raw.match(new RegExp(`^zakura:\\/\\/${spec.id}\\/([a-z0-9-]+)$`));
    return matched && productSet.has(matched[1]!) ? matched[1]! : null;
  }

  function parseProduct(config: Record<string, unknown>): string {
    const value =
      typeof config.product === "string"
        ? config.product
        : typeof config.mcpUrl === "string"
          ? config.mcpUrl
          : "";
    const product = resolveProduct(value);
    if (!product) {
      throw new Error(`config.product 须为 ${spec.products.join(" | ")}`);
    }
    return product;
  }

  const configSchema: ProviderConfigSchema = {
    type: "object",
    title: spec.name,
    required: ["product"],
    properties: {
      product: { type: "string", enum: [...spec.products] },
      oauthAccessToken: { type: "string", format: "password" },
      oauthRefreshToken: { type: "string", format: "password" },
      oauthExpiresAt: { type: "number" },
      oauthClientId: { type: "string" },
      oauthClientSecret: { type: "string", format: "password" },
      oauthTokenEndpoint: { type: "string" },
      authRequired: { type: "boolean" },
    },
  };

  async function accessToken(handle: InstanceHandle): Promise<string> {
    let current = { ...handle.config };
    const expiresAt = Number(current.oauthExpiresAt ?? 0);
    const appConfig = runtime.config;
    if (
      (!current.oauthAccessToken || expiresAt <= Math.floor(Date.now() / 1000) + 120) &&
      current.oauthRefreshToken &&
      current.oauthClientId &&
      appConfig
    ) {
      const tokenEndpoint = String(current.oauthTokenEndpoint ?? "").trim();
      if (!tokenEndpoint) throw new Error(`${spec.name} OAuth 配置缺少 token endpoint`);
      const tokens = await new McpUpstreamOauthService(appConfig).refresh({
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
      if (runtime.db) {
        const { encryptJson } = await import("@zakura/core");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (runtime.db as any)
          .update(componentInstances)
          .set({ configEnc: encryptJson(appConfig.secret, current), updatedAt: new Date() })
          .where(eq(componentInstances.id, handle.id));
      }
    }
    const token = String(current.oauthAccessToken ?? "").trim();
    if (!token) throw new Error(`AUTH_REQUIRED: 请先完成 ${spec.name} OAuth 授权`);
    return token;
  }

  function injectRuntime(config: AppConfig, db: unknown): void {
    runtime.config = config;
    runtime.db = db;
  }

  function createProvider(): ProviderPlugin {
    return {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      version: "1.0.0",
      category: "connector",
      capabilities: ["tools", "builtin"],
      configSchema,
      validateConfig(config) {
        const product = parseProduct(config);
        return { ...config, product, mcpUrl: builtinUrl(product) };
      },
      createRuntimeSpec(config) {
        return { containers: [], endpointTemplate: builtinUrl(parseProduct(config)) };
      },
      async healthCheck(handle) {
        try {
          const token = await accessToken(handle);
          if (spec.health) await spec.health(token);
          return { status: "healthy", message: `ok (${parseProduct(handle.config)})` };
        } catch (error) {
          return {
            status: "unhealthy",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
      async listTools(handle) {
        return spec.toolDefs[parseProduct(handle.config)] ?? [];
      },
      async callTool(handle, name, args) {
        try {
          const product = parseProduct(handle.config);
          const result = await spec.callTool(product, name, await accessToken(handle), args);
          return textResult(JSON.stringify(result, null, 2));
        } catch (error) {
          return textResult(error instanceof Error ? error.message : String(error), true);
        }
      },
    };
  }

  return { createProvider, injectRuntime, resolveProduct, builtinUrl, parseProduct };
}

export async function restJson<T>(
  url: string,
  token: string,
  init?: RequestInit & { json?: unknown; authScheme?: "bearer" | "token" | "private-token" },
): Promise<T> {
  const headers = new Headers(init?.headers);
  const scheme = init?.authScheme ?? "bearer";
  if (scheme === "private-token") headers.set("PRIVATE-TOKEN", token);
  else if (scheme === "token") headers.set("Authorization", `Token ${token}`);
  else headers.set("Authorization", `Bearer ${token}`);
  if (init?.json !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    ...init,
    headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    signal: init?.signal ?? AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 400)}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export function str(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? String(args[key]).trim() : "";
}

export function int(args: Record<string, unknown>, key: string, fallback?: number): number | undefined {
  if (typeof args[key] === "number") return args[key] as number;
  if (typeof args[key] === "string" && args[key]) return Number(args[key]);
  return fallback;
}
