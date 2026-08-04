/**
 * 统一 MCP 配置：精选目录 + 商店/导入翻译辅助。
 * 核心类型定义在 @zakura/shared，此处提供平台内目录与转换器。
 */

import {
  CURATED_MCP_GROUPS,
  CURATED_OAUTH_MCPS,
  DEFAULT_AGENT_AUTO_INSTALL_MCPS,
  MCP_OAUTH_TIER_META,
  pickPreferredInstallPreview,
  type McpAuthMode,
  type McpEnvHint,
  type StoreInstallPreview,
  type StoreServerLike,
  type UnifiedMcpConfig,
} from "@zakura/shared";

export type {
  McpAuthMode,
  McpEnvHint,
  McpInstallKind,
  McpPackageManager,
  McpToolPermissionRule,
  McpToolPermissionState,
  StoreInstallPreview,
  StoreServerLike,
  UnifiedMcpConfig,
} from "@zakura/shared";

export {
  CURATED_MCP_GROUPS,
  CURATED_OAUTH_MCPS,
  DEFAULT_AGENT_AUTO_INSTALL_MCPS,
  pickPreferredInstallPreview,
  rankInstallPreview,
} from "@zakura/shared";
export function oauthTierBadge(config: UnifiedMcpConfig): {
  label: string;
  variant: "default" | "secondary" | "outline";
} {
  const tier = config.oauth?.tier;
  if (!tier) {
    return {
      label: config.auth === "oauth" ? "OAuth" : authLabel(config.auth),
      variant: "outline",
    };
  }
  return {
    label: MCP_OAUTH_TIER_META[tier].short,
    variant: tier === "A" ? "default" : tier === "B" ? "secondary" : "outline",
  };
}

export function setupRequirementBadge(config: UnifiedMcpConfig): {
  label: string;
  variant: "default" | "secondary" | "outline";
} {
  if (config.auth === "none") return { label: "无需配置", variant: "outline" };
  if (config.oauth?.tier === "C") return { label: "需自备凭证", variant: "outline" };
  if (config.oauth?.tier === "B") return { label: "需预注册 App", variant: "secondary" };
  if (config.auth === "oauth") return { label: "安装后授权", variant: "default" };
  return { label: "需 API Key", variant: "secondary" };
}

export function slugifyMcpName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || `mcp-${Date.now().toString(36)}`
  );
}

export function kindLabel(kind: UnifiedMcpConfig["kind"]): string {
  return kind === "http" ? "HTTP" : "Stdio";
}

export function packageManagerLabel(
  pm: UnifiedMcpConfig["packageManager"],
): string {
  switch (pm) {
    case "npm":
      return "npm";
    case "pypi":
      return "PyPI / uvx";
    case "oci":
      return "OCI / Docker";
    case "binary":
      return "Binary";
    default:
      return "Stdio";
  }
}

export function authLabel(auth: McpAuthMode): string {
  switch (auth) {
    case "oauth":
      return "OAuth";
    case "apiKey":
      return "API Key";
    default:
      return "无鉴权";
  }
}

/** 从 preview summary 解析 command/args（仅用于展示；商店安装仍走 storeMeta） */
function parseStdioSummary(summary: string, kind: StoreInstallPreview["kind"]): {
  command: string;
  args: string[];
  packageManager: NonNullable<UnifiedMcpConfig["packageManager"]>;
} {
  const parts = summary.trim().split(/\s+/).filter(Boolean);
  if (kind === "stdio-pypi") {
    return {
      command: parts[0] || "uvx",
      args: parts.slice(1),
      packageManager: "pypi",
    };
  }
  if (kind === "stdio-oci") {
    return {
      command: "docker",
      args: parts[0] === "docker" ? parts.slice(1) : parts,
      packageManager: "oci",
    };
  }
  if (kind === "stdio-npm") {
    // npx -y pkg …
    if (parts[0] === "npx") {
      return { command: "npx", args: parts.slice(1), packageManager: "npm" };
    }
    return { command: parts[0] || "npx", args: parts.slice(1), packageManager: "npm" };
  }
  return {
    command: parts[0] || "npx",
    args: parts.slice(1),
    packageManager: "binary",
  };
}

