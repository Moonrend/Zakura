import { and, eq } from "drizzle-orm";
import {
  isAgentSubscriptionProtocol,
  MODEL_UPSTREAM_PROTOCOL_META,
  type ModelUpstreamProtocol,
} from "@zakura/shared";
import { newId, modelUpstreams } from "../../db/schema.js";
import type { Db } from "../../db/client.js";
import type { ResolvedRoute } from "../../model-router/types.js";
import { parseJsonRecord } from "../../model-router/types.js";
import { defaultJsonHttp, type JsonHttp } from "./http.js";
import {
  bearerFromTokens,
  decryptTokens,
  encryptTokens,
  needsRefresh,
  snapshotFromTokens,
  type UpstreamOauthTokens,
} from "./tokens.js";
import type { AuthSessionSnapshot, AuthSubmitInput } from "./types.js";
import {
  CODEX_VERIFICATION_URL,
  pollCodexDeviceToken,
  refreshCodexTokens,
  requestCodexUserCode,
} from "./providers/codex.js";
import {
  claudeAuthorizeUrl,
  createClaudePkce,
  exchangeClaudeCode,
  parseClaudeCallback,
  refreshClaudeTokens,
  setupTokenAsOauth,
  type ClaudePkce,
} from "./providers/claude-code.js";
import { startCursorLogin } from "./providers/cursor.js";
import { parseGeminiCliCreds, refreshGeminiCliTokens } from "./providers/gemini-cli.js";
import { pollGrokDevice, refreshGrokTokens, startGrokDevice } from "./providers/grok.js";

type Pending =
  | {
      kind: "device";
      protocol: "codex";
      deviceAuthId: string;
      userCode: string;
      verificationUrl: string;
      interval: number;
      expiresAt: number;
      status: AuthSessionSnapshot["status"];
      error?: string;
    }
  | {
      kind: "device";
      protocol: "grok-build";
      deviceCode: string;
      userCode: string;
      verificationUrl: string;
      interval: number;
      expiresAt: number;
      tokenEndpoint: string;
      status: AuthSessionSnapshot["status"];
      error?: string;
    }
  | {
      kind: "pkce";
      protocol: "claude-code";
      pkce: ClaudePkce;
      verificationUrl: string;
      expiresAt: number;
      status: AuthSessionSnapshot["status"];
      error?: string;
    }
  | {
      kind: "sdk";
      protocol: "cursor";
      verificationUrl?: string;
      expiresAt: number;
      status: AuthSessionSnapshot["status"];
      error?: string;
      done: Promise<UpstreamOauthTokens>;
      tokens?: UpstreamOauthTokens;
      abort: AbortController;
    }
  | {
      kind: "paste";
      protocol: "gemini-cli";
      expiresAt: number;
      status: AuthSessionSnapshot["status"];
      hint: string;
      error?: string;
    };

function snapshot(id: string, row: Pending): AuthSessionSnapshot {
  const expiresIn = Math.max(0, Math.floor((row.expiresAt - Date.now()) / 1000));
  if (row.kind === "device") {
    return {
      loginId: id,
      kind: "device",
      status: row.status,
      userCode: row.userCode,
      verificationUrl: row.verificationUrl,
      interval: row.interval,
      expiresIn,
      error: row.error,
    };
  }
  if (row.kind === "pkce") {
    return {
      loginId: id,
      kind: "pkce",
      status: row.status,
      verificationUrl: row.verificationUrl,
      expiresIn,
      hint: "在打开的页面授权后，把地址栏里的 code 或完整 URL 粘贴回来",
      error: row.error,
    };
  }
  if (row.kind === "sdk") {
    return {
      loginId: id,
      kind: "sdk",
      status: row.status,
      verificationUrl: row.verificationUrl,
      interval: 2,
      expiresIn,
      hint: row.verificationUrl ? "在浏览器完成 Cursor 登录" : "正在生成登录链接…",
      error: row.error,
    };
  }
  return {
    loginId: id,
    kind: "paste",
    status: row.status,
    expiresIn,
    hint: row.hint,
    error: row.error,
  };
}

