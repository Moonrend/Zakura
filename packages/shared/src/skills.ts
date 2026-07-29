/**
 * Agent Skills 协议类型（https://agentskills.io 规范的 Zakura 实现）。
 *
 * 一个 Skill = 一个含 `SKILL.md` 的目录：YAML frontmatter（name/description 必填）
 * + Markdown 正文 + 可选捆绑资源（scripts/ references/ assets/）。
 * 安装后写入 Agent 工作区 `/skills/<name>/`，既能被模型按需读取，
 * 也能经 MCP（re_list_skills / re_read_skill）被外部客户端调用。
 */

/** Agent 工作区内的技能根目录（相对工作区根） */
export const AGENT_SKILLS_DIR = "skills";
/** 技能清单文件名 */
export const SKILL_MANIFEST_FILE = "SKILL.md";

/** 单个技能包体积上限 */
export const SKILL_MAX_FILES = 64;
export const SKILL_MAX_FILE_BYTES = 512 * 1024;
export const SKILL_MAX_TOTAL_BYTES = 4 * 1024 * 1024;

/** 仓库中约定的技能目录（与 vercel-labs/skills 的发现规则对齐） */
export const SKILL_DISCOVERY_DIRS = [
  "skills",
  ".claude/skills",
  ".agents/skills",
  "skills/.curated",
  "skills/.experimental",
  "skills/.system",
  ".claude-plugin/skills",
  "plugins",
] as const;

/** 技能商店 */
export type SkillStoreId = "builtin" | "curated" | "skills-sh" | "github";

export interface SkillStoreMeta {
  id: SkillStoreId;
  name: string;
  description: string;
  url: string;
  /** 是否支持关键词搜索（builtin 为本地过滤） */
  searchable: boolean;
}

export const SKILL_STORES: SkillStoreMeta[] = [
  {
    id: "builtin",
    name: "内置推荐",
    description: "Zakura 为云端 Agent 定制的技能，开箱即用",
    url: "https://agentskills.io",
    searchable: true,
  },
  {
    id: "curated",
    name: "官方仓库",
    description: "服务端已同步到本地的主流技能仓库，安装无需联网",
    url: "https://github.com/topics/agent-skills",
    searchable: true,
  },
  {
    id: "skills-sh",
    name: "skills.sh",
    description: "开放 Agent Skills 生态目录，按安装量排序",
    url: "https://skills.sh",
    searchable: true,
  },
  {
    id: "github",
    name: "GitHub",
    description: "搜索 GitHub 上包含 SKILL.md 的仓库",
    url: "https://github.com/topics/agent-skills",
    searchable: true,
  },
];

/**
 * 服务端预拉取并定期更新的技能仓库。
 *
 * 这些仓库本身就相当于一个商店（几十个技能），逐租户现拉既慢又费 GitHub 配额；
 * 平台侧同步一份到数据库后，租户安装只是一次本地读取。
 */
export interface CuratedSkillRepo {
  /** owner/repo，同时作为 installSpec 前缀 */
  slug: string;
  name: string;
  description: string;
  /** 展示用分组 */
  publisher: string;
  /** 优先同步（首次启动就拉） */
  primary?: boolean;
}

export const CURATED_SKILL_REPOS: CuratedSkillRepo[] = [
  {
    slug: "anthropics/skills",
    name: "Anthropic Skills",
    description: "Anthropic 官方技能集：文档处理、前端设计、MCP 构建等",
    publisher: "Anthropic",
    primary: true,
  },
  {
    slug: "openai/skills",
    name: "OpenAI Skills",
    description: "OpenAI 官方技能集",
    publisher: "OpenAI",
    primary: true,
  },
  {
    slug: "vercel-labs/agent-skills",
    name: "Vercel Agent Skills",
    description: "Vercel 出品的前端与写作类技能",
    publisher: "Vercel",
    primary: true,
  },
  {
    slug: "obra/superpowers",
    name: "Superpowers",
    description: "工程实践类技能：TDD、系统化调试、代码评审",
    publisher: "obra",
    primary: true,
  },
  {
    slug: "anthropics/knowledge-work-plugins",
    name: "Knowledge Work Plugins",
    description: "Anthropic 知识工作插件集",
    publisher: "Anthropic",
  },
  {
    slug: "cursor/plugins",
    name: "Cursor Plugins",
    description: "Cursor 官方插件与技能",
    publisher: "Cursor",
  },
  {
    slug: "google-labs-code/stitch-skills",
    name: "Stitch Skills",
    description: "Google Labs Stitch 设计到代码工作流",
    publisher: "Google Labs",
  },
  {
    slug: "mattpocock/skills",
    name: "Matt Pocock Skills",
    description: "写作与 TypeScript 相关技能",
    publisher: "mattpocock",
  },
];

/** 技能来源类型 */
export type SkillSourceKind = "builtin" | "github" | "gitlab" | "git" | "url";

/**
 * 解析后的技能来源。
 * 由 `npx skills add …` 命令、GitHub URL、`owner/repo@skill` 简写等统一归一化而来。
 */
export interface SkillSource {
  kind: SkillSourceKind;
  /** 用户原始输入，便于回显与再次解析 */
  raw?: string;
  owner?: string;
  repo?: string;
  /** 分支 / tag / commit；缺省用仓库默认分支 */
  ref?: string;
  /** 仓库内子路径：可指向单个技能目录，也可指向技能集合目录 */
  path?: string;
  /** 指定安装的技能名（`--skill x` 或 `owner/repo@x`）；`*` 表示全部 */
  skills?: string[];
  /** 直链（raw SKILL.md / git clone URL / 任意 https 地址） */
  url?: string;
  /** 内置技能 id（kind=builtin 时） */
  builtinId?: string;
  /** 来源商店（仅用于展示） */
  store?: SkillStoreId;
}

