#!/usr/bin/env node
/**
 * Manual end-to-end verification against a RUNNING Zakura server.
 *
 * Prerequisites
 * -------------
 * 1. Server up and reachable. For a fresh local instance:
 *      $env:ZAKURA_DATA_DIR = "$PWD\dev-data"
 *      pnpm --filter @zakura/server dev
 *    Env defaults (src/config.ts): HOST=0.0.0.0, PORT=8787,
 *    public URL http://127.0.0.1:8787, database pglite:$ZAKURA_DATA_DIR/pglite
 *    (or set DATABASE_URL). Redis is optional; leave REDIS_URL unset.
 *
 * 2. A user account on that server. Create the first admin on a fresh DB:
 *      curl -X POST http://127.0.0.1:8787/api/setup `
 *        -H 'content-type: application/json' `
 *        -d '{"adminEmail":"you@example.com","adminPassword":"password123"}'
 *    Or pass --setup to this script to do that call for you.
 *
 * 3. For a real chat_reply the tenant needs a model route/upstream configured.
 *    Without one the run fails server-side, but the user-message echo below is
 *    still delivered by the channel, so you can verify auth + transport.
 *
 * Usage
 * -----
 *   $env:ZAKURA_EMAIL="you@example.com"; $env:ZAKURA_PASSWORD="password123"
 *   node apps/server/scripts/e2e-zakurabot.mjs
 *   node apps/server/scripts/e2e-zakurabot.mjs --url http://127.0.0.1:8787 `
 *     --space "Manual E2E" --agent "E2E Agent" --message "hello there"
 *
 * Flags / env: --url|ZAKURA_BASE_URL, --email|ZAKURA_EMAIL,
 *   --password|ZAKURA_PASSWORD, --space, --agent, --message, --setup,
 *   --timeout <seconds>
 *
 * Chain exercised: login -> DCR (/oauth/register) -> PKCE -> consent ->
 * /oauth/token -> POST /api/spaces -> POST /api/agents (spaceId) ->
 * POST /api/agents/:id/start -> WebSocket /api/zakurabot/ws (hello + send).
 * Node 22+ globals fetch/WebSocket/crypto are used.
 */
