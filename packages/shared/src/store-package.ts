/**
 * 商店「包」详情：对齐 Codex 插件页（应用 / 技能 / MCP / Hooks 分列）。
 * MCP 注册表、Skill 仓库、平台集成均归一为此形态。
 */

export type StoreComponentKind = "app" | "mcp" | "skill" | "hook" | "tool";

export type StorePackageKind =
  | "plugin"
  | "platform"
  | "mcp"
  | "skill-repo"
  | "skill"
  | "curated";

export type StorePackageComponent = {
  id: string;
  kind: StoreComponentKind;
  name: string;
  description?: string;
  /** 单项安装用 */
  installRef: string;
  installed?: boolean;
  needsRunner?: boolean;
  auth?: "none" | "apiKey" | "oauth" | "connector";
  /** hook 事件列表摘要 */
  hookEvents?: string[];
};

export type StorePackageDetail = {
  id: string;
  name: string;
  description?: string;
  /** 短标语 / hero 副标题 */
  summary?: string;
  icon?: string;
  kind: StorePackageKind;
  source: string;
  sourceLabel: string;
  homepage?: string;
  docsUrl?: string;
  publisher?: string;
  category?: string;
  version?: string;
  verified?: boolean;
  featured?: boolean;
  tags?: string[];
  /** 整包安装 */
  installRef: string;
  components: StorePackageComponent[];
  /** 信息区扩展字段 */
  info?: Array<{ label: string; value: string; href?: string }>;
};

/** 商店列表卡片（可比 ConnectionListing 更偏「包」） */
export type StorePackageCard = {
  id: string;
  name: string;
  description?: string;
  kind: StorePackageKind;
  source: string;
  icon?: string;
  verified?: boolean;
  featured?: boolean;
  /** 组件计数，如 { skill: 4, mcp: 1, app: 1 } */
  counts: Partial<Record<StoreComponentKind, number>>;
  needsRunner?: boolean;
  publisher?: string;
  /** 详情路由 id（encodeURIComponent） */
  detailId: string;
  /** 聚合页所属分区 */
  sectionId?: string;
  sectionName?: string;
  /** 租户已安装 */
  installed?: boolean;
};

/** 聚合页分区（全部市场 / 单市场也可复用） */
export type StorePackageSection = {
  id: string;
  name: string;
  description?: string;
  truncated?: boolean;
  totalInSection?: number;
  items: StorePackageCard[];
};

export type StorePackageListResult = {
  total: number;
  sourceLabel: string;
  items: StorePackageCard[];
  sections: StorePackageSection[];
};