/** 商店预览 → 统一配置 */
export function fromStorePreview(
  server: StoreServerLike,
  option: StoreInstallPreview,
): UnifiedMcpConfig {
  const name = server.title || server.name.split("/").pop() || server.name;
  const base: UnifiedMcpConfig = {
    id: `store:${server.storeId}:${server.name}:${option.id}`,
    name,
    description: server.description,
    kind: option.prefer === "http" ? "http" : "stdio",
    auth: option.prefer === "http" ? "oauth" : "none",
    envHints: option.envHints,
    repositoryUrl: server.repository?.url,
    source: "store",
    storeMeta: {
      storeId: server.storeId,
      registryName: server.name,
      prefer: option.prefer,
      remoteUrl: option.remoteUrl,
      packageIndex: option.packageIndex,
      installKind: option.kind,
    },
  };

  if (option.prefer === "http") {
    return {
      ...base,
      mcpUrl: option.remoteUrl || option.summary,
      auth: "oauth",
      oauth: {
        tier: "A",
        strategies: ["dcr", "pre_registered", "byo"],
        allowPatFallback: true,
      },
    };
  }

  const parsed = parseStdioSummary(option.summary, option.kind);
  return {
    ...base,
    auth: "none",
    packageManager: parsed.packageManager,
    command: parsed.command,
    args: parsed.args,
  };
}

/** 取商店默认安装方案并翻译为统一配置 */
export function fromStoreServer(
  server: StoreServerLike,
  option?: StoreInstallPreview,
): UnifiedMcpConfig | null {
  const opt = option ?? pickPreferredInstallPreview(server.preview ?? []);
  if (!opt) return null;
  return fromStorePreview(server, opt);
}

/** 手工 URL → 统一配置 */
export function fromHttpUrl(input: {
  mcpUrl: string;
  name?: string;
  auth?: McpAuthMode;
  apiKey?: string;
  headerName?: string;
}): UnifiedMcpConfig {
  const url = input.mcpUrl.trim();
  let host = "mcp";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    /* keep default */
  }
  return {
    id: `custom:http:${slugifyMcpName(input.name || host)}`,
    name: input.name?.trim() || host,
    kind: "http",
    auth: input.auth ?? "none",
    mcpUrl: url,
    apiKey: input.apiKey,
    headerName: input.headerName ?? "Authorization",
    source: "custom",
  };
}

/** Stdio 包 → 统一配置 */
export function fromStdioPackage(input: {
  name?: string;
  packageName: string;
  packageManager: "npm" | "pypi";
  extraArgs?: string[];
  env?: Record<string, string>;
}): UnifiedMcpConfig {
  const pkg = input.packageName.trim();
  const extra = input.extraArgs ?? [];
  const command = input.packageManager === "pypi" ? "uvx" : "npx";
  const args =
    input.packageManager === "pypi" ? [pkg, ...extra] : ["-y", pkg, ...extra];
  const name =
    input.name?.trim() ||
    pkg.split("/").pop()?.replace(/^@/, "") ||
    "stdio-mcp";
  return {
    id: `custom:stdio:${slugifyMcpName(name)}`,
    name,
    kind: "stdio",
    auth: "none",
    command,
    args,
    env: input.env,
    packageManager: input.packageManager,
    source: "custom",
  };
}

/** OCI 镜像 → 统一配置 */
export function fromOciImage(input: {
  name?: string;
  image: string;
  extraArgs?: string[];
  env?: Record<string, string>;
}): UnifiedMcpConfig {
  const image = input.image.trim();
  const extra = input.extraArgs ?? [];
  const name =
    input.name?.trim() ||
    image.split("/").pop()?.split(":")[0] ||
    "oci-mcp";
  return {
    id: `custom:oci:${slugifyMcpName(name)}`,
    name,
    kind: "stdio",
    auth: "none",
    command: "docker",
    args: ["run", "-i", "--rm", ...extra, image],
    env: input.env,
    packageManager: "oci",
    source: "custom",
  };
}

/** 导出为 Cursor / VS Code 风格片段（便于预览） */
export function toEditorSnippet(config: UnifiedMcpConfig): Record<string, unknown> {
  if (config.kind === "http") {
    const entry: Record<string, unknown> = { url: config.mcpUrl };
    if (config.auth === "apiKey" && config.apiKey) {
      entry.headers = {
        [config.headerName || "Authorization"]: `Bearer ${config.apiKey}`,
      };
    }
    return { mcpServers: { [slugifyMcpName(config.name)]: entry } };
  }
  return {
    mcpServers: {
      [slugifyMcpName(config.name)]: {
        command: config.command,
        args: config.args ?? [],
        ...(config.env && Object.keys(config.env).length
          ? { env: config.env }
          : {}),
      },
    },
  };
}
