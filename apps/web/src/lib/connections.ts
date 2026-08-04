import { api } from "@/lib/api";

export type ConnectionKind =
  | "platform"
  | "mcp-http"
  | "mcp-stdio"
  | "skill"
  | "plugin";

export type ConnectionAuthMode = "none" | "apiKey" | "oauth" | "connector";

export type ConnectionCredentialField = {
  key: string;
  label: string;
  type: "text" | "secret" | "url";
  required?: boolean;
  placeholder?: string;
  description?: string;
};

export type ConnectionListing = {
  id: string;
  name: string;
  description?: string;
  kind: ConnectionKind;
  source: string;
  auth: ConnectionAuthMode;
  needsRunner: boolean;
  icon?: string;
  tags?: string[];
  docsUrl?: string;
  homepage?: string;
  verified?: boolean;
  featured?: boolean;
  bundledSkills?: Array<{ name: string; source?: string }>;
  bundledHookEvents?: string[];
  installRef: string;
  credentialFields?: ConnectionCredentialField[];
  connectorId?: string;
  packageSlug?: string;
};

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
  skillName?: string;
  builtin?: boolean;
  autoUpdate?: boolean;
  updateAvailable?: boolean;
  sourceLabel?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type ConnectionInstallRequest = {
  source: string;
  ref?: string;
  kind?: ConnectionKind;
  runtimeNodeId?: string | null;
  agentIds?: string[];
  credentialScope?: "tenant" | "platform";
  config?: Record<string, unknown>;
  name?: string;
  componentIds?: string[];
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
  installRef: string;
  installed?: boolean;
  needsRunner?: boolean;
  auth?: ConnectionAuthMode;
  hookEvents?: string[];
};

export type StorePackageDetail = {
  id: string;
  name: string;
  description?: string;
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
  installRef: string;
  components: StorePackageComponent[];
  info?: Array<{ label: string; value: string; href?: string }>;
};

export type StorePackageCard = {
  id: string;
  name: string;
  description?: string;
  kind: StorePackageKind;
  source: string;
  icon?: string;
  verified?: boolean;
  featured?: boolean;
  counts: Partial<Record<StoreComponentKind, number>>;
  needsRunner?: boolean;
  publisher?: string;
  detailId: string;
  sectionId?: string;
  sectionName?: string;
  installed?: boolean;
};

export type StorePackageSection = {
  id: string;
  name: string;
  description?: string;
  truncated?: boolean;
  totalInSection?: number;
  items: StorePackageCard[];
};

export async function listConnections(): Promise<InstalledConnection[]> {
  const res = await api<{ items: InstalledConnection[] }>("/api/connections");
  return res.items ?? [];
}

export async function searchConnections(opts: {
  q?: string;
  source?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: ConnectionListing[]; total?: number }> {
  const params = new URLSearchParams();
  if (opts.q?.trim()) params.set("q", opts.q.trim());
  if (opts.source) params.set("source", opts.source);
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.offset != null) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return api(`/api/connections/search${qs ? `?${qs}` : ""}`);
}

export async function listStorePackages(opts: {
  q?: string;
  source: string;
  repo?: string;
  limit?: number;
  offset?: number;
}): Promise<{
  items: StorePackageCard[];
  total: number;
  sourceLabel: string;
  sections: StorePackageSection[];
}> {
  const params = new URLSearchParams();
  params.set("source", opts.source);
  if (opts.q?.trim()) params.set("q", opts.q.trim());
  if (opts.repo) params.set("repo", opts.repo);
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.offset != null) params.set("offset", String(opts.offset));
  const res = await api<{
    items: StorePackageCard[];
    total: number;
    sourceLabel: string;
    sections?: StorePackageSection[];
  }>(`/api/connections/packages?${params.toString()}`);
  return {
    items: res.items ?? [],
    total: res.total ?? 0,
    sourceLabel: res.sourceLabel ?? "",
    sections: res.sections ?? [],
  };
}

export async function getStorePackage(id: string): Promise<StorePackageDetail> {
  const res = await api<{ package: StorePackageDetail }>(
    `/api/connections/packages/${encodeURIComponent(id)}`,
  );
  return res.package;
}

