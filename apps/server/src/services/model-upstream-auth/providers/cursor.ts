import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpstreamOauthTokens } from "../tokens.js";

export const CURSOR_DEFAULT_MODELS = ["composer-2.5", "composer-2", "grok-4.6"];

export type CursorLoginApi = {
  login: (opts: {
    openBrowser: false;
    onLoginUrl: (url: string) => void;
    store: null;
    signal?: AbortSignal;
  }) => Promise<{ apiKey: string; email?: string; apiKeyExpiresAtMs?: number }>;
  listModels: (apiKey: string) => Promise<Array<{ id: string; name?: string }>>;
  prompt: (input: {
    text: string;
    apiKey: string;
    model: string;
  }) => Promise<string>;
};

let injected: CursorLoginApi | null = null;

export function setCursorLoginApi(api: CursorLoginApi | null): void {
  injected = api;
}

async function loadSdk(): Promise<CursorLoginApi> {
  if (injected) return injected;
  const mod = (await import("@cursor/sdk")) as {
    Cursor?: {
      auth: {
        login: CursorLoginApi["login"];
      };
      models?: {
        list: (opts?: { apiKey?: string }) => Promise<Array<{ id: string; name?: string }>>;
      };
    };
    Agent?: {
      prompt: (
        text: string,
        opts: {
          apiKey: string;
          model: { id: string };
          local: { cwd: string };
          tools?: string[];
        },
      ) => Promise<{ result?: unknown; status?: string }>;
    };
  };
  if (!mod.Cursor?.auth?.login) {
    throw new Error("未安装 @cursor/sdk，无法登录 Cursor");
  }
  return {
    login: (opts) => mod.Cursor!.auth.login(opts),
    listModels: async (apiKey) => {
      const list = await mod.Cursor?.models?.list?.({ apiKey });
      if (!Array.isArray(list)) return [];
      return list
        .map((m) => {
          const rec = m as { id?: unknown; name?: unknown; displayName?: unknown };
          const id = typeof rec.id === "string" ? rec.id : "";
          const name =
            typeof rec.name === "string"
              ? rec.name
              : typeof rec.displayName === "string"
                ? rec.displayName
                : undefined;
          return { id, name };
        })
        .filter((m) => m.id);
    },
    prompt: async ({ text, apiKey, model }) => {
      if (!mod.Agent?.prompt) throw new Error("@cursor/sdk 缺少 Agent.prompt");
      const cwd = mkdtempSync(join(tmpdir(), "zakura-cursor-"));
      const result = await mod.Agent.prompt(text, {
        apiKey,
        model: { id: model },
        local: { cwd },
        tools: [],
      });
      if (typeof result.result === "string") return result.result;
      if (result.result && typeof result.result === "object") {
        const rec = result.result as { text?: unknown; message?: unknown };
        if (typeof rec.text === "string") return rec.text;
        if (typeof rec.message === "string") return rec.message;
      }
      return result.status ?? "";
    },
  };
}

export async function startCursorLogin(signal?: AbortSignal): Promise<{
  url: Promise<string>;
  done: Promise<UpstreamOauthTokens>;
}> {
  const api = await loadSdk();
  let settleUrl: (url: string) => void = () => undefined;
  const url = new Promise<string>((resolve) => {
    settleUrl = resolve;
  });
  const done = api.login({
    openBrowser: false,
    store: null,
    signal,
    onLoginUrl: (loginUrl) => settleUrl(loginUrl),
  }).then((result) => {
    if (!result.apiKey) throw new Error("Cursor 登录未返回 API Key");
    return {
      access_token: result.apiKey,
      api_key: result.apiKey,
      email: result.email,
      expires_at: result.apiKeyExpiresAtMs,
    } satisfies UpstreamOauthTokens;
  });
  return { url, done };
}

export async function listCursorModels(apiKey: string): Promise<Array<{ id: string; name?: string }>> {
  try {
    const api = await loadSdk();
    const models = await api.listModels(apiKey);
    if (models.length) return models;
  } catch {
    // fall through
  }
  return CURSOR_DEFAULT_MODELS.map((id) => ({ id, name: id }));
}

export async function cursorPrompt(input: {
  text: string;
  apiKey: string;
  model: string;
}): Promise<string> {
  const api = await loadSdk();
  return api.prompt(input);
}
