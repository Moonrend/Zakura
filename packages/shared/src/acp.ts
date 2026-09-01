/**
 * ACP（Agent Client Protocol）配置与 profile。
 * Zakura 是 Client；第三方编码 Agent 跑在 workspace 容器里。
 */

import { acpManualSetupEnvironment } from "./acp-storage.js";

export const ACP_PROTOCOL_VERSION = 1;

export const ACP_SETUP_MODES = ["api_key", "oauth", "self"] as const;
export type AcpSetupMode = (typeof ACP_SETUP_MODES)[number];

export const ACP_PERMISSION_POLICIES = ["ask", "allow"] as const;
export type AcpPermissionPolicy = (typeof ACP_PERMISSION_POLICIES)[number];

export const ACP_BUILTIN_PROFILE_IDS = [
  "claude-code",
  "codex",
  "gemini-cli",
  "hermes",
  "grok",
  "copilot",
  "kimi-code",
  "pi",
  "opencode",
  "fx",
  "kiro",
  "auggie",
  "cline",
  "cursor",
  "devin",
  "factory-droid",
  "goose",
  "junie",
  "qwen-code",
  "mistral-vibe",
  "nova",
  "dirac",
  "codebuddy",
  "amp",
  "deepagents",
  "poolside",
  "sigit",
  "fast-agent",
] as const;
export type AcpBuiltinProfileId = (typeof ACP_BUILTIN_PROFILE_IDS)[number];

export const ZAKURA_RUNTIME_ID = "zakura";

export const ACP_IMAGE_BIN_DIR = "/opt/zakura/acp/bin";

const shq = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;

/**
 * Shell expression that resolves an ACP adapter command to an absolute path,
 * writing `ZAKURA_BIN_MISSING:<command>` to stderr and exiting 127 when it is
 * genuinely absent.
 *
 * Bare names get looked up in our own install dir *before* PATH. That matters
 * because we launch adapters with `HOME` pointed at a throwaway state dir, so any
 * PATH that an installer appended to `~/.bashrc` or `~/.profile` is not in
 * effect. `fx` is installed by `fx.sh`, which does exactly that — which is why
 * `exec fx` used to fail with "fx: not found" even though the binary was in the
 * image. Preferring `ACP_IMAGE_BIN_DIR` fixes fx and every npm-installed adapter
 * (they all land in the same prefix) without hardcoding a profile id, while the
 * PATH fallback keeps user-supplied commands working.
 */
export function acpCommandResolveExpr(command: string, varName = "ZAKURA_ACP_BIN"): string {
  if (command.includes("/")) {
    // Already a path: use verbatim, but still fail loudly rather than exec'ing nothing.
    return (
      `${varName}=${shq(command)}; ` +
      `[ -x "$${varName}" ] || command -v "$${varName}" >/dev/null 2>&1 || ` +
      `{ echo ${shq(`ZAKURA_BIN_MISSING:${command}`)} >&2; exit 127; }`
    );
  }
  const pinned = `${ACP_IMAGE_BIN_DIR}/${command}`;
  return (
    `${varName}="$({ [ -x ${shq(pinned)} ] && printf %s ${shq(pinned)}; } || command -v ${shq(command)} || true)"; ` +
    `[ -n "$${varName}" ] || { echo ${shq(`ZAKURA_BIN_MISSING:${command}`)} >&2; exit 127; }`
  );
}

/** docker exec 的 argv[0] 按容器 PATH 查找；先起 bash 再 exec 适配器。 */
export function acpStdioArgv(command: string, args: string[] = []): string[] {
  const quotedArgs = args.map(shq).join(" ");
  const resolve = acpCommandResolveExpr(command);
  return [
    "/bin/bash",
    "-lc",
    `${resolve}; exec "$ZAKURA_ACP_BIN"${quotedArgs ? ` ${quotedArgs}` : ""}`,
  ];
}

export const ACP_PROFILE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export type AcpManagedFieldType = "password" | "text" | "url";

export type AcpManagedField = {
  id: string;
  label: string;
  type: AcpManagedFieldType;
  required?: boolean;
  sensitive?: boolean;
  placeholder?: string;
  help?: string;
};

export type AcpPublicProfile = {
  id: string;
  displayName: string;
  description: string;
  /**
   * Zakura 维护该 profile 的启动命令/参数，用户不可手改。
   *
   * 这**不**代表适配器已经装好。历史上 `builtin` 同时表达「已预装」「不可编辑」
   * 「禁止安装」三件事，于是 28 个内置 agent 全部在 UI 上谎称已预装、且点安装
   * 必然抛错。现在这三个语义被拆成 `managed` / `preinstalled` / 安装路径本身。
   */
  managed: boolean;
  /**
   * 适配器随镜像出厂，无需 provision。当前只有 fx（且仅 full 镜像）满足。
   * 其余 profile 一律按需装到 /workspace/.zakura/acp/<id>/<version>/。
   */
  preinstalled?: boolean;
  command: string;
  args: string[];
  setupModes: AcpSetupMode[];
  managedFields: AcpManagedField[];
  installHint?: string;
  /** Claude Code 钉 default，避免宿主 settings 绕过授权 */
  sessionModeId?: string;
  /** 不管 Agent 是否宣告 mcpCapabilities.http，都转发 HTTP MCP */
  forceHttpMcp?: boolean;
  /** Zakura Gateway currently exposes the OpenAI-compatible protocol. */
  supportsZakuraRoute?: boolean;
};

export type AcpManualSetupCommand = {
  command: string[];
  initialInput?: string;
  display: string;
};

/**
 * 交互终端里启动官方登录命令的完整脚本：先导出与 ACP 运行时相同的
 * durable HOME（否则登录成功 agent 进程也看不到），再执行登录命令。
 */
