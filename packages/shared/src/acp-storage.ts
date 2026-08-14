/**
 * ACP 进程 runtime 与 durable 凭证的边界。
 * 完整 HOME 不落 /workspace；只按 profile 声明的文件进出 /workspace/data/acp/<id>。
 */
import { AGENT_DATA_DIR, AGENT_WORKSPACE_ROOT } from "./projects.js";

type AcpSetupMode = "api_key" | "oauth" | "self";

export type AcpArtifactSync = "none" | "exit" | "codex_auth";

export type AcpRuntimeArtifact = {
  /** 相对 durable 根 */
  durableRel: string;
  /** 相对进程 state 目录（即 CODEX_HOME / CLAUDE_CONFIG_DIR） */
  runtimeRel: string;
  sync: AcpArtifactSync;
};

export type AcpRuntimeLayout = {
  profileId: string;
  durableDir: string;
  runtimeDir: string;
  stateDir: string;
  env: Record<string, string>;
  artifacts: AcpRuntimeArtifact[];
};

export function acpDurableDir(profileId: string): string {
  return `${AGENT_WORKSPACE_ROOT}/${AGENT_DATA_DIR}/acp/${profileId}`;
}

export function acpRuntimeDir(profileId: string, runtimeId: string): string {
  return `/tmp/zakura-acp/${profileId}/${runtimeId}`;
}

function file(
  durableRel: string,
  runtimeRel: string,
  sync: AcpArtifactSync,
): AcpRuntimeArtifact {
  return { durableRel, runtimeRel, sync };
}

export function acpRuntimeLayout(
  profileId: string,
  setupMode: AcpSetupMode,
  runtimeId: string,
): AcpRuntimeLayout {
  const durableDir = acpDurableDir(profileId);
  const runtimeDir = acpRuntimeDir(profileId, runtimeId);
  const stateDir = `${runtimeDir}/state`;
  const id = profileId;
  if (id === "codex") {
    const authSync: AcpArtifactSync =
      setupMode === "api_key" ? "none" : "codex_auth";
    const cfgSync: AcpArtifactSync = setupMode === "self" ? "exit" : "none";
    return {
      profileId,
      durableDir,
      runtimeDir,
      stateDir,
      env: {
        HOME: runtimeDir,
        CODEX_HOME: stateDir,
        CODEX_SQLITE_HOME: stateDir,
        ...(setupMode === "oauth" ? { NO_BROWSER: "1" } : {}),
      },
      artifacts: [
        file(".codex/auth.json", "auth.json", authSync),
        file(".codex/config.toml", "config.toml", cfgSync),
      ],
    };
  }
  if (id === "claude-code") {
    const self = setupMode === "self";
    return {
      profileId,
      durableDir,
      runtimeDir,
      stateDir,
      env: { HOME: runtimeDir, CLAUDE_CONFIG_DIR: stateDir },
      artifacts: self
        ? [
            file(".claude/.credentials.json", ".credentials.json", "exit"),
            file(".claude/settings.json", "settings.json", "exit"),
            file(".claude/settings.local.json", "settings.local.json", "exit"),
            file(".claude/CLAUDE.md", "CLAUDE.md", "exit"),
            file(".claude.json", ".claude.json", "none"),
          ]
        : [],
    };
  }
  if (id === "hermes") {
    const sync: AcpArtifactSync = setupMode === "self" ? "exit" : "none";
    return {
      profileId,
      durableDir,
      runtimeDir,
      stateDir,
      env: { HOME: runtimeDir, HERMES_HOME: stateDir },
      artifacts: [
        file(".hermes/config.yaml", "config.yaml", sync),
        file(".hermes/.env", ".env", setupMode === "api_key" ? "none" : sync),
        file(".hermes/auth.json", "auth.json", sync),
      ],
    };
  }
  if (id === "opencode") {
    const sync: AcpArtifactSync = setupMode === "api_key" ? "none" : "exit";
    return {
      profileId,
      durableDir,
      runtimeDir,
      stateDir,
      env: {
        HOME: runtimeDir,
        XDG_CONFIG_HOME: `${runtimeDir}/config`,
        XDG_DATA_HOME: `${runtimeDir}/data`,
      },
      artifacts: [
        file(".config/opencode/opencode.json", "../config/opencode/opencode.json", sync),
        file(".local/share/opencode/auth.json", "../data/opencode/auth.json", sync),
      ],
    };
  }
  if (id === "grok" || id === "copilot" || id === "kimi-code" || id === "pi") {
    const sync: AcpArtifactSync = setupMode === "self" ? "exit" : "none";
    return {
      profileId,
      durableDir,
      runtimeDir,
      stateDir,
      env: {
        HOME: runtimeDir,
        XDG_CONFIG_HOME: `${runtimeDir}/config`,
        XDG_DATA_HOME: `${runtimeDir}/data`,
      },
      artifacts: sync === "exit" ? [file(`.${id}/credentials.json`, "credentials.json", sync)] : [],
    };
  }
  return {
    profileId,
    durableDir,
    runtimeDir,
    stateDir,
    env: { HOME: runtimeDir },
    artifacts:
      setupMode === "self"
        ? [file(".credentials.json", ".credentials.json", "exit")]
        : [],
  };
}

