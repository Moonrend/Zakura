import { api } from "@/lib/api";

export const MCP_OAUTH_MESSAGE = "zakura-mcp-oauth" as const;
export const MCP_OAUTH_CHANNEL = "zakura-mcp-oauth";

export type McpOauthMessage = {
  type: typeof MCP_OAUTH_MESSAGE;
  ok: boolean;
  instanceId?: string;
  error?: string;
};

const POPUP_FEATURES = "popup=yes,width=520,height=720,menubar=no,toolbar=no,location=yes,status=no,resizable=yes,scrollbars=yes";

function popupFeatures(): string {
  if (typeof window === "undefined") return POPUP_FEATURES;
  const w = 520;
  const h = 720;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 2));
  return `${POPUP_FEATURES},left=${left},top=${top}`;
}

/** 每个安装流程使用独立窗口名，互不抢占 */
function uniquePopupName(): string {
  return `zakura-mcp-oauth-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function isMcpOauthMessage(data: unknown): data is McpOauthMessage {
  return (
    !!data &&
    typeof data === "object" &&
    (data as McpOauthMessage).type === MCP_OAUTH_MESSAGE
  );
}

/** 居中弹出窗口打开授权（保留 opener，便于回调页 postMessage） */
export function openOauthAuthorizeTab(authorizeUrl: string): Window | null {
  // 不要用 noopener：回调页需要 window.opener 通知引导页
  return window.open(authorizeUrl, uniquePopupName(), popupFeatures());
}

/**
 * 在用户手势内先打开空白弹出窗口，避免后续 async 后被拦截。
 * 拿到 authorizeUrl 后再导航。
 */
export function prepareOauthTab(): Window | null {
  return window.open("about:blank", uniquePopupName(), popupFeatures());
}

export function navigateOauthTab(tab: Window | null, authorizeUrl: string): Window | null {
  if (tab && !tab.closed) {
    try {
      tab.location.href = authorizeUrl;
      try {
        tab.focus();
      } catch {
        /* ignore */
      }
      return tab;
    } catch {
      /* fall through */
    }
  }
  return openOauthAuthorizeTab(authorizeUrl);
}

/** 向 opener + BroadcastChannel 广播 OAuth 结果 */
export function broadcastMcpOauthResult(msg: McpOauthMessage): void {
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const ch = new BroadcastChannel(MCP_OAUTH_CHANNEL);
      ch.postMessage(msg);
      ch.close();
    }
  } catch {
    /* ignore */
  }
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(msg, window.location.origin);
    }
  } catch {
    /* ignore */
  }
}

/**
 * 监听 OAuth 回调（postMessage + BroadcastChannel）。
 * 返回取消订阅函数。
 */
export function listenMcpOauthCallback(
  onResult: (msg: McpOauthMessage) => void,
): () => void {
  const onMessage = (ev: MessageEvent) => {
    if (ev.origin && ev.origin !== window.location.origin) return;
    if (!isMcpOauthMessage(ev.data)) return;
    onResult(ev.data);
  };
  window.addEventListener("message", onMessage);

  let channel: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(MCP_OAUTH_CHANNEL);
      channel.onmessage = (ev) => {
        if (!isMcpOauthMessage(ev.data)) return;
        onResult(ev.data);
      };
    }
  } catch {
    channel = null;
  }

  return () => {
    window.removeEventListener("message", onMessage);
    channel?.close();
  };
}

export async function startUpstreamOauth(
  instanceId: string,
  byo?: { oauthClientId?: string; oauthClientSecret?: string },
): Promise<{ authorizeUrl: string }> {
  const res = await api<{
    ok: boolean;
    authorizeUrl?: string;
    error?: string;
  }>("/api/mcp/upstream-oauth/start", {
    method: "POST",
    json: { instanceId, ...byo },
  });
  if (!res.ok || !res.authorizeUrl) {
    throw new Error(res.error || "无法启动 OAuth");
  }
  return { authorizeUrl: res.authorizeUrl };
}

/** 使用用户自备 Client 直接发起授权（已有实例时） */
export async function authorizeUpstreamOauth(input: {
  mcpUrl: string;
  clientId: string;
  clientSecret?: string;
  instanceId?: string;
  scope?: string;
}): Promise<{ authorizeUrl: string }> {
  const res = await api<{
    ok?: boolean;
    authorizeUrl?: string;
    error?: string;
  }>("/api/mcp/upstream-oauth/authorize", {
    method: "POST",
    json: {
      mcpUrl: input.mcpUrl,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      instanceId: input.instanceId,
      scope: input.scope,
    },
  });
  if (!res.authorizeUrl) {
    throw new Error(res.error || "无法启动 OAuth");
  }
  return { authorizeUrl: res.authorizeUrl };
}

export async function verifyUpstreamOauth(instanceId: string): Promise<void> {
  await api("/api/mcp/upstream-oauth/verify", {
    method: "POST",
    json: { instanceId },
  });
}
