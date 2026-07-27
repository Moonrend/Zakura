/**
 * 平台统一 MCP 定义格式。
 * 官方精选、社区商店、手动导入均翻译为此形态后再安装。
 */

import type { McpOauthContract } from "./mcp-oauth.js";

export type McpAuthMode = "none" | "apiKey" | "oauth";

export type McpPackageManager = "npm" | "pypi" | "oci" | "binary";

export type McpInstallKind =
  | "http"
  | "stdio-npm"
  | "stdio-pypi"
  | "stdio-oci"
  | "stdio-other";

export type McpEnvHint = {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
};

/** 实例级工具权限规则（Google Workspace 等 provider 可声明） */
export type McpToolPermissionRule = {
  id: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
  tools: string[];
};

export type McpToolPermissionState = McpToolPermissionRule & {
  enabled: boolean;
};

/**
 * 统一 MCP 配置：安装 UI / API 的唯一输入形态。
 */
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
  packageManager?: McpPackageManager;
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
    installKind?: McpInstallKind;
  };
};

/**
 * 无需鉴权的 HTTP MCP：新建 Agent 时默认安装到租户并绑定。
 * 官方商店页也会展示这些条目（与 CURATED 目录合并）。
 */
export const DEFAULT_AGENT_AUTO_INSTALL_MCPS: UnifiedMcpConfig[] = [
  {
    id: "grep",
    name: "Grep",
    description: "在百万级 GitHub 公开仓库中搜索代码（Vercel Grep，无需鉴权）",
    kind: "http",
    auth: "none",
    mcpUrl: "https://mcp.grep.app",
    docsUrl: "https://vercel.com/blog/grep-a-million-github-repositories-via-mcp",
    tags: ["dev", "search", "recommended", "no-auth"],
    source: "curated",
    icon: "GR",
    group: "dev",
  },
];

/** 商店 / Registry 安装方案预览（与后端 InstallPreviewOption 对齐） */
export type StoreInstallPreview = {
  id: string;
  kind: McpInstallKind;
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

/** 安装预览排序：stdio（npm/pypi/oci）优先于 HTTP，避免误选空 SSE remote */
export function rankInstallPreview(a: StoreInstallPreview, b: StoreInstallPreview): number {
  const rank = (k: McpInstallKind): number => {
    switch (k) {
      case "stdio-npm":
        return 0;
      case "stdio-pypi":
        return 1;
      case "stdio-oci":
        return 2;
      case "stdio-other":
        return 3;
      case "http":
        return 10;
      default:
        return 20;
    }
  };
  return rank(a.kind) - rank(b.kind);
}

export function pickPreferredInstallPreview(
  options: StoreInstallPreview[],
): StoreInstallPreview | undefined {
  if (!options.length) return undefined;
  const sorted = [...options].sort(rankInstallPreview);
  return sorted[0];
}
