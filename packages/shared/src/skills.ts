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
export type SkillStoreId = "builtin" | "skills-sh" | "github";

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