/** SKILL.md 的 YAML frontmatter */
export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  license?: string;
  homepage?: string;
  /** Claude Code 兼容字段 */
  "allowed-tools"?: string[] | string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SkillFile {
  /** 相对技能根目录的路径，如 `SKILL.md` / `references/api.md` */
  path: string;
  content: string;
  /** 二进制资源用 base64 */
  encoding: "utf8" | "base64";
  size: number;
}

/** 完整技能包（解析后、写入工作区前的中间态） */
export interface SkillPackage {
  name: string;
  title: string;
  description: string;
  frontmatter: SkillFrontmatter;
  /** SKILL.md 去掉 frontmatter 后的正文，用于预览 */
  body: string;
  files: SkillFile[];
  /**
   * 预览模式（manifestOnly）下未下载、但确实存在的捆绑文件清单。
   * 只有 path/size，正式安装时才会真正拉取内容。
   */
  assets?: Array<{ path: string; size: number }>;
  source: SkillSource;
  /** commit sha 或抓取时间戳 */
  version?: string;
  sizeBytes: number;
  homepage?: string;
  license?: string;
}

/** 租户级技能注册表条目（API 返回） */
export interface SkillRecord {
  id: string;
  name: string;
  title: string;
  description: string;
  version: string | null;
  builtin: boolean;
  source: SkillSource;
  homepage: string | null;
  license: string | null;
  fileCount: number;
  sizeBytes: number;
  /** 已安装该技能的 Agent id */
  agentIds: string[];
  /** 命中平台缓存时的仓库标识 */
  repoKey?: string | null;
  /** 平台缓存里已有更新版本 */
  updateAvailable?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AgentSkillStatus = "installed" | "error";

/** 单个 Agent 上的技能安装记录 */
export interface AgentSkillRecord {
  id: string;
  agentId: string;
  skillId: string;
  name: string;
  title: string;
  description: string;
  enabled: boolean;
  /** 工作区内路径，如 `/skills/find-skills` */
  path: string;
  version: string | null;
  status: AgentSkillStatus;
  error: string | null;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 商店搜索结果条目 */
export interface SkillSearchItem {
  /** 商店内稳定 id */
  id: string;
  store: SkillStoreId;
  name: string;
  title: string;
  description: string;
  /** 展示用来源，如 `vercel-labs/agent-skills` */
  source: string;
  /** 可直接投喂 /api/skills/resolve 的安装串 */
  installSpec: string;
  installs?: number;
  stars?: number;
  homepage?: string;
  /** 已在本租户注册表中 */
  installed?: boolean;
  /** curated：内容已在平台缓存里，安装无需联网 */
  cached?: boolean;
  /** curated：所属仓库（用于按仓库分组浏览） */
  repoSlug?: string;
  publisher?: string;
}

/** 分页参数：仓库型商店动辄几十上百个技能，不能一次全端上来 */
export interface SkillSearchPage {
  items: SkillSearchItem[];
  /** 满足条件的总数（已知时） */
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  errors: Array<{ store: SkillStoreId; error: string }>;
}

/** 已同步到平台的技能仓库（商店入口） */
export interface SkillRepoSummary {
  repoKey: string;
  slug: string;
  name: string;
  description: string;
  publisher: string;
  skillCount: number;
  sizeBytes: number;
  version: string | null;
  /** 最近一次确认与上游一致 */
  checkedAt: string | null;
  fetchedAt: string | null;
  /** 只缓存了清单，安装时补齐捆绑文件 */
  partial: boolean;
  /** 尚未同步（首次访问会触发拉取） */
  pending: boolean;
  lastError: string | null;
}

export type SkillTokenScope = "platform" | "tenant";
export type SkillTokenProvider = "github" | "gitlab";

/** 令牌只回显掩码，不回明文 */
export interface SkillTokenInfo {
  scope: SkillTokenScope;
  provider: SkillTokenProvider;
  /** 末 4 位 */
  hint: string | null;
  label: string | null;
  updatedAt: string;
  lastUsedAt: string | null;
}

/** 平台缓存概况（管理端展示） */
export interface SkillCacheStatus {
  repos: SkillRepoSummary[];
  totalSkills: number;
  totalBytes: number;
  /** 下次后台刷新的间隔（毫秒） */
  refreshIntervalMs: number;
}

/** 解析预览结果：一个来源可能包含多个技能 */
export interface SkillResolveResult {
  source: SkillSource;
  skills: Array<{
    name: string;
    title: string;
    description: string;
    body: string;
    files: Array<{ path: string; size: number }>;
    sizeBytes: number;
    version?: string;
    homepage?: string;
    license?: string;
    /** 该名字已存在于租户注册表 */
    installed: boolean;
  }>;
  /** 解析过程中的告警（跳过的超大文件、无效 frontmatter 等） */
  warnings: string[];
}

/** 安装请求：target 二选一 —— 指定 agentIds，或 all=true 装给全部 Agent */
export interface SkillInstallRequest {
  /** 来源串（npx 命令 / URL / owner/repo@skill）；与 skillId 二选一 */
  source?: string;
  /** 已在注册表中的技能 id */
  skillId?: string;
  /** 来源含多个技能时，指定安装哪些 */
  names?: string[];
  agentIds?: string[];
  all?: boolean;
}

export interface SkillInstallResult {
  skills: SkillRecord[];
  installs: AgentSkillRecord[];
  warnings: string[];
}
