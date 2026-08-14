/**
 * Codex ChatGPT 设备码登录（公开 device flow）。
 * 成功后只写 durable auth.json，由 session 再 stage 进本次 CODEX_HOME。
 */
import {
  acpDurableDir,
  buildCodexAuthJson,
  preferNewerCodexAuth,
} from "@zakura/shared";
import { newId } from "../../db/schema.js";
import type { Agent } from "../../db/schema.js";
import type { AgentWorkspaceService } from "../agent-workspace.js";

export const CODEX_OAUTH_ISSUER = "https://auth.openai.com";
/** 公开 Codex CLI 的 OAuth client_id（openai/codex 源码常量）。 */
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export type CodexDeviceStatus = "pending" | "complete" | "error" | "cancelled";

export type CodexDeviceSnapshot = {
  loginId: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresIn: number;
  status: CodexDeviceStatus;
  error?: string;
};

export type CodexDeviceHttp = {
  postJson: (url: string, body: unknown) => Promise<{ status: number; json: unknown }>;
};

type PendingLogin = {
  id: string;
  agentId: string;
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresAt: number;
  status: CodexDeviceStatus;
  error?: string;
};

const DEFAULT_INTERVAL = 5;
const EXPIRES_MS = 15 * 60 * 1000;

export function defaultCodexDeviceHttp(): CodexDeviceHttp {
  return {
    async postJson(url, body) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    },
  };
}

export class CodexDeviceAuth {
  private readonly pending = new Map<string, PendingLogin>();

  constructor(
    private readonly workspace: AgentWorkspaceService,
    private readonly http: CodexDeviceHttp = defaultCodexDeviceHttp(),
  ) {}

  async start(agent: Agent): Promise<CodexDeviceSnapshot> {
    this.dropExpired();
    const started = await this.http.postJson(
      `${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`,
      { client_id: CODEX_OAUTH_CLIENT_ID },
    );
    if (started.status < 200 || started.status >= 300) {
      throw new Error(`Codex 设备码申请失败（HTTP ${started.status}）`);
    }
    const rec = asRecord(started.json);
    const deviceAuthId = str(rec?.device_auth_id);
    const userCode = str(rec?.user_code) || str(rec?.usercode);
    if (!deviceAuthId || !userCode) throw new Error("Codex 设备码响应缺少 user_code");
    const interval = Math.max(1, Number(rec?.interval) || DEFAULT_INTERVAL);
    const row: PendingLogin = {
      id: newId(),
      agentId: agent.id,
      deviceAuthId,
      userCode,
      verificationUrl: `${CODEX_OAUTH_ISSUER}/codex/device`,
      interval,
      expiresAt: Date.now() + EXPIRES_MS,
      status: "pending",
    };
    this.pending.set(row.id, row);
    return snapshot(row);
  }

  async poll(agent: Agent, loginId: string): Promise<CodexDeviceSnapshot> {
    const row = this.pending.get(loginId);
    if (!row || row.agentId !== agent.id) throw new Error("没有进行中的设备码登录");
    if (row.status !== "pending") return snapshot(row);
    if (Date.now() > row.expiresAt) {
      row.status = "error";
      row.error = "设备码已过期";
      return snapshot(row);
    }
    const polled = await this.http.postJson(
      `${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/token`,
      { device_auth_id: row.deviceAuthId, user_code: row.userCode },
    );
    if (polled.status === 403 || polled.status === 404) return snapshot(row);
    if (polled.status < 200 || polled.status >= 300) {
      row.status = "error";
      row.error = `轮询失败（HTTP ${polled.status}）`;
      return snapshot(row);
    }
    try {
      const tokens = await this.exchange(asRecord(polled.json) ?? {});
      await writeDurableAuthJson(this.workspace, agent, buildCodexAuthJson(tokens));
      row.status = "complete";
    } catch (err) {
      row.status = "error";
      row.error = err instanceof Error ? err.message : String(err);
    }
    return snapshot(row);
  }

  cancel(agent: Agent, loginId: string): CodexDeviceSnapshot {
    const row = this.pending.get(loginId);
    if (!row || row.agentId !== agent.id) throw new Error("没有进行中的设备码登录");
    row.status = "cancelled";
    return snapshot(row);
  }

  private async exchange(codeResp: Record<string, unknown>): Promise<{
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id?: string;
  }> {
    const authorizationCode = str(codeResp.authorization_code);
    const codeVerifier = str(codeResp.code_verifier);
    if (!authorizationCode || !codeVerifier) {
      throw new Error("设备码尚未完成授权");
    }
    const exchanged = await this.http.postJson(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
      grant_type: "authorization_code",
      client_id: CODEX_OAUTH_CLIENT_ID,
      code: authorizationCode,
      redirect_uri: `${CODEX_OAUTH_ISSUER}/deviceauth/callback`,
      code_verifier: codeVerifier,
    });
    if (exchanged.status < 200 || exchanged.status >= 300) {
      throw new Error(`换票失败（HTTP ${exchanged.status}）`);
    }
    const rec = asRecord(exchanged.json) ?? {};
    const access = str(rec.access_token);
    const refresh = str(rec.refresh_token);
    const idToken = str(rec.id_token);
    if (!access || !refresh || !idToken) throw new Error("换票响应缺少 token");
    return {
      id_token: idToken,
      access_token: access,
      refresh_token: refresh,
      ...(str(rec.account_id) ? { account_id: str(rec.account_id) } : {}),
    };
  }

  private dropExpired() {
    const now = Date.now();
    for (const [id, row] of this.pending) {
      if (now > row.expiresAt + 60_000) this.pending.delete(id);
    }
  }
}

export async function writeDurableAuthJson(
  workspace: AgentWorkspaceService,
  agent: Agent,
  runtimeRaw: string,
): Promise<void> {
  const dest = `${acpDurableDir("codex")}/.codex/auth.json`;
  const existing = await workspace.execInWorkspace(agent, [
    "bash",
    "-lc",
    `cat ${sh(dest)} 2>/dev/null || true`,
  ]);
  const merged = preferNewerCodexAuth(existing.stdout ?? "", runtimeRaw);
  const b64 = Buffer.from(merged, "utf8").toString("base64");
  await workspace.execInWorkspace(agent, [
    "bash",
    "-lc",
    `mkdir -p ${sh(dirnamePosix(dest))} && printf '%s' ${sh(b64)} | base64 -d > ${sh(dest)} && chmod 600 ${sh(dest)}`,
  ]);
}

/** 单测用：比较两份 auth.json，不碰容器。 */
export function mergeCodexAuthJson(durableRaw: string, runtimeRaw: string): string {
  return preferNewerCodexAuth(durableRaw, runtimeRaw);
}

function snapshot(row: PendingLogin): CodexDeviceSnapshot {
  return {
    loginId: row.id,
    userCode: row.userCode,
    verificationUrl: row.verificationUrl,
    interval: row.interval,
    expiresIn: Math.max(0, Math.floor((row.expiresAt - Date.now()) / 1000)),
    status: row.status,
    ...(row.error ? { error: row.error } : {}),
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function dirnamePosix(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