export function preferNewerCodexAuth(durableRaw: string, runtimeRaw: string): string {
  const durableAt = codexLastRefresh(durableRaw);
  const runtimeAt = codexLastRefresh(runtimeRaw);
  if (!runtimeAt) return durableRaw || runtimeRaw;
  if (!durableAt) return runtimeRaw;
  return runtimeAt >= durableAt ? runtimeRaw : durableRaw;
}

function codexLastRefresh(raw: string): number {
  try {
    const o = JSON.parse(raw) as { last_refresh?: unknown };
    if (typeof o.last_refresh !== "string" || !o.last_refresh.trim()) return 0;
    const t = Date.parse(o.last_refresh);
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

/** 容器内 stage：把 durable 文件拷进本次进程 state。路径已由 layout 钉死。 */
export function acpStageScript(layout: AcpRuntimeLayout): string {
  const lines = [
    `mkdir -p -m 0700 ${sh(layout.runtimeDir)} ${sh(layout.stateDir)} ${sh(layout.durableDir)}`,
  ];
  for (const a of layout.artifacts) {
    const src = `${layout.durableDir}/${a.durableRel}`;
    const dest = `${layout.stateDir}/${a.runtimeRel}`;
    lines.push(`mkdir -p ${sh(dirnamePosix(dest))} ${sh(dirnamePosix(src))}`);
    lines.push(`if [ -f ${sh(src)} ]; then cp -a ${sh(src)} ${sh(dest)}; fi`);
  }
  return lines.join("\n");
}

export function acpSyncBackScript(layout: AcpRuntimeLayout): string {
  const lines: string[] = [];
  for (const a of layout.artifacts) {
    if (a.sync === "none") continue;
    const src = `${layout.stateDir}/${a.runtimeRel}`;
    const dest = `${layout.durableDir}/${a.durableRel}`;
    lines.push(`mkdir -p ${sh(dirnamePosix(dest))}`);
    if (a.sync === "codex_auth") {
      lines.push(
        `if [ -f ${sh(src)} ]; then`,
        `  if [ ! -f ${sh(dest)} ]; then cp -a ${sh(src)} ${sh(dest)};`,
        `  else python3 - ${sh(src)} ${sh(dest)} <<'PY'`,
        `import json,sys,datetime`,
        `src,dst=sys.argv[1],sys.argv[2]`,
        `def ts(p):`,
        `  try:`,
        `    t=json.load(open(p)).get("last_refresh") or ""`,
        `    return datetime.datetime.fromisoformat(t.replace("Z","+00:00")) if t else datetime.datetime.min.replace(tzinfo=datetime.timezone.utc)`,
        `  except Exception:`,
        `    return datetime.datetime.min.replace(tzinfo=datetime.timezone.utc)`,
        `if ts(src)>=ts(dst):`,
        `  open(dst,"wb").write(open(src,"rb").read())`,
        `PY`,
        `  fi`,
        `fi`,
      );
    } else {
      lines.push(`if [ -f ${sh(src)} ]; then cp -a ${sh(src)} ${sh(dest)}; fi`);
    }
  }
  lines.push(`rm -rf ${sh(layout.runtimeDir)}`);
  return lines.join("\n");
}

function dirnamePosix(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** api_key 模式写入进程 state 的 .env（Hermes）；其它 profile 返回 null。 */
export function acpApiKeyDotenv(
  profileId: string,
  managed: Record<string, string>,
): string | null {
  if (profileId !== "hermes") return null;
  const lines = [
    managed.provider?.trim() ? `LLM_PROVIDER=${managed.provider.trim()}` : "",
    managed.model?.trim() ? `LLM_MODEL=${managed.model.trim()}` : "",
    managed.api_key?.trim() ? `LLM_API_KEY=${managed.api_key.trim()}` : "",
    managed.base_url?.trim() ? `LLM_BASE_URL=${managed.base_url.trim()}` : "",
  ].filter(Boolean);
  return lines.length ? `${lines.join("\n")}\n` : null;
}

export function buildCodexAuthJson(tokens: {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id?: string;
}): string {
  return JSON.stringify({
    tokens: {
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      ...(tokens.account_id ? { account_id: tokens.account_id } : {}),
    },
    last_refresh: new Date().toISOString(),
  });
}
