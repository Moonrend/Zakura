/**
 * 统一 MCP 配置：精选目录 + 商店/导入翻译辅助。
 * 核心类型定义在 @zakura/shared，此处提供平台内目录与转换器。
 */

import {
  MCP_OAUTH_TIER_META,
  pickPreferredInstallPreview,
  type McpAuthMode,
  type McpEnvHint,
  type McpOauthContract,
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

export { pickPreferredInstallPreview, rankInstallPreview } from "@zakura/shared";

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
    description: "读写页面、数据库与评论",
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
    description: "Issues、Projects、Cycles",
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
    id: "atlassian",
    name: "Atlassian",
    description: "Jira / Confluence / Compass",
    kind: "http",
    auth: "oauth",
    mcpUrl: "https://mcp.atlassian.com/v1/mcp",
    docsUrl: "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/",
    repositoryUrl: "https://github.com/atlassian/atlassian-mcp-server",
    tags: ["oauth", "productivity", "recommended"],
    source: "curated",
    icon: "AT",
    group: "productivity",
    oauth: { ...TIER_A, allowPatFallback: true },
  },
  {
    id: "asana",
    name: "Asana",
    description: "任务与项目管理（需预注册 App）",
    kind: "http",
    auth: "oauth",
    mcpUrl: "https://mcp.asana.com/v2/mcp",
    docsUrl: "https://developers.asana.com/docs/connecting-mcp-clients-to-asanas-v2-server",
    tags: ["oauth", "pm", "recommended"],
    source: "curated",
    icon: "AS",
    group: "productivity",
    oauth: TIER_B_PRE,
  },
  {
    id: "miro",
    name: "Miro",
    description: "读写白板",
    kind: "http",
    auth: "oauth",
    mcpUrl: "https://mcp.miro.com/",
    docsUrl: "https://developers.miro.com/docs/miro-mcp",
    tags: ["oauth", "productivity", "recommended"],
    source: "curated",
    icon: "MI",
    group: "productivity",
    oauth: TIER_A,
  },
  {
    id: "slack",
    name: "Slack",
    description: "消息、频道与 Canvas（需预注册 App）",
    kind: "http",
    auth: "oauth",
    mcpUrl: "https://mcp.slack.com/mcp",
    docsUrl: "https://docs.slack.dev/ai/slack-mcp-server",
    tags: ["oauth", "productivity", "recommended"],
    source: "curated",
    icon: "SL",
    group: "productivity",
    oauth: {
      ...TIER_B_PRE,
      providerId: "slack",
    },
  },
  {
    id: "figma",
    name: "Figma",
    description: "设计文件与评论",
    kind: "http",
    auth: "oauth",
    mcpUrl: "https://mcp.figma.com/mcp",
    docsUrl: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/",
    tags: ["oauth", "design", "recommended"],
    source: "curated",
    icon: "FG",
    group: "productivity",
    oauth: TIER_A,
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Workers、KV、R2、DNS",
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
    description: "部署、项目与日志",
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
    id: "sentry",
    name: "Sentry",
    description: "Issues 与项目排查",
    kind: "http",
    auth: "oauth",
    mcpUrl: "https://mcp.sentry.dev/mcp",
    docsUrl: "https://github.com/getsentry/sentry-mcp",
    repositoryUrl: "https://github.com/getsentry/sentry-mcp",
    tags: ["oauth", "infra", "recommended"],
    source: "curated",
    icon: "SE",
    group: "infra",
    oauth: { ...TIER_A, allowPatFallback: true },
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "账单与知识库",
    kind: "http",
    auth: "oauth",
    mcpUrl: "https://mcp.stripe.com",
    docsUrl: "https://docs.stripe.com/mcp",
    tags: ["oauth", "infra", "recommended"],
    source: "curated",
    icon: "$",
    group: "infra",
    oauth: { ...TIER_A, allowPatFallback: true },
  },
  {
    id: "hubspot",
    name: "HubSpot",
    description: "CRM（需预注册 App）",
    kind: "http",
    auth: "oauth",
    mcpUrl: "https://mcp.hubspot.com",
    docsUrl:
      "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server",
    tags: ["oauth", "crm", "recommended"],
    source: "curated",
    icon: "HS",
    group: "productivity",
    oauth: TIER_B_PRE,
  },
  {
    id: "github",
    name: "GitHub",
    description: "仓库、Issues 与 PR",
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
    description: "邮件搜索、草稿与标签",
    kind: "http",
    auth: "oauth",
    mcpUrl: "zakura://google-workspace/gmail",
    docsUrl: "https://developers.google.com/workspace/gmail/api/guides",
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
    description: "搜索与读写文件",
    kind: "http",
    auth: "oauth",
    mcpUrl: "zakura://google-workspace/drive",
    docsUrl: "https://developers.google.com/drive/api/guides/about-sdk",
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
    description: "日程列表与创建",
    kind: "http",
    auth: "oauth",
    mcpUrl: "zakura://google-workspace/calendar",
    docsUrl: "https://developers.google.com/calendar/api/guides/overview",
    tags: ["oauth", "google", "recommended"],
    source: "curated",
    icon: "GC",
    group: "google",
    oauth: {
      ...TIER_B_PRE,
      providerId: "google",
    },
  },
  {
    id: "google-people",
    name: "Google People",
    description: "联系人与通讯录",
    kind: "http",
    auth: "oauth",
    mcpUrl: "zakura://google-workspace/people",
    docsUrl: "https://developers.google.com/people/api/guides/overview",
    tags: ["oauth", "google", "recommended"],
    source: "curated",
    icon: "GP",
    group: "google",
    oauth: {
      ...TIER_B_PRE,
      providerId: "google",
    },
  },
  {
    id: "google-chat",
    name: "Google Chat",
    description: "会话与消息",
    kind: "http",
    auth: "oauth",
    mcpUrl: "zakura://google-workspace/chat",
    docsUrl: "https://developers.google.com/workspace/chat/api/guides/quickstart/nodejs",
    tags: ["oauth", "google", "recommended"],
    source: "curated",
    icon: "CH",
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
}> = [
  {
    id: "google",
    title: "Google Workspace",
  },
  {
    id: "dev",
    title: "开发协作",
  },
  {
    id: "productivity",
    title: "效率工具",
  },
  {
    id: "infra",
    title: "基础设施",
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