import { createHash, randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const baseUrl = (opt("url", process.env.ZAKURA_BASE_URL ?? "http://127.0.0.1:8787")).replace(/\/+$/, "");
const email = opt("email", process.env.ZAKURA_EMAIL ?? "");
const password = opt("password", process.env.ZAKURA_PASSWORD ?? "");
const spaceName = opt("space", "Manual E2E Space");
const agentName = opt("agent", "Manual E2E Agent");
const message = opt("message", "hello from the e2e script");
const doSetup = args.includes("--setup");
const timeoutSec = Number(opt("timeout", "30")) || 30;

const log = (...parts) => console.log("[e2e]", ...parts);
const fail = (message) => {
  console.error(`[e2e] FAILED: ${message}`);
  process.exit(1);
};

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

async function readBody(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

async function api(path, { method = "GET", token, body, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
  const parsed = await readBody(res);
  return { status: res.status, ok: res.ok, body: parsed };
}

async function main() {
  if (!email || !password) {
    fail("set --email/--password (or ZAKURA_EMAIL/ZAKURA_PASSWORD)");
  }

  // ── 1. Log in (console session) ──────────────────────────────────────
  let session;
  let login = await api("/api/auth/login", { method: "POST", body: { email, password } });
  if (!login.ok && login.body?.mfaRequired) {
    fail("account requires MFA; use a non-MFA account for this script");
  }
  if (!login.ok && doSetup) {
    log("login failed, calling /api/setup with the supplied credentials…");
    const setup = await api("/api/setup", {
      method: "POST",
      body: { adminEmail: email, adminPassword: password, adminName: email },
    });
    if (!setup.ok) fail(`/api/setup ${setup.status}: ${JSON.stringify(setup.body)}`);
    session = setup.body.session;
  } else if (!login.ok) {
    fail(`login ${login.status}: ${JSON.stringify(login.body)} (fresh DB? pass --setup)`);
  } else {
    session = login.body.session;
  }
  if (!session) fail("login returned no session token");
  log(`logged in as ${email}`);

  // ── 2. Dynamic client registration (DCR) ─────────────────────────────
  const redirectUri = "http://127.0.0.1/callback";
  const register = await api("/oauth/register", {
    method: "POST",
    body: {
      client_name: "zakura-e2e-script",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      scope: "api",
    },
  });
  if (!register.ok) fail(`/oauth/register ${register.status}: ${JSON.stringify(register.body)}`);
  const clientId = register.body.client_id;
  const clientSecret = register.body.client_secret;
  log(`registered client ${clientId}`);

  // ── 3. PKCE + consent + token exchange ───────────────────────────────
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  const consent = await api("/api/oauth/consent", {
    method: "POST",
    token: session,
    body: {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      scope: "api",
    },
  });
  if (!consent.ok) fail(`/api/oauth/consent ${consent.status}: ${JSON.stringify(consent.body)}`);
  const code = new URL(consent.body.redirect).searchParams.get("code");
  if (!code) fail(`consent response carried no code: ${JSON.stringify(consent.body)}`);

  const tokenRes = await api("/oauth/token", {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: clientId,
      client_secret: clientSecret,
    },
  });
  if (!tokenRes.ok) fail(`/oauth/token ${tokenRes.status}: ${JSON.stringify(tokenRes.body)}`);
  const accessToken = tokenRes.body.access_token;
  log(`obtained access token (scope: ${tokenRes.body.scope})`);

  // ── 4. Create space ──────────────────────────────────────────────────
  const spaceRes = await api("/api/spaces", {
    method: "POST",
    token: accessToken,
    body: { name: spaceName },
  });
  if (!spaceRes.ok) fail(`POST /api/spaces ${spaceRes.status}: ${JSON.stringify(spaceRes.body)}`);
  const space = spaceRes.body;
  log(`created space ${space.id} (slug ${space.slug})`);

  // ── 5. Create agent in that space ────────────────────────────────────
  const agentRes = await api("/api/agents", {
    method: "POST",
    token: accessToken,
    body: { name: agentName, spaceId: space.id, createApiKey: false },
  });
  if (!agentRes.ok) fail(`POST /api/agents ${agentRes.status}: ${JSON.stringify(agentRes.body)}`);
  const agent = agentRes.body;
  if (agent.spaceId !== space.id) fail(`agent landed in space ${agent.spaceId}, expected ${space.id}`);
  log(`created agent ${agent.id} (slug ${agent.slug}) in space ${space.id}`);

  // ── 6. Start the agent's workspace ───────────────────────────────────
  const startRes = await api(`/api/agents/${agent.id}/start`, { method: "POST", token: accessToken, body: {} });
  if (!startRes.ok) {
    console.warn(
      `[e2e] WARN: start ${startRes.status}: ${JSON.stringify(startRes.body)}\n` +
        "       (a bound runtime node / Runner is required to actually start a workspace; continuing to the channel)",
    );
  } else {
    log(`started agent (workspace: ${startRes.body.workspace?.status ?? "starting"})`);
  }

  // ── 7. Drive the zakurabot channel over WebSocket ────────────────────
  const wsUrl = `${baseUrl.replace(/^http/, "ws")}/api/zakurabot/ws`;
  log(`connecting ${wsUrl}`);
  const ws = new WebSocket(wsUrl);
  const clientMessageId = `e2e-${Date.now().toString(36)}`;
  let sawEcho = false;
  let sawReply = false;
  let settled = false;

  const done = (exitCode) => {
    if (settled) return;
    settled = true;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    console.log(
      `\n[e2e] ${exitCode === 0 ? "OK" : "INCOMPLETE"}: echo=${sawEcho} chat_reply=${sawReply}`,
    );
    process.exit(exitCode);
  };

  const timer = setTimeout(() => {
    console.warn(`[e2e] timed out after ${timeoutSec}s waiting for the channel`);
    done(sawEcho ? 0 : 2);
  }, timeoutSec * 1000);
  timer.unref?.();

  ws.addEventListener("open", () => {
    log("socket open; sending hello");
    ws.send(
      JSON.stringify({
        type: "hello",
        protocol: 1,
        token: accessToken,
        client: { name: "zakura-e2e-script", version: "1.0" },
      }),
    );
  });

  ws.addEventListener("message", (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data.toString());
    } catch {
      console.log("[e2e] <- (non-JSON frame)");
      return;
    }
    console.log("[e2e] <-", JSON.stringify(frame));

    if (frame.type === "ready") {
      const known = frame.agents?.some((a) => a.id === agent.id);
      log(`ready (protocol ${frame.protocol}, agents ${frame.agents?.length ?? 0}, agent visible: ${known})`);
      ws.send(
        JSON.stringify({ type: "send", agentId: agent.id, clientMessageId, text: message }),
      );
      return;
    }
    if (frame.type === "message" && frame.message?.clientMessageId === clientMessageId) {
      sawEcho = true;
      log("user message echo received");
      return;
    }
    if (frame.type === "chat_reply") {
      sawReply = true;
      log(`agent reply: ${frame.payload?.text ?? JSON.stringify(frame.payload)}`);
      clearTimeout(timer);
      done(0);
      return;
    }
    if (frame.type === "error" && frame.clientMessageId === clientMessageId) {
      console.warn(`[e2e] channel rejected the send: ${frame.message}`);
    }
  });

  ws.addEventListener("error", (event) => {
    fail(`WebSocket error: ${event?.message ?? "unknown"}`);
  });
  ws.addEventListener("close", (event) => {
    if (settled) return;
    log(`socket closed (${event.code}${event.reason ? ` ${event.reason}` : ""})`);
    done(sawEcho ? 0 : 2);
  });
}

main().catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error)));