export function acpManualSetupBootScript(profileId: string): {
  commandLine: string;
  initialInput?: string;
  display: string;
} {
  const setup = acpManualSetupCommand(profileId);
  const env = acpManualSetupEnvironment(normalizeAcpProfileId(profileId));
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${shellEnvQuote(v)}`)
    .join(" ");
  const line = `${exports}; clear; echo "· ${setup.display} ·"; ${setup.command.join(" ")}`;
  return { commandLine: line, initialInput: setup.initialInput, display: setup.display };
}

function shellEnvQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Official login/config entry for the CLI version pinned in the workspace image. */
export function acpManualSetupCommand(profileId: string): AcpManualSetupCommand {
  switch (normalizeAcpProfileId(profileId)) {
    case "grok":
      return { command: ["grok"], display: "grok" };
    case "copilot":
      return { command: ["copilot"], initialInput: "/login\n", display: "copilot → /login" };
    case "kimi-code":
      return { command: ["kimi"], initialInput: "/login\n", display: "kimi → /login" };
    case "pi":
      return { command: ["pi"], display: "pi（在交互界面完成登录/配置）" };
    case "opencode":
      return { command: ["opencode", "auth", "login"], display: "opencode auth login" };
    case "fx":
      return { command: ["fx", "login"], display: "fx login" };
    case "kiro":
      // Device-code flow: prints a URL + code, then polls. Nothing to paste back.
      return { command: ["kiro-cli", "login"], display: "kiro-cli login" };
    case "codex":
      return { command: ["codex", "login", "--device-auth"], display: "codex login --device-auth" };
    case "gemini-cli":
      return { command: ["gemini"], display: "gemini" };
    case "hermes":
      return { command: ["hermes"], display: "hermes" };
    case "claude-code":
      return { command: ["claude-agent-acp", "--help"], display: "claude-agent-acp --help" };
    default:
      return { command: ["bash", "-l"], display: "bash -l" };
  }
}

export type AcpAgentSetup = {
  id: string;
  enabled: boolean;
  setupMode: AcpSetupMode;
  displayName?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  managed: Record<string, string>;
  /** 模型来源：第三方自身配置，或由 Zakura Gateway 暴露的租户路由。 */
  modelProvider?: "native" | "zakura";
};

export type AcpAgentConfig = {
  permissionPolicy: AcpPermissionPolicy;
  /** 用户选「始终允许」后按 tool kind + 路径前缀记住 */
  permissionGrants: AcpPermissionGrant[];
  /** 新对话默认执行方：zakura 或已启用的 ACP profile id */
  defaultRuntime: string;
  agents: Record<string, AcpAgentSetup>;
};

export type AcpPermissionGrant = {
  kind: string;
  pathPrefix?: string;
};

export type AcpRuntimeState = "starting" | "idle" | "active" | "closed";

export type AcpOptionInfo = {
  id: string;
  name: string;
};

export type AcpRuntimeStatus = {
  runtimeId: string;
  sessionId?: string;
  profileId: string;
  state: AcpRuntimeState;
  acpSessionId?: string;
  cwd?: string;
  models?: {
    currentId?: string;
    defaultId?: string;
    available: AcpOptionInfo[];
    configId?: string;
  };
  reasoning?: {
    current?: string;
    available: AcpOptionInfo[];
    configId?: string;
  };
  modes?: {
    currentId?: string;
    available: AcpOptionInfo[];
  };
  availableCommands?: Array<{ name: string; description?: string }>;
  authMethods?: Array<{ id: string; name: string; description?: string }>;
  authRequired?: boolean;
  /** 后台启动失败时的可读原因；state 一般为 closed */
  error?: string;
};

export type AcpPermissionOption = {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
};

export function normalizeAcpProfileId(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidAcpProfileId(id: string): boolean {
  return ACP_PROFILE_ID_RE.test(id);
}

export function isBuiltinAcpProfileId(id: string): boolean {
  return (ACP_BUILTIN_PROFILE_IDS as readonly string[]).includes(id);
}

export function builtinAcpProfiles(): AcpPublicProfile[] {
  return [
    {
      id: "claude-code",
      displayName: "Claude Code",
      description: "Anthropic Claude Code，经官方 ACP 适配器接入",
      managed: true,
      command: "claude-agent-acp",
      args: [],
      setupModes: ["api_key", "oauth", "self"],
      sessionModeId: "default",
      supportsZakuraRoute: false,
      managedFields: [
        {
          id: "api_key",
          label: "Anthropic API key",
          type: "password",
          required: true,
          sensitive: true,
          placeholder: "sk-ant-…",
          help: "API key 模式下写入 ANTHROPIC_API_KEY。self 模式则使用容器内已有登录。",
        },
        {
          id: "oauth_token",
          label: "Claude setup-token",
          type: "password",
          sensitive: true,
          placeholder: "粘贴 claude setup-token 输出",
          help: "OAuth 模式注入 CLAUDE_CODE_OAUTH_TOKEN。订阅 token 给 Agent SDK 可能被 Anthropic 拒绝，失败请改用 API key。",
        },
        {
          id: "base_url",
          label: "Anthropic base URL",
          type: "url",
          placeholder: "https://api.anthropic.com",
        },
        {
          id: "model",
          label: "默认模型",
          type: "text",
          placeholder: "claude-sonnet-4-5",
          help: "在创建 ACP 会话前写入 Agent 配置；若 Agent 同时提供协议模型列表，聊天框仍可切换。",
        },
      ],
    },
    {
      id: "codex",
      displayName: "Codex",
      description: "OpenAI Codex CLI，经官方 ACP 适配器接入",
      managed: true,
      command: "codex-acp",
      args: [],
      setupModes: ["api_key", "oauth", "self"],
      supportsZakuraRoute: true,
      managedFields: [
        {
          id: "api_key",
          label: "OpenAI API key",
          type: "password",
          required: true,
          sensitive: true,
          placeholder: "sk-…",
          help: "API key 模式下写入 OPENAI_API_KEY。OAuth 可用设置页设备码，或聊天里协议登录。",
        },
        {
          id: "base_url",
          label: "OpenAI base URL",
          type: "url",
          placeholder: "https://api.openai.com/v1",
        },
        {
          id: "model",
          label: "默认模型",
          type: "text",
          placeholder: "gpt-5.2-codex",
          help: "写入 CODEX_HOME/config.toml 的 model；Codex 不读取 OPENAI_MODEL 环境变量。",
        },
      ],
    },
    {
      id: "gemini-cli",
      displayName: "Gemini CLI",
      description: "Google Gemini CLI 的内置 ACP 入口",
      managed: true,
      command: "gemini",
      args: ["--acp"],
      setupModes: ["api_key", "oauth", "self"],
      supportsZakuraRoute: false,
      managedFields: [
        {
          id: "api_key",
          label: "Gemini API key",
          type: "password",
          required: true,
          sensitive: true,
          placeholder: "AIza…",
          help: "API key 模式下写入 GEMINI_API_KEY 或 GOOGLE_API_KEY。OAuth 走 ACP authenticate。",
        },
        {
          id: "model",
          label: "默认模型",
          type: "text",
          placeholder: "gemini-2.5-pro",
          help: "写入 GEMINI_MODEL，作为会话默认模型。之后仍可通过 ACP 协议切换。",
        },
      ],
    },
    {
      id: "hermes",
      displayName: "Hermes",
      description: "Nous Research Hermes Agent（ACP）",
      managed: true,
      command: "hermes-acp",
      args: [],
      setupModes: ["api_key", "self"],
      supportsZakuraRoute: true,
      managedFields: [
        {
          id: "provider",
          label: "Provider",
          type: "text",
          required: true,
          placeholder: "openai",
          help: "写入 durable .env 的 LLM_PROVIDER。",
        },
        {
          id: "model",
          label: "Model",
          type: "text",
          required: true,
          placeholder: "gpt-4.1",
        },
        {
          id: "api_key",
          label: "API key",
          type: "password",
          required: true,
          sensitive: true,
        },
        {
          id: "base_url",
          label: "Base URL",
          type: "url",
          placeholder: "https://api.openai.com/v1",
        },
      ],
    },
    {
      id: "grok",
      displayName: "Grok Build",
      description: "xAI Grok Build，支持 xAI API key 或 Agent 自身登录",
      managed: true,
      command: "grok",
      args: ["agent", "stdio"],
      setupModes: ["api_key", "oauth", "self"],
      supportsZakuraRoute: true,
      managedFields: [
        {
          id: "api_key",
          label: "xAI API key",
          type: "password",
          required: true,
          sensitive: true,
          placeholder: "xai-…",
          help: "写入 XAI_API_KEY/GROK_API_KEY；使用 API key 模式时不会触发交互登录。",
        },
        {
          id: "model",
          label: "默认模型",
          type: "text",
          placeholder: "grok-4-1-fast-reasoning",
        },
        {
          id: "base_url",
          label: "xAI base URL",
          type: "url",
          placeholder: "https://api.x.ai/v1",
        },
      ],
    },
    {
      id: "copilot",
      displayName: "GitHub Copilot",
      description: "GitHub Copilot CLI 原生 ACP（官方 Registry 入口 copilot --acp）",
      managed: true,
      command: "copilot",
      args: ["--acp"],
      setupModes: ["api_key", "oauth", "self"],
      supportsZakuraRoute: false,
      managedFields: [
        {
          id: "api_key",
          label: "GitHub PAT",
          type: "password",
          required: true,
          sensitive: true,
          placeholder: "ghp_...",
          help: "官方文档要求 fine-grained PAT 含 Copilot Requests 权限，并通过 GH_TOKEN 或 GITHUB_TOKEN 注入。",
        },
      ],
    },
    {
      id: "kimi-code",
      displayName: "Kimi Code",
      description: "Moonshot Kimi Code CLI 原生 ACP（官方入口 kimi acp）",
      managed: true,
      command: "kimi",
      args: ["acp"],
      setupModes: ["api_key", "oauth", "self"],
      supportsZakuraRoute: true,
      managedFields: [
        {
          id: "api_key",
          label: "Moonshot Kimi API key",
          type: "password",
          required: true,
          sensitive: true,
          placeholder: "sk-...",
          help: "API key 模式下写入 KIMI_API_KEY。",
        },
        {
          id: "model",
          label: "默认模型",
          type: "text",
          placeholder: "kimi-k2.5",
        },
        {
          id: "base_url",
          label: "Moonshot / OpenAI 兼容 Base URL",
          type: "url",
        },
      ],
    },
    {
      id: "pi",
      displayName: "Pi Coding Agent",
      description: "Pi coding agent，经社区 pi-acp MVP 适配器接入",
      managed: true,
      command: "pi-acp",
      args: [],
      setupModes: ["api_key", "oauth", "self"],
      supportsZakuraRoute: true,
      managedFields: [
        {
          id: "provider",
          label: "Provider",
          type: "text",
          required: true,
          placeholder: "openai",
          help: "写入 LLM_PROVIDER。",
        },
        {
          id: "model",
          label: "Model",
          type: "text",
          required: true,
          placeholder: "gpt-4o",
        },
        {
          id: "api_key",
          label: "API key",
          type: "password",
          required: true,
          sensitive: true,
        },
        {
          id: "base_url",
          label: "OpenAI 兼容 Base URL",
          type: "url",
          placeholder: "https://api.openai.com/v1",
        },
      ],
    },
        {
          id: "opencode",
          displayName: "OpenCode",
          description: "OpenCode 原生 ACP（ACP 官方 Registry 入口 opencode acp）",
          managed: true,
          command: "opencode",
          args: ["acp"],
          setupModes: ["api_key", "oauth", "self"],
          supportsZakuraRoute: true,
          managedFields: [
            {
              id: "api_key",
              label: "API key",
              type: "password",
              required: true,
              sensitive: true,
              help: "OpenCode 通过生成的 opencode.json 接入该 key；sk-ant- 前缀走 Anthropic 协议，其余走 OpenAI 兼容协议。",
            },
            {
              id: "base_url",
              label: "OpenAI 兼容 Base URL",
              type: "url",
              placeholder: "https://api.openai.com/v1",
              help: "留空时按 key 前缀使用内置 Anthropic/OpenAI 供应商；填写后会生成自定义 provider 配置。",
            },
            {
              id: "model",
              label: "模型",
              type: "text",
              required: true,
              placeholder: "kimi-k2.5 / gpt-5.2 / claude-sonnet-4-5",
              help: "OpenCode 需要显式默认模型才能启动；Zakura 路由下可留空（自动取网关模型列表）。",
            },
          ],
        },
        {
          id: "kiro",
          displayName: "Kiro CLI",
          description: "AWS Kiro CLI（kiro-cli acp）— 支持 AGENTS.md、Skills 与 MCP",
          managed: true,
          command: "kiro-cli",
          args: ["acp"],
          // Kiro 只支持自身的设备码登录，没有可注入的 API key，
          // 也就无法走 Zakura 网关路由（模型由 Kiro 侧决定）。
          setupModes: ["self"],
          supportsZakuraRoute: false,
          managedFields: [],
        },
        {
          id: "fx",
          displayName: "fx",
          description: "Vercel fx — 轻量原生编码 Agent（fx acp）",
          managed: true,
          // 唯一随镜像出厂的适配器（见 docker/workspace/Dockerfile 的 full 阶段）。
          // lite/shell 镜像不含 fx，届时照常按需 provision——所以启动路径不读这个
          // 字段，它只用于「是否需要走安装流程」的判断与 UI 文案。
          preinstalled: true,
          command: "fx",
          args: ["acp"],
          setupModes: ["api_key", "oauth", "self"],
          supportsZakuraRoute: true,
          managedFields: [
            {
              id: "api_key",
              label: "AI Gateway API key",
              type: "password",
              required: true,
              sensitive: true,
              placeholder: "vck_…",
              help: "写入 AI_GATEWAY_API_KEY。fx 通过 Vercel AI Gateway 路由到各家模型。",
            },
            {
              id: "base_url",
              label: "Gateway Base URL",
              type: "url",
              placeholder: "https://ai-gateway.vercel.sh/v1",
              help: "留空时使用 fx 默认 Gateway 端点。",
            },
            {
              id: "model",
              label: "默认模型",
              type: "text",
              placeholder: "zai/glm-5.2-fast",
              help: "写入 FX_MODEL，作为会话默认模型。",
            },
          ],
        },
        // ── Registry-provisioned agents (on-demand install) ──────────────
        {
          id: "auggie",
          displayName: "Auggie CLI",
          description: "Augment Code CLI（npx 分发，按需安装）",
          managed: true,
          command: "auggie",
          args: [],
          setupModes: ["api_key", "self"],
          supportsZakuraRoute: false,
          managedFields: [
            { id: "api_key", label: "API key", type: "password", required: true, sensitive: true },
          ],
        },
        {
          id: "cline",
          displayName: "Cline",
          description: "Cline CLI（npx 分发，按需安装）",
          managed: true,
          command: "cline",
          args: [],
          setupModes: ["api_key", "self"],
          supportsZakuraRoute: true,
          managedFields: [
            { id: "api_key", label: "API key", type: "password", required: true, sensitive: true },
            { id: "base_url", label: "Base URL", type: "url" },
            { id: "model", label: "默认模型", type: "text" },
          ],
        },
        {
          id: "cursor",
          displayName: "Cursor",
          description: "Cursor Agent CLI（binary 分发，按需安装）",
          managed: true,
          command: "cursor",
          args: [],
          setupModes: ["self"],
          supportsZakuraRoute: false,
          managedFields: [],
        },
        {
          id: "devin",
          displayName: "Devin",
          description: "Cognition Devin CLI（binary 分发，按需安装）",
          managed: true,
          command: "devin",
          args: [],
          setupModes: ["api_key", "self"],
          supportsZakuraRoute: false,
          managedFields: [
            { id: "api_key", label: "Devin API key", type: "password", required: true, sensitive: true },
          ],
        },
        {
          id: "factory-droid",
          displayName: "Factory Droid",
          description: "Factory AI Droid CLI（npx 分发，按需安装）",
          managed: true,
          command: "factory-droid",
          args: [],
          setupModes: ["api_key", "self"],
          supportsZakuraRoute: false,
          managedFields: [
            { id: "api_key", label: "Factory API key", type: "password", required: true, sensitive: true },
          ],
        },
        {
          id: "goose",
          displayName: "Goose",
          description: "Block Goose Agent CLI（binary 分发，按需安装）",
          managed: true,
          command: "goose",
          args: [],
          setupModes: ["api_key", "self"],
          supportsZakuraRoute: true,
          managedFields: [
            { id: "api_key", label: "API key", type: "password", required: true, sensitive: true },
            { id: "base_url", label: "Base URL", type: "url" },
            { id: "model", label: "默认模型", type: "text" },
          ],
        },
        {
          id: "junie",
          displayName: "Junie",
          description: "JetBrains Junie Agent CLI（binary 分发，按需安装）",
          managed: true,
          command: "junie",
          args: [],
          setupModes: ["self"],
          supportsZakuraRoute: false,
          managedFields: [],
        },
        {
          id: "qwen-code",
          displayName: "Qwen Code",
          description: "Alibaba Qwen Code Agent（npx 分发，按需安装）",
          managed: true,
          command: "qwen-code",
          args: ["--acp"],
          setupModes: ["api_key", "self"],
          supportsZakuraRoute: true,
          managedFields: [
            { id: "api_key", label: "DashScope API key", type: "password", required: true, sensitive: true, placeholder: "sk-..." },
            { id: "model", label: "默认模型", type: "text", placeholder: "qwen3-coder" },
          ],
        },
        {
          id: "mistral-vibe",
          displayName: "Mistral Vibe",
          description: "Mistral AI Vibe Agent（binary 分发，按需安装）",
          managed: true,
          command: "mistral-vibe",
          args: [],
          setupModes: ["api_key", "self"],
          supportsZakuraRoute: false,
          managedFields: [
            { id: "api_key", label: "Mistral API key", type: "password", required: true, sensitive: true },
            { id: "model", label: "默认模型", type: "text", placeholder: "mistral-medium-3" },
          ],
        },
        {
          id: "nova",
          displayName: "Nova",
          description: "Amazon Nova Agent CLI（npx 分发，按需安装）",
          managed: true,
          command: "nova",
          args: [],
          setupModes: ["api_key", "self"],
          supportsZakuraRoute: false,
          managedFields: [
            { id: "api_key", label: "AWS Access Key / API key", type: "password", required: true, sensitive: true },
          ],
        },
        {
          id: "dirac",
          displayName: "Dirac",
          description: "Dirac CLI Agent（npx 分发，按需安装）",
          managed: true,
          command: "dirac",
          args: [],
          setupModes: ["api_key", "self"],
          supportsZakuraRoute: true,
          managedFields: [
            { id: "api_key", label: "API key", type: "password", required: true, sensitive: true },
            { id: "base_url", label: "Base URL", type: "url" },
            { id: "model", label: "默认模型", type: "text" },
          ],
        },
        {
          id: "codebuddy",
          displayName: "Codebuddy Code",
          description: "Codebuddy Code Agent（npx 分发，按需安装）",
          managed: true,
          command: "codebuddy-code",
          args: [],
          setupModes: ["api_key", "self"],
          supportsZakuraRoute: false,
          managedFields: [
            { id: "api_key", label: "API key", type: "password", required: true, sensitive: true },
          ],
        },
        {
          id: "amp",
          displayName: "Amp",
          description: "Amp Agent CLI（binary 分发，按需安装）",
          managed: true,
          command: "amp",
          args: [],
          setupModes: ["api_key", "self"],
          supportsZakuraRoute: false,
          managedFields: [
            { id: "api_key", label: "Sourcegraph API key", type: "password", required: true, sensitive: true },
          ],
        },
        {
          id: "deepagents",
          displayName: "DeepAgents",
          description: "DeepAgents CLI（npx 分发，按需安装）",
          managed: true,
          command: "deepagents",
          args: [],
          setupModes: ["api_key", "self"],
          supportsZakuraRoute: true,
          managedFields: [
            { id: "api_key", label: "API key", type: "password", required: true, sensitive: true },
            { id: "base_url", label: "Base URL", type: "url" },
            { id: "model", label: "默认模型", type: "text" },
          ],
        },
        {
          id: "poolside",
          displayName: "Poolside",
          description: "Poolside Agent CLI（binary 分发，按需安装）",
          managed: true,
          command: "poolside",
          args: [],
          setupModes: ["api_key", "self"],
          supportsZakuraRoute: false,
          managedFields: [
            { id: "api_key", label: "Poolside API key", type: "password", required: true, sensitive: true },
          ],
        },
        {
          id: "sigit",
          displayName: "siGit Code",
          description: "siGit Code Agent（npx + binary 双分发，按需安装）",
          managed: true,
          command: "sigit",
          args: [],
          setupModes: ["api_key", "self"],
          supportsZakuraRoute: true,
          managedFields: [
            { id: "api_key", label: "API key", type: "password", required: true, sensitive: true },
            { id: "base_url", label: "Base URL", type: "url" },
            { id: "model", label: "默认模型", type: "text" },
          ],
        },
        {
          id: "fast-agent",
          displayName: "fast-agent",
          description: "fast-agent（uvx 分发，按需安装）",
          managed: true,
          command: "fast-agent",
          args: [],
          setupModes: ["api_key", "self"],
          supportsZakuraRoute: true,
          managedFields: [
            { id: "api_key", label: "API key", type: "password", required: true, sensitive: true },
            { id: "base_url", label: "Base URL", type: "url" },
            { id: "model", label: "默认模型", type: "text" },
          ],
        },
  ];
}

export function lookupBuiltinAcpProfile(id: string): AcpPublicProfile | null {
  const normalized = normalizeAcpProfileId(id);
  return builtinAcpProfiles().find((p) => p.id === normalized) ?? null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asStringMap(v: unknown): Record<string, string> {
  const rec = asRecord(v);
  if (!rec) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(rec)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

export function parseAcpSetupMode(raw: unknown): AcpSetupMode {
  return raw === "self" || raw === "oauth" ? raw : "api_key";
}

export function parseAcpDefaultRuntime(raw: unknown): string {
  if (typeof raw !== "string") return ZAKURA_RUNTIME_ID;
  const id = raw.trim().toLowerCase();
  if (id === ZAKURA_RUNTIME_ID) return id;
  return isValidAcpProfileId(id) ? id : ZAKURA_RUNTIME_ID;
}

/** 一条时间线只属于一个执行方：空会话可改绑，有用户消息则开新对话。 */
export function conversationRuntimeSwitch(input: {
  currentRuntimeId: string;
  nextRuntimeId: string;
  hasUserMessage: boolean;
}): "noop" | "rebind" | "new_session" {
  if (input.currentRuntimeId === input.nextRuntimeId) return "noop";
  return input.hasUserMessage ? "new_session" : "rebind";
}

export function parseAcpPermissionPolicy(raw: unknown): AcpPermissionPolicy {
  return raw === "allow" ? "allow" : "ask";
}

export function parseAcpAgentSetup(id: string, raw: unknown): AcpAgentSetup {
  const rec = asRecord(raw) ?? {};
  const managed = asStringMap(rec.managed);
  const args = Array.isArray(rec.args)
    ? rec.args.filter((a): a is string => typeof a === "string").slice(0, 32)
    : undefined;
  const env = rec.env ? asStringMap(rec.env) : undefined;
  const command = typeof rec.command === "string" ? rec.command.trim() : "";
  const displayName = typeof rec.displayName === "string" ? rec.displayName.trim() : "";
  return {
    id: normalizeAcpProfileId(id),
    enabled: rec.enabled === true,
    setupMode: parseAcpSetupMode(rec.setupMode),
    ...(displayName ? { displayName } : {}),
    ...(command ? { command } : {}),
    ...(args?.length ? { args } : {}),
    ...(env && Object.keys(env).length ? { env } : {}),
    managed,
    // Older ACP settings persisted only the zakura_* fields without
    // modelProvider; infer the route so those profiles do not silently launch
    // without Authorization.  An explicit choice always wins — otherwise
    // switching back to native is impossible while old zakura_* credentials
    // linger in managed.
    modelProvider:
      rec.modelProvider === "zakura"
        ? "zakura"
        : rec.modelProvider === "native"
          ? "native"
          : Boolean(managed.zakura_api_key?.trim() || managed.zakura_base_url?.trim())
            ? "zakura"
            : "native",
  };
}

export function parseAcpAgentConfig(raw: unknown): AcpAgentConfig {
  const root = asRecord(raw) ?? {};
  const acp = asRecord(root.acp) ?? (root.agents ? root : {});
  const agentsRaw = asRecord(acp.agents) ?? {};
  const agents: Record<string, AcpAgentSetup> = {};
  for (const [rawId, value] of Object.entries(agentsRaw)) {
    const id = normalizeAcpProfileId(rawId);
    if (!isValidAcpProfileId(id)) continue;
    agents[id] = parseAcpAgentSetup(id, value);
  }
  return {
    permissionPolicy: parseAcpPermissionPolicy(acp.permissionPolicy),
    permissionGrants: parseAcpPermissionGrants(acp.permissionGrants),
    defaultRuntime: parseAcpDefaultRuntime(acp.defaultRuntime),
    agents,
  };
}

export function parseAcpPermissionGrants(raw: unknown): AcpPermissionGrant[] {
  if (!Array.isArray(raw)) return [];
  const out: AcpPermissionGrant[] = [];
  for (const item of raw.slice(0, 200)) {
    const rec = asRecord(item);
    if (!rec || typeof rec.kind !== "string" || !rec.kind.trim()) continue;
    const pathPrefix =
      typeof rec.pathPrefix === "string" && rec.pathPrefix.trim()
        ? rec.pathPrefix.replace(/\\/g, "/")
        : undefined;
    out.push({ kind: rec.kind.trim(), ...(pathPrefix ? { pathPrefix } : {}) });
  }
  return out;
}

export function pathPrefixFromLocations(
  locations?: Array<{ path?: string | null }>,
): string | undefined {
  const paths = (locations ?? [])
    .map((l) => l.path)
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .map((p) => p.replace(/\\/g, "/"));
  if (!paths.length) return undefined;
  const first = paths[0]!;
  const slash = first.lastIndexOf("/");
  const dir = slash >= 0 ? first.slice(0, slash + 1) : first;
  return dir;
}

export function grantMatches(
  grant: AcpPermissionGrant,
  tool: { kind?: string | null; locations?: Array<{ path?: string | null }> },
): boolean {
  if (grant.kind && tool.kind && grant.kind !== tool.kind) return false;
  if (!grant.pathPrefix) return true;
  const paths = (tool.locations ?? [])
    .map((l) => l.path)
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .map((p) => p.replace(/\\/g, "/"));
  if (!paths.length) return true;
  const prefix = grant.pathPrefix.replace(/\/+$/, "");
  return paths.every((p) => p === prefix || p.startsWith(`${prefix}/`));
}

export function pickGrantedOptionId(
  grants: AcpPermissionGrant[],
  tool: { kind?: string | null; locations?: Array<{ path?: string | null }> },
  options: Array<{ optionId: string; kind: string }>,
): string | undefined {
  if (!grants.some((g) => grantMatches(g, tool))) return undefined;
  return (
    options.find((o) => o.kind === "allow_always") ??
    options.find((o) => o.kind === "allow_once" || o.kind.startsWith("allow"))
  )?.optionId;
}

export function upsertAcpGrant(
  grants: AcpPermissionGrant[],
  grant: AcpPermissionGrant,
): AcpPermissionGrant[] {
  const key = `${grant.kind}|${grant.pathPrefix ?? ""}`;
  if (grants.some((g) => `${g.kind}|${g.pathPrefix ?? ""}` === key)) return grants;
  return [...grants, grant].slice(-200);
}

export function isPathUnderRoots(path: string, roots: string[]): boolean {
  const p = path.replace(/\\/g, "/");
  if (!p.startsWith("/")) return false;
  return roots.some((root) => {
    const r = root.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
    return p === r || p.startsWith(`${r}/`);
  });
}

export function missingRequiredAcpField(
  profile: AcpPublicProfile,
  setup: AcpAgentSetup,
): AcpManagedField | null {
  if (setup.modelProvider === "zakura" && profile.supportsZakuraRoute) return null;
  if (setup.setupMode === "self") return null;
  if (setup.setupMode === "oauth") {
    if (profile.id === "claude-code" && !setup.managed.oauth_token?.trim()) {
      return (
        profile.managedFields.find((f) => f.id === "oauth_token") ?? {
          id: "oauth_token",
          label: "Claude setup-token",
          type: "password",
          sensitive: true,
        }
      );
    }
    return null;
  }
  for (const field of profile.managedFields) {
    if (!field.required) continue;
    if (field.id === "oauth_token") continue;
    if (!setup.managed[field.id]?.trim()) return field;
  }
  return null;
}

export function resolveAcpLaunch(
  profile: AcpPublicProfile,
  setup: AcpAgentSetup,
): { command: string; args: string[]; env: Record<string, string> } {
  // Kept as authored (usually a bare name). Resolution to an absolute path happens
  // in the container via `acpCommandResolveExpr`, which prefers ACP_IMAGE_BIN_DIR
  // over PATH — see the comment there for why PATH alone is not enough.
  const command = setup.command?.trim() || profile.command;
  let args = setup.args?.length ? setup.args : profile.args;
  const env: Record<string, string> = { ...(setup.env ?? {}) };
  const key = setup.managed.api_key?.trim();
  const baseUrl = setup.managed.base_url?.trim();
  const model = setup.managed.model?.trim();
  const oauthToken = setup.managed.oauth_token?.trim();
  if (setup.modelProvider === "zakura") {
    const zakuraKey = setup.managed.zakura_api_key?.trim();
    const zakuraBase = setup.managed.zakura_base_url?.trim();
    const zakuraModel = setup.managed.model?.trim();
    applyZakuraRouteEnv(env, profile.id, zakuraKey, zakuraBase);
    if (zakuraModel) {
      applyModelEnv(env, profile.id, zakuraModel);
      env.ZAKURA_MODEL = zakuraModel;
    }
  }
  if (setup.setupMode === "oauth" && profile.id === "claude-code" && oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  }
  if (setup.modelProvider !== "zakura" && setup.setupMode === "api_key" && key) {
    if (profile.id === "claude-code") {
      // 第三方 Anthropic 兼容端点（Kimi、镜像网关等）普遍只认 Bearer；
      // 官方 API 两种头都接受。两个变量一起铺，避免按端点猜。
      env.ANTHROPIC_API_KEY = key;
      env.ANTHROPIC_AUTH_TOKEN = key;
      if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    } else if (profile.id === "codex") {
      env.OPENAI_API_KEY = key;
      if (baseUrl) env.OPENAI_BASE_URL = baseUrl;
    } else if (profile.id === "gemini-cli") {
      env.GEMINI_API_KEY = key;
      env.GOOGLE_API_KEY = key;
    } else if (profile.id === "hermes") {
      const provider = setup.managed.provider?.trim();
      const model = setup.managed.model?.trim();
      if (provider) env.LLM_PROVIDER = provider;
      if (model) env.LLM_MODEL = model;
      env.LLM_API_KEY = key;
      env.OPENAI_API_KEY = key;
      if (baseUrl) {
        env.LLM_BASE_URL = baseUrl;
        env.OPENAI_BASE_URL = baseUrl;
      }
    } else if (profile.id === "opencode") {
      env.OPENCODE_API_KEY = key;
      if (key.startsWith("sk-ant-")) env.ANTHROPIC_API_KEY = key;
      else env.OPENAI_API_KEY = key;
      if (baseUrl) env.OPENAI_BASE_URL = baseUrl;
    } else if (profile.id === "grok") {
      env.XAI_API_KEY = key;
      env.GROK_API_KEY = key;
      env.OPENAI_API_KEY = key;
      if (baseUrl) env.XAI_BASE_URL = baseUrl;
    } else if (profile.id === "copilot") {
      env.GH_TOKEN = key;
      env.GITHUB_TOKEN = key;
    } else if (profile.id === "kimi-code") {
      env.KIMI_API_KEY = key;
      env.MOONSHOT_API_KEY = key;
      if (baseUrl) {
        env.KIMI_BASE_URL = baseUrl;
        env.KIMI_API_BASE_URL = baseUrl;
        env.MOONSHOT_BASE_URL = baseUrl;
      }
    } else if (profile.id === "pi") {
      const provider = setup.managed.provider?.trim();
      if (provider) env.LLM_PROVIDER = provider;
      env.OPENAI_API_KEY = key;
      env.PI_API_KEY = key;
      env.LLM_API_KEY = key;
      if (baseUrl) env.OPENAI_BASE_URL = baseUrl;
    } else if (profile.id === "fx") {
      env.AI_GATEWAY_API_KEY = key;
      env.OPENAI_API_KEY = key;
      if (baseUrl) {
        env.OPENAI_BASE_URL = baseUrl;
        env.AI_GATEWAY_BASE_URL = baseUrl;
      }
    } else if (profile.id === "qwen-code") {
      env.DASHSCOPE_API_KEY = key;
      if (baseUrl) env.DASHSCOPE_API_BASE = baseUrl;
    } else {
      env.API_KEY = key;
      if (baseUrl) env.API_BASE_URL = baseUrl;
    }
  }
  if (model) applyModelEnv(env, profile.id, model);
  if (profile.id === "claude-code" && model && baseUrl && setup.modelProvider !== "zakura") {
    // 第三方端点上，Claude Code 的后台/小模型调用仍走官方模型名会直接 404；
    // cc-switch 的预设同样把三个默认档位一起指到所选模型。
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  }
  if (profile.id === "grok" && model && !args.some((arg) => arg === "--model" || arg === "-m")) {
    args = [...args, "--model", model];
  }
  return { command, args, env };
}

/** Attach the OpenAI-compatible Zakura gateway using each CLI's own names. */
function applyZakuraRouteEnv(
  env: Record<string, string>,
  profileId: string,
  key: string | undefined,
  baseUrl: string | undefined,
): void {
  if (key) {
    env.ZAKURA_API_KEY = key;
    env.OPENAI_API_KEY = key;
    if (profileId === "grok") {
      env.XAI_API_KEY = key;
      env.GROK_API_KEY = key;
    } else if (profileId === "kimi-code") {
      env.KIMI_API_KEY = key;
      env.MOONSHOT_API_KEY = key;
      env.KIMI_AUTH_TOKEN = key;
      env.KIMI_CODE_API_KEY = key;
      env.OPENAI_API_KEY = key;
      env.LLM_API_KEY = key;
    } else if (profileId === "hermes") {
      env.LLM_PROVIDER = "openai";
      env.LLM_API_KEY = key;
      env.HERMES_API_KEY = key;
      env.OPENAI_API_TOKEN = key;
      env.API_KEY = key;
    } else if (profileId === "pi") {
      env.LLM_PROVIDER = "openai";
      env.PI_API_KEY = key;
      env.LLM_API_KEY = key;
    } else if (profileId === "opencode") {
      env.OPENCODE_API_KEY = key;
    } else if (profileId === "fx") {
      env.AI_GATEWAY_API_KEY = key;
      env.OPENAI_API_KEY = key;
    }
  }
  if (!baseUrl) return;
  env.ZAKURA_BASE_URL = baseUrl;
  env.OPENAI_BASE_URL = baseUrl;
  if (profileId === "grok") {
    env.XAI_BASE_URL = baseUrl;
    env.XAI_API_BASE_URL = baseUrl;
  }
  else if (profileId === "kimi-code") {
    env.KIMI_BASE_URL = baseUrl;
    env.KIMI_API_BASE_URL = baseUrl;
    env.KIMI_CODE_BASE_URL = baseUrl;
    env.MOONSHOT_API_BASE_URL = baseUrl;
    env.MOONSHOT_BASE_URL = baseUrl;
    env.API_BASE_URL = baseUrl;
  }
  else if (profileId === "hermes") {
    env.LLM_BASE_URL = baseUrl;
    env.OPENAI_API_BASE = baseUrl;
    env.OPENAI_API_BASE_URL = baseUrl;
    env.LLM_API_BASE = baseUrl;
    env.LLM_API_BASE_URL = baseUrl;
    env.HERMES_BASE_URL = baseUrl;
  }
  else if (profileId === "fx") {
    env.AI_GATEWAY_BASE_URL = baseUrl;
  }
}

export function supportsAcpZakuraRoute(profile: AcpPublicProfile): boolean {
  return profile.supportsZakuraRoute === true;
}

/**
 * ACP agents do not agree on one model variable.  Keep the public setting
 * profile-scoped, but export the variables each bundled adapter actually
 * reads.  Generic aliases are intentionally retained for custom wrappers.
 */
function applyModelEnv(env: Record<string, string>, profileId: string, model: string): void {
  env.LLM_MODEL = model;
  if (profileId === "claude-code") {
    env.ANTHROPIC_MODEL = model;
  } else if (profileId === "gemini-cli") {
    env.GEMINI_MODEL = model;
  } else if (profileId === "grok") {
    env.XAI_MODEL = model;
    env.GROK_MODEL = model;
    env.OPENAI_MODEL = model;
  } else if (profileId === "kimi-code") {
    env.KIMI_MODEL = model;
    env.MOONSHOT_MODEL = model;
    env.OPENAI_MODEL = model;
  } else if (profileId === "hermes") {
    env.HERMES_MODEL = model;
    env.OPENAI_MODEL = model;
  } else {
    env.OPENAI_MODEL = model;
  }
  if (profileId === "fx") {
    env.FX_MODEL = model;
  }
}

export function publicProfileForSetup(
  setup: AcpAgentSetup,
  managedProfile = lookupBuiltinAcpProfile(setup.id),
): AcpPublicProfile {
  if (managedProfile) {
    return {
      ...managedProfile,
      command: setup.command?.trim() || managedProfile.command,
      args: setup.args?.length ? setup.args : managedProfile.args,
    };
  }
  return {
    id: setup.id,
    displayName: setup.displayName || setup.id,
    description: "自定义 ACP Agent",
    managed: false,
    command: setup.command?.trim() || "",
    args: setup.args ?? [],
    setupModes: ["api_key", "oauth", "self"],
    managedFields: [
      {
        id: "api_key",
        label: "API key",
        type: "password",
        sensitive: true,
      },
    ],
  };
}

export function listEnabledAcpSetups(config: AcpAgentConfig): AcpAgentSetup[] {
  return Object.values(config.agents).filter((a) => a.enabled);
}

const MASK_PREFIX = "***";

export function maskAcpSecret(value: string): string {
  const v = value.trim();
  if (!v) return "";
  if (v.startsWith("sk-") && v.length > 8) return `sk-…${v.slice(-4)}`;
  if (v.length > 4) return `${MASK_PREFIX}${v.slice(-4)}`;
  return MASK_PREFIX;
}

export function isMaskedAcpSecret(value: unknown): boolean {
  return typeof value === "string" && (value.startsWith(MASK_PREFIX) || /^\s*sk-…/.test(value));
}

function sensitiveFieldIds(profile: AcpPublicProfile): Set<string> {
  const ids = new Set<string>();
  for (const field of profile.managedFields) {
    if (field.sensitive || field.type === "password") ids.add(field.id);
  }
  return ids;
}

function looksSensitiveKey(key: string): boolean {
  return /key|token|secret|password|auth/i.test(key);
}

export function scrubAcpConfigForResponse(config: AcpAgentConfig): AcpAgentConfig {
  const agents: Record<string, AcpAgentSetup> = {};
  for (const [id, setup] of Object.entries(config.agents)) {
    const profile = publicProfileForSetup(setup);
    const sensitive = sensitiveFieldIds(profile);
    const managed: Record<string, string> = {};
    for (const [key, value] of Object.entries(setup.managed)) {
      managed[key] =
        sensitive.has(key) || looksSensitiveKey(key) ? maskAcpSecret(value) : value;
    }
    agents[id] = { ...setup, managed };
  }
  return {
    permissionPolicy: config.permissionPolicy,
    permissionGrants: config.permissionGrants,
    defaultRuntime: config.defaultRuntime,
    agents,
  };
}

export function mergeAcpConfigUpdate(
  existing: AcpAgentConfig,
  incoming: AcpAgentConfig,
): AcpAgentConfig {
  const agents: Record<string, AcpAgentSetup> = {};
  for (const [id, next] of Object.entries(incoming.agents)) {
    const prev = existing.agents[id];
    const profile = publicProfileForSetup(next);
    const sensitive = sensitiveFieldIds(profile);
    const managed: Record<string, string> = { ...next.managed };
    if (prev) {
      for (const [key, prevVal] of Object.entries(prev.managed)) {
        if (!sensitive.has(key) && !looksSensitiveKey(key)) continue;
        const incomingVal = next.managed[key];
        if (
          incomingVal === undefined ||
          incomingVal === "" ||
          isMaskedAcpSecret(incomingVal)
        ) {
          managed[key] = prevVal;
        }
      }
    }
    agents[id] = { ...next, managed };
  }
  return {
    permissionPolicy: incoming.permissionPolicy,
    permissionGrants: incoming.permissionGrants,
    defaultRuntime: incoming.defaultRuntime || existing.defaultRuntime || ZAKURA_RUNTIME_ID,
    agents,
  };
}

export function flattenAcpSelectOptions(raw: unknown): AcpOptionInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: AcpOptionInfo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id =
      typeof o.value === "string"
        ? o.value
        : typeof o.modelId === "string"
          ? o.modelId
          : undefined;
    if (id) {
      const name =
        (typeof o.name === "string" && o.name.trim()) ||
        (typeof o.title === "string" && o.title.trim()) ||
        id;
      out.push({ id, name });
    } else if (Array.isArray(o.options)) {
      out.push(...flattenAcpSelectOptions(o.options));
    }
  }
  return out;
}

function isAcpModelOption(id: string, category: string, name = ""): boolean {
  if (category === "model") return true;
  if (category === "mode" || category === "thought_level" || category === "model_config") return false;
  const n = id.toLowerCase();
  if (n === "model" || n.endsWith("-model") || n.endsWith("_model") || n.endsWith(".model")) return true;
  return name.trim().toLowerCase() === "model";
}

function isAcpThoughtOption(id: string, category: string): boolean {
  if (category === "thought_level") return true;
  return /thought|reason/.test(id.toLowerCase());
}

/** 从 session/new 或 config_option_update 抽出模型 / 思考强度。 */
export function parseAcpConfigOptions(raw: unknown): {
  models?: NonNullable<AcpRuntimeStatus["models"]>;
  reasoning?: NonNullable<AcpRuntimeStatus["reasoning"]>;
} {
  if (!Array.isArray(raw)) return {};
  let models: NonNullable<AcpRuntimeStatus["models"]> | undefined;
  let reasoning: NonNullable<AcpRuntimeStatus["reasoning"]> | undefined;
  let fallback: NonNullable<AcpRuntimeStatus["models"]> | undefined;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id.trim()) continue;
    if (o.type && o.type !== "select") continue;
    const available = flattenAcpSelectOptions(o.options);
    if (available.length === 0) continue;
    const current =
      (typeof o.currentValue === "string" && o.currentValue) ||
      (typeof o.current_value === "string" && o.current_value) ||
      available[0]?.id;
    const category = typeof o.category === "string" ? o.category : "";
    const label = typeof o.name === "string" ? o.name : "";
    if (isAcpModelOption(o.id, category, label)) {
      models = { currentId: current, available, configId: o.id };
    } else if (isAcpThoughtOption(o.id, category)) {
      reasoning = { current, available, configId: o.id };
    } else if (
      !fallback &&
      category !== "mode" &&
      !/mode|thought|reason/i.test(`${o.id} ${label}`)
    ) {
      fallback = { currentId: current, available, configId: o.id };
    }
  }
  if (!models && fallback) models = fallback;
  return { ...(models ? { models } : {}), ...(reasoning ? { reasoning } : {}) };
}

/** Gemini CLI 等在 session/new 里用 models.availableModels，而不是 configOptions。 */
export const ACP_UNSTABLE_MODEL_CONFIG_ID = "_unstable_model";

export function parseAcpModelsBlock(raw: unknown): NonNullable<AcpRuntimeStatus["models"]> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(o.availableModels)
    ? o.availableModels
    : Array.isArray(o.available)
      ? o.available
      : Array.isArray(raw)
        ? raw
        : null;
  if (!list) return undefined;
  const available = flattenAcpSelectOptions(list);
  if (available.length === 0) return undefined;
  const current =
    (typeof o.currentModelId === "string" && o.currentModelId) ||
    (typeof o.currentId === "string" && o.currentId) ||
    (typeof o.current === "string" && o.current) ||
    available[0]?.id;
  return { currentId: current, available, configId: ACP_UNSTABLE_MODEL_CONFIG_ID };
}

/** 从 session/new、session/load 或 config_option_update 抽出模型 / 思考强度。 */
export function parseAcpSessionModelState(raw: unknown): {
  models?: NonNullable<AcpRuntimeStatus["models"]>;
  reasoning?: NonNullable<AcpRuntimeStatus["reasoning"]>;
} {
  if (Array.isArray(raw)) return parseAcpConfigOptions(raw);
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const fromConfig = parseAcpConfigOptions(o.configOptions ?? o.config_options);
  const fromModels = parseAcpModelsBlock(o.models);
  return {
    ...(fromConfig.models || fromModels ? { models: fromConfig.models ?? fromModels } : {}),
    ...(fromConfig.reasoning ? { reasoning: fromConfig.reasoning } : {}),
  };
}

export function acpConfigToJson(config: AcpAgentConfig): Record<string, unknown> {
  const agents: Record<string, unknown> = {};
  for (const [id, setup] of Object.entries(config.agents)) {
    const row: Record<string, unknown> = {
      enabled: setup.enabled,
      setupMode: setup.setupMode,
      managed: setup.managed,
      // 显式持久化两个值：省略 native 会让解析端落回 zakura_* 推断，
      // 导致「切回 Agent 自身」在下次读取时被复活。
      modelProvider: setup.modelProvider ?? "native",
    };
    if (setup.displayName) row.displayName = setup.displayName;
    if (setup.command) row.command = setup.command;
    if (setup.args?.length) row.args = setup.args;
    if (setup.env && Object.keys(setup.env).length) row.env = setup.env;
    agents[id] = row;
  }
  return {
    permissionPolicy: config.permissionPolicy,
    defaultRuntime: config.defaultRuntime,
    ...(config.permissionGrants.length ? { permissionGrants: config.permissionGrants } : {}),
    agents,
  };
}
