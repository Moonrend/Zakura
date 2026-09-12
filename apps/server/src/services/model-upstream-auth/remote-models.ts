import type { ModelUpstreamConfig, ModelUpstreamProtocol } from "@zakura/shared";
import { CODEX_DEFAULT_MODELS } from "./providers/codex.js";
import { CLAUDE_DEFAULT_MODELS } from "./providers/claude-code.js";
import { CURSOR_DEFAULT_MODELS, listCursorModels } from "./providers/cursor.js";
import { GEMINI_DEFAULT_MODELS } from "./providers/gemini-cli.js";
import { GROK_DEFAULT_MODELS } from "./providers/grok.js";
import { tryBearerFromConfig } from "./tokens.js";

function asModels(ids: string[], ownedBy: string) {
  return ids.map((id) => ({ id, name: id, ownedBy, capability: "chat" }));
}

export async function listAgentRemoteModels(
  protocol: ModelUpstreamProtocol,
  cfg: ModelUpstreamConfig,
): Promise<{
  models: Array<{ id: string; name?: string; ownedBy?: string; capability?: string }>;
  message?: string;
}> {
  const apiKey = tryBearerFromConfig(cfg);
  if (protocol === "codex") {
    const token = apiKey;
    if (token) {
      try {
        const res = await fetch(`${cfg.baseUrl}/backend-api/codex/models`, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            originator: "codex_cli_rs",
            ...(cfg.extraHeaders ?? {}),
          },
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 20000),
        });
        const data = (await res.json().catch(() => null)) as {
          models?: Array<{ id?: string; slug?: string }>;
          data?: Array<{ id?: string; slug?: string }>;
        } | null;
        const raw = data?.models ?? data?.data ?? [];
        const models = raw
          .map((m) => String(m.id ?? m.slug ?? "").trim())
          .filter(Boolean)
          .map((id) => ({ id, name: id, ownedBy: "codex", capability: "chat" }));
        if (models.length) return { models };
      } catch {
        // fall through to static
      }
    }
    return { models: asModels(CODEX_DEFAULT_MODELS, "codex") };
  }

  if (protocol === "claude-code") {
    return {
      models: asModels(CLAUDE_DEFAULT_MODELS, "anthropic"),
      message: "Claude Code 无公开模型列表，已填入常见模型，可再手改",
    };
  }

  if (protocol === "cursor") {
    if (apiKey) {
      try {
        const models = await listCursorModels(apiKey);
        if (models.length) {
          return {
            models: models.map((m) => ({
              id: m.id,
              name: m.name ?? m.id,
              ownedBy: "cursor",
              capability: "chat",
            })),
          };
        }
      } catch {
        // static
      }
    }
    return { models: asModels(CURSOR_DEFAULT_MODELS, "cursor") };
  }

  if (protocol === "gemini-cli") {
    return { models: asModels(GEMINI_DEFAULT_MODELS, "google") };
  }

  if (protocol === "grok-build") {
    return { models: asModels(GROK_DEFAULT_MODELS, "xai") };
  }

  return { models: [] };
}
