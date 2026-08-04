/**
 * 统一「连接」产品面类型。
 * 底层仍落 component_instances / skills / connector_credentials，此处只做用户心智与 API 契约。
 */

export type ConnectionKind =
  | "platform"
  | "mcp-http"
  | "mcp-stdio"
  | "skill"
  | "plugin";

export type ConnectionSourceId =
  | "platform"
  | "mcp"
  | "mcp-official"
  | "mcp-community"
  | "skill"
  | "skill-builtin"
  | "skill-curated"
  | "skill-skills-sh"
  | "skill-github"
  | "plugin"
  | string;

export type ConnectionAuthMode = "none" | "apiKey" | "oauth" | "connector";

/** 商店/目录条目 */
export type ConnectionListing = {
  id: string;
  name: string;
  description?: string;
  kind: ConnectionKind;
  source: ConnectionSourceId;
  auth: ConnectionAuthMode;
  /** stdio/docker 包需要选 Runner */
  needsRunner: boolean;
  icon?: string;
  tags?: string[];
  docsUrl?: string;
  homepage?: string;
  verified?: boolean;
  featured?: boolean;
  /** 插件捆绑的技能引用 */
  bundledSkills?: Array<{ name: string; source?: string }>;
  /** 插件捆绑的 hook 事件名 */
  bundledHookEvents?: string[];
  /** 安装时回传 */
  installRef: string;
  /** 平台连接器凭据 schema（fields 驱动 UI） */
  credentialFields?: ConnectionCredentialField[];
  connectorId?: string;
  packageSlug?: string;
};

export type ConnectionCredentialField = {
  key: string;
  label: string;
  type: "text" | "secret" | "url";
  required?: boolean;
  placeholder?: string;
  description?: string;
};

/** 已安装连接（合并列表） */
export type InstalledConnection = {
  id: string;
  name: string;
  kind: ConnectionKind;
  status: string;
  providerId?: string;
  slug?: string;
  runtimeNodeId?: string | null;
  endpointUrl?: string | null;
  healthStatus?: string;
  agentIds?: string[];
  /** skill 专用 */
  skillName?: string;
  builtin?: boolean;
  /** 第三方技能是否自动更新 */
  autoUpdate?: boolean;
  updateAvailable?: boolean;
  sourceLabel?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type ConnectionInstallRequest = {
  /** listing.installRef 或显式来源语法 */
  source: string;
  ref?: string;
  kind?: ConnectionKind;
  runtimeNodeId?: string | null;
  agentIds?: string[];
  credentialScope?: "tenant" | "platform";
  config?: Record<string, unknown>;
  name?: string;
  /** 商店包详情页：只装选中的组件（省略则整包非 app 组件） */
  componentIds?: string[];
  /** 可选：按包 id 安装（优先于仅解析 source） */
  packageId?: string;
};

export type ConnectionInstallResult = {
  id: string;
  kind: ConnectionKind;
  name: string;
  status: string;
  authRequired?: boolean;
  oauthUrl?: string;
  instanceId?: string;
  skillId?: string;
  runtimeNodeId?: string | null;
  bundled?: ConnectionInstallResult[];
};

export type ConnectionSourceMeta = {
  id: string;
  name: string;
  description: string;
  kind: "builtin" | "custom";
  format?: "auto" | "codex" | "claude" | "mcp" | "skill";
  url?: string;
};

export type ConnectionBindRequest = {
  agentId: string;
  /** 对 skill：安装到该 agent；对 mcp：创建 binding */
  enabled?: boolean;
};