export class ModelUpstreamAuthService {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly db: Db,
    private readonly secret: string,
    private readonly http: JsonHttp = defaultJsonHttp(),
  ) {}

  async start(tenantId: string, upstreamId: string): Promise<AuthSessionSnapshot> {
    const protocol = await this.requireProtocol(tenantId, upstreamId);
    const id = newId();
    const expiresAt = Date.now() + 15 * 60 * 1000;

    if (protocol === "codex") {
      const started = await requestCodexUserCode(this.http);
      const row: Pending = {
        kind: "device",
        protocol: "codex",
        deviceAuthId: started.deviceAuthId,
        userCode: started.userCode,
        verificationUrl: CODEX_VERIFICATION_URL,
        interval: started.interval,
        expiresAt,
        status: "pending",
      };
      this.pending.set(id, row);
      return snapshot(id, row);
    }

    if (protocol === "grok-build") {
      const started = await startGrokDevice(this.http);
      const row: Pending = {
        kind: "device",
        protocol: "grok-build",
        deviceCode: started.deviceCode,
        userCode: started.userCode,
        verificationUrl: started.verificationUrl,
        interval: started.interval,
        tokenEndpoint: started.tokenEndpoint,
        expiresAt: Date.now() + started.expiresIn * 1000,
        status: "pending",
      };
      this.pending.set(id, row);
      return snapshot(id, row);
    }

    if (protocol === "claude-code") {
      const pkce = createClaudePkce();
      const row: Pending = {
        kind: "pkce",
        protocol: "claude-code",
        pkce,
        verificationUrl: claudeAuthorizeUrl(pkce),
        expiresAt,
        status: "pending",
      };
      this.pending.set(id, row);
      return snapshot(id, row);
    }

    if (protocol === "cursor") {
      const abort = new AbortController();
      const { url, done } = await startCursorLogin(abort.signal);
      const row: Pending = {
        kind: "sdk",
        protocol: "cursor",
        expiresAt,
        status: "pending",
        abort,
        done: done.then((tokens) => {
          const cur = this.pending.get(id);
          if (cur && cur.kind === "sdk" && cur.status === "pending") {
            cur.tokens = tokens;
          }
          return tokens;
        }).catch((err) => {
          const cur = this.pending.get(id);
          if (cur && cur.kind === "sdk" && cur.status === "pending") {
            cur.status = "error";
            cur.error = err instanceof Error ? err.message : String(err);
          }
          throw err;
        }),
      };
      this.pending.set(id, row);
      void url.then((verificationUrl) => {
        const cur = this.pending.get(id);
        if (cur && cur.kind === "sdk") cur.verificationUrl = verificationUrl;
      });
      try {
        row.verificationUrl = await Promise.race([
          url,
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 4000),
          ),
        ]);
      } catch {
        // URL 稍后由 poll 补上
      }
      return snapshot(id, row);
    }

    if (protocol === "gemini-cli") {
      const row: Pending = {
        kind: "paste",
        protocol: "gemini-cli",
        expiresAt,
        status: "pending",
        hint: "在本机完成 gemini 登录后，粘贴 ~/.gemini/oauth_creds.json",
      };
      this.pending.set(id, row);
      return snapshot(id, row);
    }

    throw new Error(`${MODEL_UPSTREAM_PROTOCOL_META[protocol].name} 不支持应用内登录`);
  }

  async poll(
    tenantId: string,
    upstreamId: string,
    loginId: string,
  ): Promise<AuthSessionSnapshot> {
    await this.requireProtocol(tenantId, upstreamId);
    const row = this.pending.get(loginId);
    if (!row) throw new Error("没有进行中的登录");
    if (row.status !== "pending") return snapshot(loginId, row);
    if (Date.now() > row.expiresAt) {
      row.status = "error";
      row.error = "登录已过期";
      return snapshot(loginId, row);
    }

    if (row.kind === "device" && row.protocol === "codex") {
      const result = await pollCodexDeviceToken(this.http, {
        deviceAuthId: row.deviceAuthId,
        userCode: row.userCode,
      });
      if (result.status === "pending") return snapshot(loginId, row);
      if (result.status === "error") {
        row.status = "error";
        row.error = result.error;
        return snapshot(loginId, row);
      }
      await this.saveTokens(tenantId, upstreamId, result.tokens, "device");
      row.status = "complete";
      return snapshot(loginId, row);
    }

    if (row.kind === "device" && row.protocol === "grok-build") {
      const result = await pollGrokDevice(this.http, {
        deviceCode: row.deviceCode,
        tokenEndpoint: row.tokenEndpoint,
      });
      if (result.status === "pending") return snapshot(loginId, row);
      if (result.status === "error") {
        row.status = "error";
        row.error = result.error;
        return snapshot(loginId, row);
      }
      await this.saveTokens(tenantId, upstreamId, result.tokens, "device");
      row.status = "complete";
      return snapshot(loginId, row);
    }

    if (row.kind === "sdk") {
      try {
        const tokens =
          row.tokens ??
          (await Promise.race([
            row.done,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 20)),
          ]));
        if (tokens) {
          await this.saveTokens(tenantId, upstreamId, tokens, "sdk");
          row.status = "complete";
          row.tokens = tokens;
        }
      } catch (err) {
        row.status = "error";
        row.error = err instanceof Error ? err.message : String(err);
      }
      return snapshot(loginId, row);
    }

    return snapshot(loginId, row);
  }

  async submit(
    tenantId: string,
    upstreamId: string,
    input: AuthSubmitInput,
  ): Promise<AuthSessionSnapshot> {
    const protocol = await this.requireProtocol(tenantId, upstreamId);

    if (protocol === "claude-code" && input.setupToken?.trim()) {
      await this.saveTokens(tenantId, upstreamId, setupTokenAsOauth(input.setupToken), "paste");
      return {
        loginId: input.loginId ?? "setup-token",
        kind: "paste",
        status: "complete",
      };
    }

    if (protocol === "gemini-cli" && input.credentialsJson?.trim()) {
      let tokens = parseGeminiCliCreds(input.credentialsJson);
      if (tokens.refresh_token && (!tokens.access_token || tokens.access_token === "pending")) {
        tokens = {
          ...tokens,
          ...(await refreshGeminiCliTokens(this.http, tokens.refresh_token)),
          project_id: tokens.project_id,
          email: tokens.email,
        };
      }
      await this.saveTokens(tenantId, upstreamId, tokens, "paste");
      return {
        loginId: input.loginId ?? "paste",
        kind: "paste",
        status: "complete",
      };
    }

    const loginId = input.loginId?.trim();
    if (!loginId) throw new Error("缺少 loginId");
    const row = this.pending.get(loginId);
    if (!row) throw new Error("没有进行中的登录");

    if (row.kind === "pkce" && row.protocol === "claude-code") {
      const parsed = parseClaudeCallback(input.code ?? "");
      const tokens = await exchangeClaudeCode(this.http, {
        code: parsed.code,
        verifier: row.pkce.verifier,
        state: parsed.state,
      });
      await this.saveTokens(tenantId, upstreamId, tokens, "pkce");
      row.status = "complete";
      return snapshot(loginId, row);
    }

    throw new Error("当前登录流程不接受粘贴提交");
  }

  async cancel(loginId: string): Promise<AuthSessionSnapshot> {
    const row = this.pending.get(loginId);
    if (!row) throw new Error("没有进行中的登录");
    if (row.kind === "sdk") row.abort.abort();
    row.status = "cancelled";
    return snapshot(loginId, row);
  }

  async logout(tenantId: string, upstreamId: string): Promise<void> {
    const row = await this.getRow(tenantId, upstreamId);
    const config = parseJsonRecord(row.configJson);
    delete config.oauthEnc;
    delete config.oauth;
    await this.db
      .update(modelUpstreams)
      .set({
        configJson: JSON.stringify(config),
        updatedAt: new Date(),
      })
      .where(and(eq(modelUpstreams.id, upstreamId), eq(modelUpstreams.tenantId, tenantId)));
  }

  async hydrateRoute(
    route: ResolvedRoute,
    opts?: { forceRefresh?: boolean },
  ): Promise<ResolvedRoute> {
    const protocol = route.upstream.protocol;
    if (!isAgentSubscriptionProtocol(protocol)) return route;
    const enc = route.upstream.config.oauthEnc;
    if (!enc) {
      if (route.upstream.config.apiKey) return route;
      throw new Error("尚未登录订阅，请先在上游里完成登录");
    }
    let tokens = decryptTokens(this.secret, enc);
    if (opts?.forceRefresh || needsRefresh(tokens)) {
      tokens = await this.refresh(protocol, tokens);
      await this.saveTokensByUpstreamId(route.upstream.id, tokens, route.upstream.config.oauth?.loginKind ?? protocol);
    }
    const apiKey = bearerFromTokens(tokens);
    const extraHeaders = { ...(route.upstream.config.extraHeaders ?? {}) };
    if (protocol === "codex") {
      extraHeaders.originator = extraHeaders.originator || "codex_cli_rs";
      extraHeaders["OpenAI-Beta"] = extraHeaders["OpenAI-Beta"] || "responses=experimental";
      if (tokens.account_id) extraHeaders["chatgpt-account-id"] = tokens.account_id;
    }
    if (protocol === "claude-code") {
      extraHeaders["anthropic-beta"] = extraHeaders["anthropic-beta"] || "oauth-2025-04-20";
    }
    if (protocol === "gemini-cli" && tokens.project_id) {
      extraHeaders["x-goog-user-project"] = tokens.project_id;
    }
    return {
      ...route,
      upstream: {
        ...route.upstream,
        config: {
          ...route.upstream.config,
          apiKey,
          extraHeaders,
        },
      },
    };
  }

  private async refresh(
    protocol: ModelUpstreamProtocol,
    tokens: UpstreamOauthTokens,
  ): Promise<UpstreamOauthTokens> {
    if (!tokens.refresh_token) return tokens;
    if (protocol === "codex") {
      return { ...tokens, ...(await refreshCodexTokens(this.http, tokens.refresh_token)) };
    }
    if (protocol === "claude-code") {
      return { ...tokens, ...(await refreshClaudeTokens(this.http, tokens.refresh_token)) };
    }
    if (protocol === "gemini-cli") {
      return {
        ...tokens,
        ...(await refreshGeminiCliTokens(this.http, tokens.refresh_token)),
        project_id: tokens.project_id,
        email: tokens.email,
      };
    }
    if (protocol === "grok-build") {
      return { ...tokens, ...(await refreshGrokTokens(this.http, tokens.refresh_token)) };
    }
    return tokens;
  }

  private async saveTokens(
    tenantId: string,
    upstreamId: string,
    tokens: UpstreamOauthTokens,
    loginKind: string,
  ): Promise<void> {
    const row = await this.getRow(tenantId, upstreamId);
    const config = parseJsonRecord(row.configJson);
    config.oauthEnc = encryptTokens(this.secret, tokens);
    config.oauth = snapshotFromTokens(tokens, loginKind);
    await this.db
      .update(modelUpstreams)
      .set({ configJson: JSON.stringify(config), status: "ready", lastError: null, updatedAt: new Date() })
      .where(and(eq(modelUpstreams.id, upstreamId), eq(modelUpstreams.tenantId, tenantId)));
  }

  private async saveTokensByUpstreamId(
    upstreamId: string,
    tokens: UpstreamOauthTokens,
    loginKind: string,
  ): Promise<void> {
    const row = await this.db.query.modelUpstreams.findFirst({
      where: eq(modelUpstreams.id, upstreamId),
    });
    if (!row) return;
    const config = parseJsonRecord(row.configJson);
    config.oauthEnc = encryptTokens(this.secret, tokens);
    config.oauth = snapshotFromTokens(tokens, loginKind);
    await this.db
      .update(modelUpstreams)
      .set({ configJson: JSON.stringify(config), updatedAt: new Date() })
      .where(eq(modelUpstreams.id, upstreamId));
  }

  private async requireProtocol(tenantId: string, upstreamId: string): Promise<ModelUpstreamProtocol> {
    const row = await this.getRow(tenantId, upstreamId);
    const protocol = row.protocol as ModelUpstreamProtocol;
    if (!isAgentSubscriptionProtocol(protocol)) {
      throw new Error("该上游不是订阅登录类型");
    }
    return protocol;
  }

  private async getRow(tenantId: string, upstreamId: string) {
    const row = await this.db.query.modelUpstreams.findFirst({
      where: and(eq(modelUpstreams.id, upstreamId), eq(modelUpstreams.tenantId, tenantId)),
    });
    if (!row) throw new Error("上游不存在");
    return row;
  }
}
