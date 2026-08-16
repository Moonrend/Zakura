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
    const sync: AcpArtifactSync = setupMode === "api_key" ? "none" : "exit";
    return {
      profileId,
      durableDir,
      runtimeDir,
      stateDir,
      env: { HOME: `${stateDir}/home`, HERMES_HOME: `${stateDir}/home` },
      artifacts: [file("home", "home", sync)],
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
        HOME: `${stateDir}/home`,
        XDG_CONFIG_HOME: `${stateDir}/home/.config`,
        XDG_DATA_HOME: `${stateDir}/home/.local/share`,
      },
      artifacts: [file("home", "home", sync)],
    };
  }
  if (id === "grok" || id === "copilot" || id === "kimi-code" || id === "pi") {
    const sync: AcpArtifactSync = setupMode === "api_key" ? "none" : "exit";
    return {
      profileId,
      durableDir,
      runtimeDir,
      stateDir,
      env: {
        HOME: `${stateDir}/home`,
        XDG_CONFIG_HOME: `${stateDir}/home/.config`,
        XDG_DATA_HOME: `${stateDir}/home/.local/share`,
      },
      artifacts: sync === "exit" ? [file("home", "home", sync)] : [],
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

/**
 * Interactive login must use the same durable home as subsequent ACP runs.
 * Previously the setup terminal used `/workspace` while the ACP child used a
 * fresh `/tmp` HOME, so successful Grok/Pi logins were never visible to the
 * agent process.
 */
export function acpManualSetupEnvironment(profileId: string): Record<string, string> {
  const durable = acpDurableDir(profileId);
  const home = `${durable}/home`;
  if (profileId === "hermes") {
    return { HOME: home, HERMES_HOME: home, XDG_CONFIG_HOME: `${home}/.config`, XDG_DATA_HOME: `${home}/.local/share` };
  }
  if (profileId === "opencode" || profileId === "grok" || profileId === "copilot" || profileId === "kimi-code" || profileId === "pi") {
    return { HOME: home, XDG_CONFIG_HOME: `${home}/.config`, XDG_DATA_HOME: `${home}/.local/share` };
  }
  // Codex/Claude 的 durable 凭证在 `<durable>/.codex`、`<durable>/.claude`
  // （与 acpRuntimeLayout 的 staging 路径一致）；指向 home/ 会导致
  // 登录成功但 ACP 进程 stage 不到。
  if (profileId === "codex") {
    return { HOME: home, CODEX_HOME: `${durable}/.codex`, CODEX_SQLITE_HOME: `${durable}/.codex` };
  }
  if (profileId === "claude-code") {
    return { HOME: home, CLAUDE_CONFIG_DIR: `${durable}/.claude` };
  }
  return { HOME: home };
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

/** 容器内 stage：把 durable 文件或目录拷进本次进程 state。路径已由 layout 钉死。 */
export function acpStageScript(layout: AcpRuntimeLayout): string {
  const lines = [
    `mkdir -p -m 0700 ${sh(layout.runtimeDir)} ${sh(layout.stateDir)} ${sh(layout.durableDir)}`,
  ];
  for (const a of layout.artifacts) {
    const src = `${layout.durableDir}/${a.durableRel}`;
    const dest = `${layout.stateDir}/${a.runtimeRel}`;
    lines.push(`mkdir -p ${sh(dirnamePosix(dest))} ${sh(dirnamePosix(src))}`);
    // Profiles such as Grok and Pi persist a small directory rather than a
    // single credential file.  The artifact list is allowlisted, so copying a
    // directory here never exposes the rest of HOME to the workspace volume.
    lines.push(`if [ -e ${sh(src)} ]; then rm -rf ${sh(dest)}; cp -a ${sh(src)} ${sh(dest)}; fi`);
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
      lines.push(`if [ -e ${sh(src)} ]; then rm -rf ${sh(dest)}; cp -a ${sh(src)} ${sh(dest)}; fi`);
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

/**
 * Hermes reads its durable `.env` before inherited process variables. For a
 * Zakura-routed profile, derive these fields from the Gateway credentials too.
 */
export function acpApiKeyDotenv(
  profileId: string,
  managed: Record<string, string>,
): string | null {
  if (profileId !== "hermes") return null;
  const routed = Boolean(managed.zakura_api_key?.trim());
  const apiKey = (routed ? managed.zakura_api_key : managed.api_key)?.trim();
  const baseUrl = (routed ? managed.zakura_base_url : managed.base_url)?.trim();
  const lines = [
    routed ? "LLM_PROVIDER=openai" : managed.provider?.trim() ? `LLM_PROVIDER=${managed.provider.trim()}` : "",
    managed.model?.trim() ? `LLM_MODEL=${managed.model.trim()}` : "",
    apiKey ? `LLM_API_KEY=${apiKey}` : "",
    apiKey ? `OPENAI_API_KEY=${apiKey}` : "",
    apiKey ? `HERMES_API_KEY=${apiKey}` : "",
    apiKey ? `OPENAI_API_TOKEN=${apiKey}` : "",
    apiKey ? `API_KEY=${apiKey}` : "",
    baseUrl ? `LLM_BASE_URL=${baseUrl}` : "",
    baseUrl ? `OPENAI_BASE_URL=${baseUrl}` : "",
    baseUrl ? `OPENAI_API_BASE=${baseUrl}` : "",
    baseUrl ? `OPENAI_API_BASE_URL=${baseUrl}` : "",
    baseUrl ? `LLM_API_BASE=${baseUrl}` : "",
    baseUrl ? `LLM_API_BASE_URL=${baseUrl}` : "",
    baseUrl ? `HERMES_BASE_URL=${baseUrl}` : "",
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

export type AcpRuntimeConfigFile = {
  /** 容器内绝对路径 */
  dest: string;
  content: string;
};

function tomlStr(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 为 key 型启动生成各 CLI 真正读取的配置文件。
 *
 * 仅靠环境变量并不可靠：
 * - OpenCode 的自定义 provider 必须写在 opencode.json（`provider.<id>` 节点），
 *   env key 只对内置 Anthropic/OpenAI 供应商有效，且无法携带 base URL；
 * - Codex 的 base URL / model 只认 CODEX_HOME/config.toml，OPENAI_BASE_URL /
 *   OPENAI_MODEL 环境变量会被忽略（与 cc-switch 的写入方式一致）。
 *
 * self/oauth 模式返回空：用户登录态所在的 home 由 stage 脚本原样带入，不能覆盖。
 * 文件落在一次性 runtime state 目录（退出即删），不进入 durable 卷。
 */
export function acpGeneratedRuntimeFiles(input: {
  layout: AcpRuntimeLayout;
  /** 生效的 setupMode（Zakura 路由已按 api_key 布局） */
  keyMode: "api_key" | "oauth" | "self";
  routed: boolean;
  managed: Record<string, string>;
  /** Zakura 路由下从网关 /v1/models 拉到的模型别名 */
  gatewayModels?: string[];
  /** 未显式选模型时优先使用的别名（如 Agent 的 Zakura 默认 chat 模型） */
  preferredModel?: string;
}): AcpRuntimeConfigFile[] {
  if (input.keyMode !== "api_key") return [];
  const { layout, managed, routed } = input;
  const key = (routed ? managed.zakura_api_key : managed.api_key)?.trim() ?? "";
  const baseUrl = (routed ? managed.zakura_base_url : managed.base_url)?.trim() ?? "";
  const model = managed.model?.trim() ?? "";

  if (layout.profileId === "opencode") {
    const file = opencodeConfigFile(
      layout,
      key,
      baseUrl,
      model,
      routed,
      input.gatewayModels,
      input.preferredModel,
    );
    return file ? [file] : [];
  }
  if (layout.profileId === "codex") {
    const fallback =
      input.gatewayModels?.find((id) => id === input.preferredModel?.trim()) ??
      input.gatewayModels?.[0];
    return codexConfigFiles(layout, key, baseUrl, model, routed, fallback);
  }
  return [];
}

function opencodeConfigFile(
  layout: AcpRuntimeLayout,
  key: string,
  baseUrl: string,
  model: string,
  routed: boolean,
  gatewayModels?: string[],
  preferredModel?: string,
): AcpRuntimeConfigFile | null {
  const configHome = layout.env.XDG_CONFIG_HOME;
  if (!configHome) return null;
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
  };
  if (baseUrl && key) {
    // Zakura 路由固定走网关的 OpenAI 兼容端点；原生 key 按前缀选协议。
    const anthropic = !routed && key.startsWith("sk-ant-");
    const providerId = routed ? "zakura" : anthropic ? "anthropic-compatible" : "openai-compatible";
    // 网关模型全量注册（聊天框可切换）；默认取显式选择 > Agent 默认 > 首个。
    const modelIds = gatewayModels?.length ? gatewayModels : model ? [model] : [];
    config.provider = {
      [providerId]: {
        npm: routed || !anthropic ? "@ai-sdk/openai-compatible" : "@ai-sdk/anthropic",
        name: routed
          ? "Zakura Gateway"
          : anthropic
            ? "Anthropic Compatible"
            : "OpenAI Compatible",
        options: { apiKey: key, baseURL: baseUrl },
        ...(modelIds.length
          ? {
              models: Object.fromEntries(
                modelIds.map((id) => [id, { name: id }]),
              ),
            }
          : {}),
      },
    };
    const preferred =
      model ||
      (preferredModel && modelIds.includes(preferredModel) ? preferredModel : undefined) ||
      modelIds[0];
    if (preferred) config.model = `${providerId}/${preferred}`;
  } else if (model && key) {
    // 没有 base URL：挂到内置供应商，key 走 env（ANTHROPIC_API_KEY / OPENAI_API_KEY）。
    const prefix = key.startsWith("sk-ant-") ? "anthropic" : "openai";
    config.model = `${prefix}/${model}`;
  } else {
    return null;
  }
  return {
    dest: `${configHome}/opencode/opencode.json`,
    content: `${JSON.stringify(config, null, 2)}\n`,
  };
}

function codexConfigFiles(
  layout: AcpRuntimeLayout,
  key: string,
  baseUrl: string,
  model: string,
  routed: boolean,
  fallbackModel?: string,
): AcpRuntimeConfigFile[] {
  const codexHome = layout.env.CODEX_HOME;
  if (!codexHome) return [];
  const preferred = model || fallbackModel || "";
  if (!baseUrl && !preferred) return [];
  const lines: string[] = [];
  if (preferred) lines.push(`model = ${tomlStr(preferred)}`);
  if (baseUrl) {
    const providerId = routed ? "zakura" : "custom";
    lines.push(`model_provider = ${tomlStr(providerId)}`);
    lines.push("");
    lines.push(`[model_providers.${providerId}]`);
    lines.push(`name = ${tomlStr(routed ? "Zakura Gateway" : "Custom Provider")}`);
    lines.push(`base_url = ${tomlStr(baseUrl)}`);
    // Codex ≥1.2 移除了 chat wire API；网关侧用 /v1/responses 桥接 Responses 协议。
    lines.push(`wire_api = "responses"`);
    lines.push(`requires_openai_auth = true`);
  }
  const files: AcpRuntimeConfigFile[] = [
    { dest: `${codexHome}/config.toml`, content: `${lines.join("\n")}\n` },
  ];
  if (key) {
    files.push({
      dest: `${codexHome}/auth.json`,
      content: `${JSON.stringify({ OPENAI_API_KEY: key }, null, 2)}\n`,
    });
  }
  return files;
}
