/**
 * 连接商店的内置「市场」目录。
 * 「全部」聚合这些市场；每个也可单独打开（UI 用切换器，不堆顶栏 Tab）。
 */
import { CURATED_SKILL_REPOS, SKILL_STORES } from "./skills.js";

export type BuiltinMarketKind =
  | "platform"
  | "mcp-curated"
  | "mcp-registry"
  | "plugin-repo"
  | "skill-repo"
  | "skill-store";

export type BuiltinMarketGroup = "platform" | "mcp" | "plugin" | "skill";

export type BuiltinMarket = {
  id: string;
  name: string;
  description: string;
  kind: BuiltinMarketKind;
  group: BuiltinMarketGroup;
  /** plugin-repo：GitHub owner/repo */
  repository?: string;
  format?: "claude" | "codex" | "auto";
  /** skill-repo：CURATED slug */
  skillRepoSlug?: string;
  /** skill-store：builtin / skills-sh / github */
  skillStoreId?: "builtin" | "skills-sh" | "github";
  /** mcp-registry：对应 MCP_STORES id */
  mcpStoreId?: "github-mcp" | "official-registry" | "mcpservers-org" | "awesome-mcp";
  publisher?: string;
};

/** 主要作为插件市场（而非纯技能仓库）的 curated slug */
const PLUGIN_SKILL_REPO_SLUGS = new Set([
  "anthropics/knowledge-work-plugins",
  "cursor/plugins",
]);

/**
 * 内置市场列表（不含「全部」虚拟源）。
 * Official Registry / GitHub MCP / Awesome / 中文站各自独立。
 */
export const BUILTIN_MARKETS: BuiltinMarket[] = [
  {
    id: "platform",
    name: "平台集成",
    description: "Google / Microsoft 等由平台代调的连接器与工具",
    kind: "platform",
    group: "platform",
  },
  {
    id: "mcp-official",
    name: "官方 MCP",
    description: "reCloud 精选远程 HTTP MCP（Notion、Linear 等），开箱 OAuth",
    kind: "mcp-curated",
    group: "mcp",
  },
  {
    id: "github-mcp",
    name: "GitHub MCP",
    description: "GitHub 官方 MCP Registry（精选、可直接安装）",
    kind: "mcp-registry",
    group: "mcp",
    mcpStoreId: "github-mcp",
  },
  {
    id: "official-registry",
    name: "Official Registry",
    description: "官方 MCP Registry 全量元数据（Anthropic / GitHub 等共建）",
    kind: "mcp-registry",
    group: "mcp",
    mcpStoreId: "official-registry",
  },
  {
    id: "awesome-mcp",
    name: "Awesome MCP",
    description: "GitHub 精选列表（含 npx 安装提示）",
    kind: "mcp-registry",
    group: "mcp",
    mcpStoreId: "awesome-mcp",
  },
  {
    id: "mcpservers-org",
    name: "MCP Servers 中文站",
    description: "社区中文目录；关键词对齐 Official Registry 可安装项",
    kind: "mcp-registry",
    group: "mcp",
    mcpStoreId: "mcpservers-org",
  },
  {
    id: "claude-plugins-official",
    name: "Claude 官方插件",
    description: "Anthropic 管理的 Claude Code 插件目录（应用 · 技能 · MCP · Hooks）",
    kind: "plugin-repo",
    group: "plugin",
    repository: "anthropics/claude-plugins-official",
    format: "claude",
    publisher: "Anthropic",
  },
  {
    id: "anthropic-knowledge-work",
    name: "Knowledge Work Plugins",
    description: "Anthropic 知识工作插件集",
    kind: "plugin-repo",
    group: "plugin",
    repository: "anthropics/knowledge-work-plugins",
    format: "claude",
    publisher: "Anthropic",
  },
  {
    id: "cursor-plugins",
    name: "Cursor Plugins",
    description: "Cursor 官方插件与技能",
    kind: "plugin-repo",
    group: "plugin",
    repository: "cursor/plugins",
    format: "auto",
    publisher: "Cursor",
  },
  {
    id: "skill-repo:openai/skills",
    name: "OpenAI · Codex 技能",
    description: "OpenAI 官方技能集，兼容 Codex / ChatGPT 插件技能工作流",
    kind: "skill-repo",
    group: "plugin",
    skillRepoSlug: "openai/skills",
    publisher: "OpenAI",
  },
  ...CURATED_SKILL_REPOS.filter(
    (repo) => repo.slug !== "openai/skills" && !PLUGIN_SKILL_REPO_SLUGS.has(repo.slug),
  ).map(
    (repo): BuiltinMarket => ({
      id: `skill-repo:${repo.slug}`,
      name: repo.name,
      description: repo.description,
      kind: "skill-repo",
      group: "skill",
      skillRepoSlug: repo.slug,
      publisher: repo.publisher,
    }),
  ),
  ...SKILL_STORES.filter((s) => s.id !== "curated").map(
    (s): BuiltinMarket => ({
      id: `skill-${s.id}`,
      name: s.name,
      description: s.description,
      kind: "skill-store",
      group: "skill",
      skillStoreId: s.id as "builtin" | "skills-sh" | "github",
    }),
  ),
];

export function getBuiltinMarket(id: string): BuiltinMarket | undefined {
  return BUILTIN_MARKETS.find((m) => m.id === id);
}

export function builtinPluginMarkets(): BuiltinMarket[] {
  return BUILTIN_MARKETS.filter((m) => m.kind === "plugin-repo");
}
