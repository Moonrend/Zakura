import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { createOauthApp } from "../src/oauth/http.js";
import { OauthService } from "../src/services/oauth.js";
import { newId } from "../src/db/schema.js";
import { tenantMemberships, tenants, users } from "../src/db/schema.js";

const WEB_REDIRECT = "http://localhost:8081/oauth/callback";
const LAN_REDIRECT = "http://100.81.13.25:8081/oauth/callback";
const NATIVE_REDIRECT = "zakurabot://oauth";

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function proof() {
  const verifier = randomBytes(32).toString("hex");
  return { verifier, challenge: s256(verifier) };
}

describe("oauth login flow", () => {
  let dataDir: string;
  let close: () => Promise<void>;
  let db: Db;
  let config: AppConfig;
  let oauth: OauthService;
  let app: ReturnType<typeof createOauthApp>;
  let tenantId: string;
  let userId: string;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "zakura-oauth-login-"));
    const databaseUrl = `pglite:${join(dataDir, "pglite")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const { createDb } = await import("../src/db/client.js");
    const created = await createDb({ databaseUrl, dataDir });
    db = created.db;
    close = created.close;

    config = {
      dataDir,
      databaseUrl,
      secret: "oauth-login-test-secret",
      publicBaseUrl: "https://zakura.example",
      webPublicUrl: "http://localhost:3001",
    } as AppConfig;
    oauth = new OauthService(db, config);
    app = createOauthApp({ db, config, oauth });

    tenantId = newId();
    userId = newId();
    await db.insert(tenants).values({ id: tenantId, name: "Login tenant", slug: tenantId });
    await db.insert(users).values({ id: userId, email: `${userId}@example.test` });
    await db
      .insert(tenantMemberships)
      .values({ tenantId, userId, role: "owner", status: "active" });
  });

  after(async () => {
    await close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function register(): Promise<string> {
    const res = await app.request("https://zakura.example/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Zakura Bot",
        redirect_uris: [WEB_REDIRECT, NATIVE_REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "api openid profile",
      }),
    });
    assert.equal(res.status, 201, `DCR failed: ${await res.clone().text()}`);
    const body = (await res.json()) as { client_id: string; redirect_uris: string[] };
    assert.ok(body.client_id.startsWith("ocl_"));
    assert.deepEqual(body.redirect_uris, [WEB_REDIRECT, NATIVE_REDIRECT]);
    return body.client_id;
  }

  it("DCR accepts localhost http, private-network http and zakurabot:// redirect URIs", async () => {
    await register();
    const res = await app.request("https://zakura.example/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "lan-test",
        redirect_uris: [LAN_REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "api openid profile",
      }),
    });
    assert.equal(res.status, 201, `LAN DCR failed: ${await res.clone().text()}`);
    const body = (await res.json()) as { redirect_uris: string[] };
    assert.deepEqual(body.redirect_uris, [LAN_REDIRECT]);
  });
  it("GET /authorize redirects (302) to the console consent page with query passthrough", async () => {
    const clientId = await register();
    const { challenge } = proof();
    const state = "state-abc";
    const target = new URL("https://zakura.example/authorize");
    target.searchParams.set("client_id", clientId);
    target.searchParams.set("redirect_uri", NATIVE_REDIRECT);
    target.searchParams.set("response_type", "code");
    target.searchParams.set("code_challenge", challenge);
    target.searchParams.set("code_challenge_method", "S256");
    target.searchParams.set("state", state);
    target.searchParams.set("scope", "api openid profile");

    const res = await app.request(target.toString());
    assert.equal(res.status, 302);
    const location = res.headers.get("location");
    assert.ok(location, "missing redirect location");
    const redirect = new URL(location);
    assert.equal(redirect.origin, "http://localhost:3001");
    assert.equal(redirect.pathname, "/console/oauth/authorize");
    assert.equal(redirect.searchParams.get("client_id"), clientId);
    assert.equal(redirect.searchParams.get("redirect_uri"), NATIVE_REDIRECT);
    assert.equal(redirect.searchParams.get("code_challenge"), challenge);
    assert.equal(redirect.searchParams.get("code_challenge_method"), "S256");
    assert.equal(redirect.searchParams.get("state"), state);
  });

  it("completes consent + PKCE token exchange for the web redirect URI", async () => {
    const clientId = await register();
    const { verifier, challenge } = proof();
    const { code, redirectUri } = await oauth.consent({
      userId,
      tenantId,
      clientId,
      redirectUri: WEB_REDIRECT,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: "api openid profile",
    });
    assert.equal(redirectUri, WEB_REDIRECT);

    const tokens = await oauth.exchangeToken({
      grantType: "authorization_code",
      code,
      redirectUri: WEB_REDIRECT,
      codeVerifier: verifier,
      clientId,
    });
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);
    assert.ok(tokens.scope.split(/[\s+]+/).includes("api"));

    // Token authenticates the WS principal resolver (api scope + active membership).
    const principal = await oauth.authenticateBearer(tokens.access_token);
    assert.ok(principal, "access token must resolve a principal for the WS channel");
    assert.equal(principal!.userId, userId);
    assert.equal(principal!.tenant.id, tenantId);
    assert.ok(principal!.scope!.split(/[\s+]+/).includes("api"));
  });

  it("completes consent + PKCE token exchange for the native zakurabot:// redirect URI", async () => {
    const clientId = await register();
    const { verifier, challenge } = proof();
    const { code } = await oauth.consent({
      userId,
      tenantId,
      clientId,
      redirectUri: NATIVE_REDIRECT,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: "api openid profile",
    });
    const tokens = await oauth.exchangeToken({
      grantType: "authorization_code",
      code,
      redirectUri: NATIVE_REDIRECT,
      codeVerifier: verifier,
      clientId,
    });
    const principal = await oauth.authenticateBearer(tokens.access_token);
    assert.ok(principal);
    assert.equal(principal!.userId, userId);
  });

  it("token endpoint rejects a wrong code_verifier (PKCE)", async () => {
    const clientId = await register();
    const { verifier, challenge } = proof();
    const { code } = await oauth.consent({
      userId,
      tenantId,
      clientId,
      redirectUri: NATIVE_REDIRECT,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: "api",
    });
    await assert.rejects(
      oauth.exchangeToken({
        grantType: "authorization_code",
        code,
        redirectUri: NATIVE_REDIRECT,
        codeVerifier: `${verifier}zz`,
        clientId,
      }),
      /PKCE/,
    );
  });
});

describe("oauth consent HTTP endpoints", () => {
  let dataDir: string;
  let close: (() => Promise<void>) | undefined;
  let db: Db;
  let config: AppConfig;
  let oauth: OauthService;
  let app: { request: (input: string, init?: RequestInit) => Promise<Response> };
  let sessionToken: string;
  let tenantId: string;
  let userId: string;

  before(async () => {
    process.env.REDIS_URL = "off";
    dataDir = mkdtempSync(join(tmpdir(), "zakura-oauth-consent-"));
    const databaseUrl = `pglite:${join(dataDir, "db")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const { createDb } = await import("../src/db/client.js");
    const created = await createDb({ databaseUrl, dataDir });
    db = created.db;
    close = created.close;

    config = {
      dataDir,
      databaseUrl,
      secret: "oauth-consent-test-secret",
      publicBaseUrl: "http://localhost",
      internalBaseUrl: "http://localhost",
      webPublicUrl: "http://localhost:3001",
    } as AppConfig;

    tenantId = newId();
    userId = newId();
    await db.insert(tenants).values({ id: tenantId, name: "Consent tenant", slug: tenantId });
    await db.insert(users).values({ id: userId, email: `${userId}@example.test` });
    await db
      .insert(tenantMemberships)
      .values({ tenantId, userId, role: "owner", status: "active" });

    const { AgentService } = await import("../src/services/agents.js");
    const { CloudAgentSessionStore } = await import("../src/services/cloud-agent-session.js");
    const { createApiApp } = await import("../src/api/routes.js");
    const { signSession } = await import("../src/services/auth.js");
    oauth = new OauthService(db, config);
    app = (await createApiApp({
      db,
      config,
      agentService: new AgentService(db, {} as never, config),
      orchestrator: {} as never,
      gateway: {} as never,
      runtime: {} as never,
      memoryStore: {} as never,
      memoryProviders: {} as never,
      toolCallStore: {} as never,
      oauth,
      cloudSessionStore: new CloudAgentSessionStore(db),
    })) as unknown as { request: (input: string, init?: RequestInit) => Promise<Response> };
    sessionToken = signSession(config.secret, {
      userId,
      tenantId,
      email: `${userId}@example.test`,
      role: "owner",
    });
  });

  after(async () => {
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function register(): Promise<string> {
    const client = await oauth.registerClient({
      client_name: "Zakura Bot",
      redirect_uris: [WEB_REDIRECT, NATIVE_REDIRECT],
      token_endpoint_auth_method: "none",
      scope: "api openid profile",
    });
    return client.client_id;
  }

  const authHeaders = () => ({
    authorization: `Bearer ${sessionToken}`,
    "content-type": "application/json",
  });

  for (const redirectUri of [WEB_REDIRECT, NATIVE_REDIRECT]) {
    it(`approves consent and returns a redirect for ${redirectUri}`, async () => {
      const clientId = await register();
      const { verifier, challenge } = proof();
      const state = "state-xyz";

      const infoQs = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "api openid profile",
      });
      const info = await app.request(`/api/oauth/authorize-info?${infoQs}`);
      assert.equal(info.status, 200, await info.clone().text());
      const infoBody = (await info.clone().json()) as { issuer: string };
      assert.equal(infoBody.issuer, "http://localhost");

      const consent = await app.request("/api/oauth/consent", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "api openid profile",
          state,
        }),
      });
      assert.equal(consent.status, 200, await consent.clone().text());
      const { redirect } = (await consent.json()) as { redirect: string };
      assert.ok(redirect.startsWith(redirectUri), `redirect should target ${redirectUri}: ${redirect}`);
      const url = new URL(redirect);
      const code = url.searchParams.get("code");
      assert.ok(code, "consent redirect must carry the authorization code");
      assert.equal(url.searchParams.get("state"), state);
      // RFC 9207 iss only for http(s); custom-scheme clients reject a foreign-origin iss.
      if (redirectUri.startsWith("http")) {
        assert.equal(url.searchParams.get("iss"), "http://localhost");
      } else {
        assert.equal(url.searchParams.get("iss"), null);
      }

      const tokens = await oauth.exchangeToken({
        grantType: "authorization_code",
        code: code!,
        redirectUri,
        codeVerifier: verifier,
        clientId,
      });
      assert.ok(tokens.access_token);
      const principal = await oauth.authenticateBearer(tokens.access_token);
      assert.ok(principal, "issued token must authenticate the WS principal resolver");
      assert.equal(principal!.userId, userId);
    });
  }
});
