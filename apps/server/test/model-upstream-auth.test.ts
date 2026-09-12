import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_OAUTH_CLIENT_ID,
  ModelUpstreamAuthService,
  parseClaudeCallback,
  parseGeminiCliCreds,
  setCursorLoginApi,
  startCursorLogin,
  cursorPrompt,
  type JsonHttp,
} from "../src/services/model-upstream-auth/index.js";
import { encryptTokens, jwtChatgptAccountId } from "../src/services/model-upstream-auth/tokens.js";
import { setRouteHydrator, hydrateRoute } from "../src/model-router/oauth-hook.js";
import { buildHeaders } from "../src/model-router/http.js";
import { responsesUrl, responsesChat } from "../src/model-router/openai-responses-api.js";
import { geminiChatUrl, wrapGeminiBody } from "../src/model-router/adapters/gemini.js";
import { cursorAdapter } from "../src/model-router/adapters/cursor.js";
import { claudeCodeAdapter } from "../src/model-router/adapters/anthropic.js";
import { registerBuiltinModelAdapters } from "../src/model-router/index.js";
import type { ResolvedRoute } from "../src/model-router/types.js";
import type { Db } from "../src/db/client.js";

registerBuiltinModelAdapters();

function jwtWith(payload: Record<string, unknown>): string {
  const head = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${head}.${body}.x`;
}

function route(
  protocol: ResolvedRoute["upstream"]["protocol"],
  config: ResolvedRoute["upstream"]["config"],
): ResolvedRoute {
  return {
    routeId: "r1",
    routeSlug: "s",
    alias: "a",
    capability: "chat",
    model: protocol === "codex" ? "gpt-5.4" : "m",
    weight: 1,
    options: { temperature: 0.4, maxTokens: 128 },
    upstream: { id: "u1", protocol, config },
  };
}

function memoryUpstream(protocol: string, config: Record<string, unknown> = {}) {
  let json = JSON.stringify({ baseUrl: "https://example.com", ...config });
  const db = {
    query: {
      modelUpstreams: {
        findFirst: async () => ({
          id: "u1",
          tenantId: "t1",
          protocol,
          configJson: json,
          status: "ready",
          lastError: null,
        }),
      },
    },
    update: () => ({
      set: (patch: { configJson?: string }) => ({
        where: async () => {
          if (typeof patch.configJson === "string") json = patch.configJson;
        },
      }),
    }),
  };
  return {
    db: db as unknown as Db,
    read: () => JSON.parse(json) as Record<string, unknown>,
  };
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

describe("Codex 设备码与 Responses", () => {
  it("request/poll 换票并写入加密 oauthEnc", async () => {
    const idToken = jwtWith({
      email: "a@b.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" },
    });
    let tokenCalls = 0;
    const http: JsonHttp = {
      async postJson(url, body) {
        const rec = body as Record<string, unknown>;
        if (url.endsWith("/deviceauth/usercode")) {
          assert.equal(rec.client_id, CODEX_OAUTH_CLIENT_ID);
          return {
            status: 200,
            json: { device_auth_id: "dev-1", user_code: "ABCD-EFGH", interval: "2" },
          };
        }
        if (url.endsWith("/deviceauth/token")) {
          tokenCalls += 1;
          if (tokenCalls === 1) return { status: 403, json: { error: "authorization_pending" } };
          return {
            status: 200,
            json: { authorization_code: "ac", code_verifier: "ver", code_challenge: "ch" },
          };
        }
        if (url.endsWith("/oauth/token")) {
          return {
            status: 200,
            json: { id_token: idToken, access_token: "at", refresh_token: "rt" },
          };
        }
        throw new Error(url);
      },
      async getJson() {
        return { status: 404, json: null };
      },
      async postForm() {
        return { status: 404, json: null };
      },
    };
    const { db, read } = memoryUpstream("codex", { baseUrl: "https://chatgpt.com" });
    const auth = new ModelUpstreamAuthService(db, "test-secret", http);
    const started = await auth.start("t1", "u1");
    assert.equal(started.status, "pending");
    assert.equal(started.userCode, "ABCD-EFGH");
    const pending = await auth.poll("t1", "u1", started.loginId);
    assert.equal(pending.status, "pending");
    const done = await auth.poll("t1", "u1", started.loginId);
    assert.equal(done.status, "complete");
    const saved = read();
    assert.equal(typeof saved.oauthEnc, "string");
    const hydrated = await auth.hydrateRoute(
      route("codex", { baseUrl: "https://chatgpt.com", oauthEnc: String(saved.oauthEnc) }),
    );
    assert.equal(hydrated.upstream.config.apiKey, "at");
    assert.equal(hydrated.upstream.config.extraHeaders?.["chatgpt-account-id"], "acc-1");
    assert.equal(hydrated.upstream.config.extraHeaders?.originator, "codex_cli_rs");
  });

  it("id_token 能解析 chatgpt_account_id", () => {
    const token = jwtWith({
      "https://api.openai.com/auth": { chatgpt_account_id: "org-acc" },
    });
    assert.equal(jwtChatgptAccountId(token), "org-acc");
  });

  it("Responses 打 chatgpt.com，store=false，去掉 temperature", async () => {
    const r = route("codex", {
      baseUrl: "https://chatgpt.com",
      apiKey: "tok",
      extraHeaders: { originator: "codex_cli_rs", "OpenAI-Beta": "responses=experimental" },
    });
    assert.equal(responsesUrl(r), "https://chatgpt.com/backend-api/codex/responses");
    const headers = buildHeaders(r.upstream.config, "codex");
    assert.equal(headers.Authorization, "Bearer tok");
    assert.equal(headers.originator, "codex_cli_rs");
    assert.equal(headers["OpenAI-Beta"], "responses=experimental");

    let captured: { url?: string; body?: Record<string, unknown> } = {};
    const restore = stubFetch(async (url, init) => {
      captured = { url, body: JSON.parse(String(init?.body ?? "{}")) };
      return new Response(JSON.stringify({ output: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      await responsesChat(r, [{ role: "user", content: "hi" }], []);
      assert.equal(captured.url, "https://chatgpt.com/backend-api/codex/responses");
      assert.equal(captured.body?.store, false);
      assert.equal(captured.body?.temperature, undefined);
      assert.equal(captured.body?.max_output_tokens, undefined);
      assert.equal(captured.body?.tools, undefined);
    } finally {
      restore();
    }
  });
});

describe("Claude Code PKCE", () => {
  it("解析 code#state 与 callback URL", () => {
    assert.deepEqual(parseClaudeCallback("abc#ver"), { code: "abc", state: "ver" });
    assert.deepEqual(
      parseClaudeCallback("https://console.anthropic.com/oauth/code/callback?code=zz&state=st"),
      { code: "zz", state: "st" },
    );
  });

  it("setup-token 可直接入库", async () => {
    const { db, read } = memoryUpstream("claude-code", { baseUrl: "https://api.anthropic.com" });
    const auth = new ModelUpstreamAuthService(db, "test-secret");
    const done = await auth.submit("t1", "u1", { setupToken: "sk-ant-oat-test" });
    assert.equal(done.status, "complete");
    const hydrated = await auth.hydrateRoute(
      route("claude-code", {
        baseUrl: "https://api.anthropic.com",
        oauthEnc: String(read().oauthEnc),
      }),
    );
    assert.equal(hydrated.upstream.config.apiKey, "sk-ant-oat-test");
    assert.match(hydrated.upstream.config.extraHeaders?.["anthropic-beta"] ?? "", /oauth-2025-04-20/);
  });

  it("PKCE 粘贴授权码换票", async () => {
    const http: JsonHttp = {
      async postJson(url, body) {
        const rec = body as Record<string, unknown>;
        if (url.includes("/oauth/token")) {
          assert.equal(rec.grant_type, "authorization_code");
          assert.equal(rec.code, "the-code");
          return { status: 200, json: { access_token: "cla", refresh_token: "clr", expires_in: 3600 } };
        }
        throw new Error(url);
      },
      async getJson() {
        return { status: 404, json: null };
      },
      async postForm() {
        return { status: 404, json: null };
      },
    };
    const { db, read } = memoryUpstream("claude-code", { baseUrl: "https://api.anthropic.com" });
    const auth = new ModelUpstreamAuthService(db, "test-secret", http);
    const started = await auth.start("t1", "u1");
    assert.equal(started.kind, "pkce");
    assert.ok(started.verificationUrl?.includes("claude.ai/oauth/authorize"));
    const done = await auth.submit("t1", "u1", { loginId: started.loginId, code: "the-code#ignored" });
    assert.equal(done.status, "complete");
    assert.equal(typeof read().oauthEnc, "string");
  });

  it("OAuth 头是 Bearer，受限凭证给出中文错误", async () => {
    const r = route("claude-code", {
      baseUrl: "https://api.anthropic.com",
      apiKey: "oauth-tok",
    });
    let headers: Headers | undefined;
    const restore = stubFetch(async (_url, init) => {
      headers = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          error: { message: "OAuth token is only authorized for use with Claude Code" },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    });
    try {
      await assert.rejects(
        () => claudeCodeAdapter.chat!(r, [{ role: "user", content: "hi" }]),
        /仅限 Claude Code/,
      );
      assert.equal(headers?.get("authorization"), "Bearer oauth-tok");
      assert.equal(headers?.get("anthropic-beta"), "oauth-2025-04-20");
      assert.equal(headers?.get("x-api-key"), null);
    } finally {
      restore();
    }
  });
});

describe("Cursor SDK", () => {
  afterEach(() => setCursorLoginApi(null));

  it("onLoginUrl + poll 完成，chat 不带 tools", async () => {
    const prompts: Array<{ text: string; apiKey: string; model: string }> = [];
    setCursorLoginApi({
      login: async ({ openBrowser, store, onLoginUrl }) => {
        assert.equal(openBrowser, false);
        assert.equal(store, null);
        onLoginUrl("https://cursor.com/login#device");
        return { apiKey: "ck", email: "dev@cursor.com" };
      },
      listModels: async () => [{ id: "composer-2.5" }],
      prompt: async (input) => {
        prompts.push(input);
        return "hello";
      },
    });
    const { url, done } = await startCursorLogin();
    assert.equal(await url, "https://cursor.com/login#device");
    const tokens = await done;
    assert.equal(tokens.api_key, "ck");

    const { db, read } = memoryUpstream("cursor");
    const auth = new ModelUpstreamAuthService(db, "test-secret");
    const started = await auth.start("t1", "u1");
    assert.equal(started.kind, "sdk");
    const polled = await auth.poll("t1", "u1", started.loginId);
    assert.equal(polled.status, "complete");
    assert.equal(typeof read().oauthEnc, "string");

    const result = await cursorAdapter.chat!(
      route("cursor", { baseUrl: "https://cursor.com", apiKey: "ck" }),
      [{ role: "user", content: "hi" }],
      {
        tools: [{ type: "function", function: { name: "x", parameters: { type: "object" } } }],
      },
    );
    assert.equal(result.content, "hello");
    assert.equal(prompts.at(-1)?.text.includes("hi"), true);
    assert.equal(prompts.at(-1)?.apiKey, "ck");
  });

  it("cursorPrompt 走注入的 API", async () => {
    setCursorLoginApi({
      login: async ({ onLoginUrl }) => {
        onLoginUrl("x");
        return { apiKey: "k" };
      },
      listModels: async () => [],
      prompt: async () => "pong",
    });
    assert.equal(await cursorPrompt({ text: "ping", apiKey: "k", model: "composer-2.5" }), "pong");
  });
});

describe("Gemini CLI / Grok", () => {
  it("Grok 设备码 pending 后换票", async () => {
    let polls = 0;
    const http: JsonHttp = {
      async postJson() {
        return { status: 404, json: null };
      },
      async getJson(url) {
        if (url.includes("openid-configuration")) {
          return {
            status: 200,
            json: {
              device_authorization_endpoint: "https://auth.x.ai/oauth/device",
              token_endpoint: "https://auth.x.ai/oauth/token",
            },
          };
        }
        throw new Error(url);
      },
      async postForm(url, body) {
        if (url.endsWith("/oauth/device")) {
          return {
            status: 200,
            json: {
              device_code: "dc",
              user_code: "WDYK-GROK",
              verification_uri: "https://auth.x.ai/device",
              interval: 1,
              expires_in: 600,
            },
          };
        }
        if (url.endsWith("/oauth/token")) {
          polls += 1;
          if (body.grant_type?.includes("device_code") && polls === 1) {
            return { status: 400, json: { error: "authorization_pending" } };
          }
          return { status: 200, json: { access_token: "gx", refresh_token: "gr" } };
        }
        throw new Error(url);
      },
    };
    const { db, read } = memoryUpstream("grok-build", {
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
    });
    const auth = new ModelUpstreamAuthService(db, "test-secret", http);
    const started = await auth.start("t1", "u1");
    assert.equal(started.userCode, "WDYK-GROK");
    const pending = await auth.poll("t1", "u1", started.loginId);
    assert.equal(pending.status, "pending");
    const done = await auth.poll("t1", "u1", started.loginId);
    assert.equal(done.status, "complete");
    assert.equal(typeof read().oauthEnc, "string");
  });

  it("粘贴 oauth_creds 后打 Code Assist", () => {
    const tokens = parseGeminiCliCreds(
      JSON.stringify({ access_token: "ga", refresh_token: "gr", project_id: "proj-1" }),
    );
    assert.equal(tokens.access_token, "ga");
    assert.equal(tokens.project_id, "proj-1");
    const r = route("gemini-cli", {
      baseUrl: "https://cloudcode-pa.googleapis.com",
      apiKey: "ga",
      extraHeaders: { "x-goog-user-project": "proj-1" },
    });
    assert.equal(
      geminiChatUrl(r, false),
      "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
    );
    const wrapped = wrapGeminiBody(r, { contents: [] });
    assert.equal(wrapped.project, "proj-1");
    assert.equal(wrapped.model, "models/m");
    assert.ok(wrapped.request);
  });
});

describe("未登录调用", () => {
  afterEach(() => setRouteHydrator(undefined));

  it("没有 hydrator 时拒绝订阅上游", async () => {
    setRouteHydrator(undefined);
    await assert.rejects(
      () => hydrateRoute(route("codex", { baseUrl: "https://chatgpt.com" })),
      /未绑定/,
    );
  });

  it("未登录返回明确错误，而不是空 Bearer", async () => {
    const { db } = memoryUpstream("codex", { baseUrl: "https://chatgpt.com" });
    const auth = new ModelUpstreamAuthService(db, "test-secret");
    setRouteHydrator((r, opts) => auth.hydrateRoute(r, opts));
    await assert.rejects(
      () => hydrateRoute(route("codex", { baseUrl: "https://chatgpt.com" })),
      /尚未登录订阅/,
    );
    const headers = buildHeaders({ baseUrl: "https://chatgpt.com" }, "codex");
    assert.equal(headers.Authorization, undefined);
  });

  it("已有 oauthEnc 才能 hydrate 出 Bearer", async () => {
    const enc = encryptTokens("test-secret", { access_token: "live", account_id: "acc" });
    const { db } = memoryUpstream("codex", { baseUrl: "https://chatgpt.com", oauthEnc: enc });
    const auth = new ModelUpstreamAuthService(db, "test-secret");
    const hydrated = await auth.hydrateRoute(
      route("codex", { baseUrl: "https://chatgpt.com", oauthEnc: enc }),
    );
    assert.equal(hydrated.upstream.config.apiKey, "live");
    assert.match(buildHeaders(hydrated.upstream.config, "codex").Authorization ?? "", /Bearer live/);
  });
});