export async function installStorePackage(
  id: string,
  body: {
    componentIds?: string[];
    runtimeNodeId?: string | null;
    agentIds?: string[];
    config?: Record<string, unknown>;
    name?: string;
  } = {},
): Promise<ConnectionInstallResult> {
  const res = await api<{ result: ConnectionInstallResult }>(
    `/api/connections/packages/${encodeURIComponent(id)}/install`,
    { method: "POST", json: body },
  );
  return res.result;
}

export async function listConnectionSources(): Promise<ConnectionSourceMeta[]> {
  const res = await api<{ sources: ConnectionSourceMeta[] }>("/api/connections/sources");
  return res.sources ?? [];
}

export async function addConnectionSource(repository: string): Promise<ConnectionSourceMeta> {
  const res = await api<{ source: ConnectionSourceMeta }>("/api/connections/sources", {
    method: "POST",
    json: { repository },
  });
  return res.source;
}

export async function deleteConnectionSource(id: string): Promise<void> {
  await api(`/api/connections/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function installConnection(
  body: ConnectionInstallRequest,
): Promise<ConnectionInstallResult> {
  const res = await api<{ result: ConnectionInstallResult }>("/api/connections/install", {
    method: "POST",
    json: body,
  });
  return res.result;
}

export async function bindConnection(id: string, agentId: string): Promise<void> {
  await api(`/api/connections/${encodeURIComponent(id)}/bind`, {
    method: "POST",
    json: { agentId },
  });
}

export async function removeConnection(id: string): Promise<void> {
  await api(`/api/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function startConnection(id: string): Promise<void> {
  await api(`/api/connections/${encodeURIComponent(id)}/start`, { method: "POST" });
}

export async function stopConnection(id: string): Promise<void> {
  await api(`/api/connections/${encodeURIComponent(id)}/stop`, { method: "POST" });
}

export async function migrateInstance(
  instanceId: string,
  targetRuntimeNodeId: string,
): Promise<unknown> {
  return api(`/api/instances/${encodeURIComponent(instanceId)}/migrations`, {
    method: "POST",
    json: { targetRuntimeNodeId },
  });
}

export function connectionKindLabel(kind: string): string {
  switch (kind) {
    case "platform":
      return "平台";
    case "mcp-http":
      return "MCP HTTP";
    case "mcp-stdio":
      return "MCP Stdio";
    case "skill":
      return "技能";
    case "plugin":
      return "插件";
    case "skill-repo":
      return "技能仓库";
    case "curated":
      return "官方 MCP";
    case "mcp":
      return "MCP";
    default:
      return kind;
  }
}

export function packageCountsLabel(counts: StorePackageCard["counts"]): string {
  const parts: string[] = [];
  if (counts.app) parts.push(`${counts.app} 应用`);
  if (counts.mcp) parts.push(`${counts.mcp} MCP`);
  if (counts.tool) parts.push(`${counts.tool} 工具`);
  if (counts.skill) parts.push(`${counts.skill} 技能`);
  if (counts.hook) parts.push(`${counts.hook} hooks`);
  return parts.join(" · ");
}

export function connectionStatusVariant(
  status: string,
): "success" | "secondary" | "warn" | "danger" | "outline" {
  if (status === "running" || status === "ready" || status === "healthy" || status === "installed") {
    return "success";
  }
  if (status === "error" || status === "unhealthy") return "danger";
  if (status === "starting" || status === "stopping") return "warn";
  if (status === "stopped" || status === "idle" || status === "exited") return "secondary";
  return "outline";
}

export function connectionStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "运行中";
    case "ready":
    case "healthy":
    case "installed":
      return "可用";
    case "starting":
      return "启动中";
    case "stopping":
      return "停止中";
    case "stopped":
    case "exited":
      return "已停止";
    case "error":
    case "unhealthy":
      return "异常";
    case "idle":
      return "空闲";
    default:
      return status || "—";
  }
}

/** instance:xxx → 真实实例 id；其它返回 null */
export function parseInstanceId(connectionId: string): string | null {
  if (!connectionId.startsWith("instance:")) return null;
  return connectionId.slice("instance:".length) || null;
}
