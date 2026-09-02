/**
 * MCP / Connector 共享的上游 OAuth 授权中间态。
 *
 * 为什么单独成模块：`/api/mcp/*` 与 `/api/connectors/*` 两组路由共享同一份 pending
 * 授权表——一端发起授权、另一端可能完成回调。若把这份状态放进任一侧的路由模块，
 * 另一侧就要反向 import 形成循环依赖；若各持一份副本，回调时会找不到发起时写入的
 * pending 记录，表现为「授权完成但仍显示未连接」。
 *
 * 因此这里只承载共享状态与纯函数，不注册任何路由。内容自 routes.ts 原样搬迁。
 */
import { recordPlatformFault } from "@zakura/core";
import type {
  McpUpstreamOauthService,
  UpstreamOauthDiscovery,
} from "../services/mcp-upstream-oauth.js";
import { buildByoOauthClient } from "../services/mcp-oauth-clients.js";
import type { UpstreamOauthClientStore } from "../services/upstream-oauth-clients.js";

export const upstreamOauthPending = new Map<
  string,
  {
    tenantId: string;
    instanceId?: string;
    connectorRef?: string;
    /** 平台连接器授权写入该 Agent 的安装记录 */
    agentId?: string;
    mcpUrl: string;
    clientId: string;
    clientSecret?: string;
    codeVerifier: string;
    redirectUri: string;
    tokenEndpoint: string;
    /** null = platform connector, do not send RFC 8707 MCP resource */
    resource?: string | null;
    createdAt: number;
  }
>();

export function purgeUpstreamOauthPending() {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of upstreamOauthPending) {
    if (v.createdAt < cutoff) upstreamOauthPending.delete(k);
  }
}

/**
 * Client 获取顺序：
 * 1. 请求体 BYO（用户自备 OAuth Client ID/Secret）
 * 2. 连接器预配（管理员/团队配置的 OAuth Client，按 hostPatterns 匹配）
 * 3. DCR（上游支持时）
 * dcr / byo 成功后写入 upstream_oauth_clients 供设置页列出。
 */
export async function resolveUpstreamOauthClient(opts: {
  upstreamOauth: McpUpstreamOauthService;
  discovery: UpstreamOauthDiscovery;
  mcpUrl: string;
  redirectUri: string;
  clientName?: string;
  /** 用户安装时直接提供的 OAuth 客户端（非 API Key） */
  byo?: { clientId?: string; clientSecret?: string; scopes?: string };
  /** 平台/团队预配的连接器 OAuth 客户端 */
  connectorClient?: {
    clientId: string;
    clientSecret?: string;
    scopes?: string;
  } | null;
  /** 持久化 dcr/byo 记录 */
  record?: {
    store: UpstreamOauthClientStore;
    tenantId: string;
    instanceId?: string | null;
  };
}): Promise<{
  clientId: string;
  clientSecret?: string;
  scopeOverride?: string;
  source: "dcr" | "byo" | "platform" | "tenant";
} | null> {
  let result: {
    clientId: string;
    clientSecret?: string;
    scopeOverride?: string;
    source: "dcr" | "byo" | "platform" | "tenant";
  } | null = null;

  if (opts.byo?.clientId?.trim()) {
    const byo = buildByoOauthClient(opts.mcpUrl, {
      clientId: opts.byo.clientId,
      clientSecret: opts.byo.clientSecret,
      scopes: opts.byo.scopes,
    });
    if (byo) {
      result = {
        clientId: byo.clientId,
        clientSecret: byo.clientSecret,
        scopeOverride: byo.scopes,
        source: "byo",
      };
    }
  } else if (opts.connectorClient?.clientId?.trim()) {
    result = {
      clientId: opts.connectorClient.clientId.trim(),
      clientSecret: opts.connectorClient.clientSecret?.trim() || undefined,
      scopeOverride: opts.connectorClient.scopes?.trim() || undefined,
      source: "platform",
    };
  } else if (opts.discovery.registrationEndpoint) {
    const registered = await opts.upstreamOauth.registerClient(opts.discovery, {
      clientName: opts.clientName,
      redirectUris: [opts.redirectUri],
    });
    result = {
      clientId: registered.clientId,
      clientSecret: registered.clientSecret,
      source: "dcr",
    };
  }

  if (
    result &&
    opts.record &&
    (result.source === "dcr" || result.source === "byo")
  ) {
    try {
      await opts.record.store.record({
        tenantId: opts.record.tenantId,
        mcpUrl: opts.mcpUrl,
        clientId: result.clientId,
        clientSecret: result.clientSecret,
        clientName: opts.clientName,
        source: result.source,
        registrationEndpoint: opts.discovery.registrationEndpoint,
        scope: result.scopeOverride,
        instanceId: opts.record.instanceId,
      });
    } catch (err) {
      recordPlatformFault("oauth.persist_client", err, { subsystem: "oauth" });
    }
  }

  return result;
}
