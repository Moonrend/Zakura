/**
 * 统一 MCP 配置格式：将商店预览、编辑器 JSON、精选目录翻译为同一形态，
 * 再交给安装流程写入 generic-mcp / stdio-mcp。
 */

import {
  MCP_OAUTH_TIER_META,
  type McpOauthContract,
} from "@zakura/shared";

export type McpAuthMode = "none" | "apiKey" | "oauth";

export type McpEnvHint = {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
};

export type UnifiedMcpConfig = {
  /** 稳定 id，用于 UI key / 精选目录 */
  id: string;
  name: string;
  description?: string;
  kind: "http" | "stdio";
  auth: McpAuthMode;
  /** HTTP */
  mcpUrl?: string;
  apiKey?: string;
  headerName?: string;
  /** Stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  packageManager?: "npm" | "pypi" | "oci" | "binary";
  image?: string;
  workingDir?: string;
  /** 元数据 */
  docsUrl?: string;
  repositoryUrl?: string;
  icon?: string;
  tags?: string[];
  envHints?: McpEnvHint[];
  source?: "curated" | "store" | "import" | "custom";
  /** OAuth 接入契约（精选目录必填） */
  oauth?: McpOauthContract;
  /** 分组：官方推荐页分区 */
  group?: "productivity" | "infra" | "google" | "dev";
  /** 商店安装时回传 */
  storeMeta?: {
    storeId: string;
    registryName: string;
    prefer: "http" | "stdio";
    remoteUrl?: string;
    packageIndex?: number;
  };
};

export type StoreInstallPreview = {
  id: string;
  kind: "http" | "stdio-npm" | "stdio-pypi" | "stdio-oci" | "stdio-other";
  label: string;
  summary: string;
  detail?: string;
  prefer: "http" | "stdio";
  packageIndex?: number;
  remoteUrl?: string;
  envHints?: McpEnvHint[];
};

export type StoreServerLike = {
  name: string;
  title?: string;
  description?: string;
  storeId: string;
  repository?: { url?: string };
  preview?: StoreInstallPreview[];
};

const TIER_A: McpOauthContract = {
  tier: "A",
  strategies: ["dcr"],
};

const TIER_B_PRE: McpOauthContract = {
  tier: "B",
  strategies: ["pre_registered", "byo"],
};

/** 官方推荐远程 HTTP MCP（独立「官方商店」页） */
export const CURATED_OAUTH_MCPS: UnifiedMcpConfig[] = [
  {
    id: "notion",
    name: "Notion",
    description: "读写 Notion 页面、数据库与评论。纯 OAuth，无需 API Key。",
    kind: "http",
    auth: "oauth",
    mcpUrl: "https://mcp.notion.com/mcp",
    docsUrl: "https://developers.notion.com/docs/get-started-with-mcp",
    tags: ["oauth", "productivity", "recommended"],
    source: "curated",
    icon: "N",
    group: "productivity",
    oauth: TIER_A,
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issues、Projects、Cycles。支持 OAuth（也可改用 API Key）。",
    kind: "http",
    auth: "oauth",
    mcpUrl: "https://mcp.linear.app/mcp",
    docsUrl: "https://linear.app/docs/mcp",
    tags: ["oauth", "pm", "recommended"],
    source: "curated",
    icon: "L",
    group: "productivity",
    oauth: { ...TIER_A, allowPatFallback: true },
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Workers、KV、R2、DNS 等 Cloudflare 能力。OAuth 授权后可用。",
    kind: "http",
    auth: "oauth",
    mcpUrl: "https://mcp.cloudflare.com/mcp",
    docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/",
    tags: ["oauth", "infra", "recommended"],
    source: "curated",
    icon: "CF",
    group: "infra",
    oauth: TIER_A,
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "部署、项目与日志。通过 Vercel 远程 MCP + OAuth 接入。",
    kind: "http",
    auth: "oauth",
    mcpUrl: "https://mcp.vercel.com",
    docsUrl: "https://vercel.com/docs/mcp",
    tags: ["oauth", "deploy", "recommended"],
    source: "curated",
    icon: "▲",
    group: "infra",
    oauth: TIER_A,
  },
  {
    id: "github",
    name: "GitHub",
    description:
      "官方 GitHub MCP（Copilot 托管）。需在「OAuth 应用」配置 GitHub App，或改用 PAT。",
    kind: "http",
    auth: "oauth",
    mcpUrl: "https://api.githubcopilot.com/mcp/",
    docsUrl: "https://github.com/github/github-mcp-server",
    repositoryUrl: "https://github.com/github/github-mcp-server",
    tags: ["oauth", "dev", "recommended"],
    source: "curated",
    icon: "GH",
    group: "dev",
    oauth: {
      ...TIER_B_PRE,
      allowPatFallback: true,
      providerId: "github",
    },
  },
  {
    id: "google-gmail",
    name: "Gmail",
    description:
      "官方 Google Workspace MCP：搜索邮件、读线程、创建草稿。需配置整站 Google OAuth 应用。",
    kind: "http",
    auth: "oauth",
    mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    docsUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    tags: ["oauth", "google", "recommended"],
    source: "curated",
    icon: "GM",
    group: "google",
    oauth: {
      ...TIER_B_PRE,
      providerId: "google",
    },
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description:
      "官方 Google Drive MCP：搜索与读写文件。需配置整站 Google OAuth 应用。",
    kind: "http",
    auth: "oauth",
    mcpUrl: "https://drivemcp.googleapis.com/mcp/v1",
    docsUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    tags: ["oauth", "google", "recommended"],
    source: "curated",
    icon: "GD",
    group: "google",
    oauth: {
      ...TIER_B_PRE,
      providerId: "google",
    },
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    description:
      "官方 Google Calendar MCP：列出日历与日程。需配置整站 Google OAuth 应用。",
    kind: "http",
    auth: "oauth",
    mcpUrl: "https://calendarmcp.googleapis.com/mcp/v1",
    docsUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    tags: ["oauth", "google", "recommended"],
    source: "curated",
    icon: "GC",
    group: "google",
    oauth: {
      ...TIER_B_PRE,
      providerId: "google",
    },
  },
];

export const CURATED_MCP_GROUPS: Array<{
  id: NonNullable<UnifiedMcpConfig["group"]>;
  title: string;
  description: string;
}> = [
  {
    id: "google",
    title: "Google Workspace",
    description: "官方远程 MCP。先在「设置 → OAuth 应用」配置 Google 客户端。",
  },
  {
    id: "dev",
    title: "开发协作",
    description: "GitHub 等需预注册 OAuth App 的服务。",
  },
  {
    id: "productivity",
    title: "效率工具",
    description: "支持 OAuth 动态注册，一键授权。",
  },
  {
    id: "infra",
    title: "基础设施",
    description: "Cloudflare、Vercel 等平台能力。",
  },
];

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

  const pm =
    option.kind === "stdio-pypi"
      ? "pypi"
      : option.kind === "stdio-oci"
        ? "oci"
        : option.kind === "stdio-npm"
          ? "npm"
          : "binary";

  return {
    ...base,
    auth: "none",
    packageManager: pm,
    command: pm === "pypi" ? "uvx" : pm === "oci" ? "docker" : "npx",
    args: [],
  };
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
