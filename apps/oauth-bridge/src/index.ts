import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";

/**
 * OAuth Bridge — 独立中间件骨架。
 *
 * 对客户端：OAuth 2.1 AS + DCR 门面
 * 对上游：使用预注册 Google（等）client 换 token
 *
 * 生产使用前需：HTTPS、持久化 pending state、完成 Google 验证、租户隔离。
 */

const port = Number(process.env.PORT ?? 8788);
const publicBaseUrl = (process.env.BRIDGE_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(
  /\/$/,
  "",
);

type BridgeConfig = {
  googleClientId: string;
  googleClientSecret: string;
  googleScopes: string;
};

function loadConfig(): BridgeConfig {
  return {
    googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    googleScopes:
      process.env.GOOGLE_SCOPES ??
      "openid email https://www.googleapis.com/auth/drive.readonly",
  };
}

type PendingAuth = {
  clientRedirectUri: string;
  clientState?: string;
  codeVerifier: string;
  createdAt: number;
  /** 一次性授权码 → 上游 token（简化骨架） */
};

const pendingByState = new Map<string, PendingAuth>();
const codeStore = new Map<
  string,
  { accessToken: string; refreshToken?: string; expiresAt?: number; createdAt: number }
>();

function purge() {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of pendingByState) {
    if (v.createdAt < cutoff) pendingByState.delete(k);
  }
  for (const [k, v] of codeStore) {
    if (v.createdAt < cutoff) codeStore.delete(k);
  }
}

function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "oauth-bridge",
    googleConfigured: !!loadConfig().googleClientId,
  }),
);
app.get("/livez", (c) => c.json({ status: "ok", service: "oauth-bridge" }));

/** RFC 8414 Authorization Server Metadata */
app.get("/.well-known/oauth-authorization-server", (c) =>
  c.json({
    issuer: publicBaseUrl,
    authorization_endpoint: `${publicBaseUrl}/authorize`,
    token_endpoint: `${publicBaseUrl}/token`,
    registration_endpoint: `${publicBaseUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
  }),
);

/** RFC 7591 DCR 门面：无真实动态注册，返回公共 bridge client */
app.post("/register", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    client_name?: string;
    redirect_uris?: string[];
  };
  const redirectUris = body.redirect_uris ?? [];
  if (!redirectUris.length) {
    return c.json({ error: "redirect_uris required" }, 400);
  }
  return c.json({
    client_id: "zakura-oauth-bridge",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: body.client_name ?? "Zakura OAuth Bridge Client",
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

/**
 * 授权入口：把客户端 redirect 编码进 state，再跳转 Google。
 * 查询参数对齐标准 OAuth：client_id, redirect_uri, state, code_challenge, …
 */
app.get("/authorize", (c) => {
  purge();
  const cfg = loadConfig();
  if (!cfg.googleClientId) {
    return c.text(
      "GOOGLE_CLIENT_ID 未配置。请使用 BYO 自托管模式配置 Google OAuth App。",
      503,
    );
  }

  const redirectUri = c.req.query("redirect_uri");
  const clientState = c.req.query("state") ?? undefined;
  if (!redirectUri) return c.text("redirect_uri required", 400);

  const bridgeState = randomBytes(16).toString("hex");
  const codeVerifier = pkceVerifier();
  pendingByState.set(bridgeState, {
    clientRedirectUri: redirectUri,
    clientState,
    codeVerifier,
    createdAt: Date.now(),
  });

  const googleAuth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  googleAuth.searchParams.set("client_id", cfg.googleClientId);
  googleAuth.searchParams.set("redirect_uri", `${publicBaseUrl}/callback`);
  googleAuth.searchParams.set("response_type", "code");
  googleAuth.searchParams.set("scope", cfg.googleScopes);
  googleAuth.searchParams.set("access_type", "offline");
  googleAuth.searchParams.set("prompt", "consent");
  googleAuth.searchParams.set("state", bridgeState);
  googleAuth.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
  googleAuth.searchParams.set("code_challenge_method", "S256");

  return c.redirect(googleAuth.toString());
});

/** Google 回调 → 换 token → 向客户端发放一次性 code */
app.get("/callback", async (c) => {
  purge();
  const cfg = loadConfig();
  const code = c.req.query("code");
  const state = c.req.query("state");
  const err = c.req.query("error");

  if (err || !code || !state) {
    return c.text(`OAuth error: ${err || "missing code/state"}`, 400);
  }
  const pending = pendingByState.get(state);
  pendingByState.delete(state);
  if (!pending) return c.text("invalid or expired state", 400);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${publicBaseUrl}/callback`,
    client_id: cfg.googleClientId,
    client_secret: cfg.googleClientSecret,
    code_verifier: pending.codeVerifier,
  });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokenJson = (await tokenRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!tokenRes.ok || !tokenJson.access_token) {
    return c.text(`token exchange failed: ${JSON.stringify(tokenJson).slice(0, 300)}`, 400);
  }

  const oneTimeCode = randomBytes(24).toString("base64url");
  const expiresIn =
    typeof tokenJson.expires_in === "number" ? tokenJson.expires_in : Number(tokenJson.expires_in);
  codeStore.set(oneTimeCode, {
    accessToken: String(tokenJson.access_token),
    refreshToken:
      typeof tokenJson.refresh_token === "string" ? tokenJson.refresh_token : undefined,
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? Math.floor(Date.now() / 1000) + expiresIn
        : undefined,
    createdAt: Date.now(),
  });

  const back = new URL(pending.clientRedirectUri);
  back.searchParams.set("code", oneTimeCode);
  if (pending.clientState) back.searchParams.set("state", pending.clientState);
  return c.redirect(back.toString());
});

/** 客户端用 bridge code 换取上游 token（骨架：直接透传 Google token） */
app.post("/token", async (c) => {
  purge();
  const contentType = c.req.header("content-type") ?? "";
  let grantType = "";
  let code = "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await c.req.parseBody();
    grantType = String(form.grant_type ?? "");
    code = String(form.code ?? "");
  } else {
    const json = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    grantType = String(json.grant_type ?? "");
    code = String(json.code ?? "");
  }

  if (grantType !== "authorization_code" || !code) {
    return c.json({ error: "unsupported_grant_type" }, 400);
  }
  const stored = codeStore.get(code);
  codeStore.delete(code);
  if (!stored) return c.json({ error: "invalid_grant" }, 400);

  return c.json({
    access_token: stored.accessToken,
    token_type: "Bearer",
    expires_in: stored.expiresAt
      ? Math.max(0, stored.expiresAt - Math.floor(Date.now() / 1000))
      : 3600,
    refresh_token: stored.refreshToken,
  });
});

process.stdout.write(
  `${JSON.stringify({
    ts: new Date().toISOString(),
    level: "info",
    service: "oauth-bridge",
    event: "process.ready",
    bind_port: port,
    google_configured: !!loadConfig().googleClientId,
  })}\n`,
);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
