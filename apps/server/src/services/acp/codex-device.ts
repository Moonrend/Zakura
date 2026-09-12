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
import { defaultJsonHttp, type JsonHttp } from "../model-upstream-auth/http.js";
import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_ISSUER,
  CODEX_VERIFICATION_URL,
  pollCodexDeviceToken,
  requestCodexUserCode,
} from "../model-upstream-auth/providers/codex.js";

export { CODEX_OAUTH_CLIENT_ID, CODEX_OAUTH_ISSUER };

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

const EXPIRES_MS = 15 * 60 * 1000;

function asJsonHttp(http: CodexDeviceHttp): JsonHttp {
  const fallback = defaultJsonHttp();
  return {
    postJson: http.postJson.bind(http),
    getJson: fallback.getJson,
    postForm: fallback.postForm,
  };
}

export function defaultCodexDeviceHttp(): CodexDeviceHttp {
  return defaultJsonHttp();
}

export class CodexDeviceAuth {
  private readonly pending = new Map<string, PendingLogin>();
  private readonly jsonHttp: JsonHttp;

  constructor(
    private readonly workspace: AgentWorkspaceService,
    http: CodexDeviceHttp = defaultCodexDeviceHttp(),
  ) {
    this.jsonHttp = asJsonHttp(http);
  }

  async start(agent: Agent): Promise<CodexDeviceSnapshot> {
    this.dropExpired();
    const started = await requestCodexUserCode(this.jsonHttp);
    const row: PendingLogin = {
      id: newId(),
      agentId: agent.id,
      deviceAuthId: started.deviceAuthId,
      userCode: started.userCode,
      verificationUrl: CODEX_VERIFICATION_URL,
      interval: started.interval,
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
    const result = await pollCodexDeviceToken(this.jsonHttp, {
      deviceAuthId: row.deviceAuthId,
      userCode: row.userCode,
    });
    if (result.status === "pending") return snapshot(row);
    if (result.status === "error") {
      row.status = "error";
      row.error = result.error;
      return snapshot(row);
    }
    await writeDurableAuthJson(
      this.workspace,
      agent,
      buildCodexAuthJson({
        id_token: result.tokens.id_token ?? "",
        access_token: result.tokens.access_token,
        refresh_token: result.tokens.refresh_token ?? "",
        account_id: result.tokens.account_id,
      }),
    );
    row.status = "complete";
    return snapshot(row);
  }

  cancel(agent: Agent, loginId: string): CodexDeviceSnapshot {
    const row = this.pending.get(loginId);
    if (!row || row.agentId !== agent.id) throw new Error("没有进行中的设备码登录");
    row.status = "cancelled";
    return snapshot(row);
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

function dirnamePosix(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
