import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, eq } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { mcpStoreSources, newId } from "../db/schema.js";
import {
  DEFAULT_NODE_IMAGE,
  DEFAULT_PYTHON_IMAGE,
} from "../providers/stdio-mcp.js";
import {
  previewFromPackagesAndRemotes,
  parseEditorMcpConfig,
  type ParsedMcpEntry,
  type InstallPreviewOption,
} from "../lib/mcp-install-parse.js";
import { parseHooksJson, type AgentHooksByEvent } from "@zakura/shared";

const OFFICIAL_REGISTRY = "https://registry.modelcontextprotocol.io";
const GITHUB_MCP_REGISTRY = "https://github.com/mcp";
const AWESOME_README =
  "https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md";

export type McpStoreId =
  | "github-mcp"
  | "official-registry"
  | "mcpservers-org"
  | "awesome-mcp";
export type BuiltinPluginMarketId = string;
export type McpStoreSourceId = McpStoreId | `custom:${string}` | `market:${string}`;

export type McpStoreMeta = {
  id: McpStoreSourceId;
  name: string;
  url: string;
  description: string;
  /** Whether sync pulls installable metadata into local cache */
  syncable: boolean;
  format?: "builtin" | "codex" | "claude" | "auto";
  removable?: boolean;
};

/** First-class store catalogs shown as tabs in the UI */
export const MCP_STORES: McpStoreMeta[] = [
  {
    id: "github-mcp",
    name: "GitHub MCP",
    url: "https://github.com/mcp",
    description: "GitHub 官方 MCP Registry（精选、可直接安装）",
    syncable: true,
  },
  {
    id: "official-registry",
    name: "Official Registry",
    url: "https://registry.modelcontextprotocol.io/",
    description: "官方 MCP Registry 全量元数据（Anthropic / GitHub 等共建）",
    syncable: true,
  },
  {
    id: "mcpservers-org",
    name: "MCP Servers 中文站",
    url: "https://mcpservers.org/zh-CN/",
    description: "社区中文目录；同步时按关键词对齐 Official Registry 可安装项",
    syncable: true,
  },
  {
    id: "awesome-mcp",
    name: "Awesome MCP",
    url: "https://github.com/punkpeye/awesome-mcp-servers",
    description: "GitHub 精选列表（含 npx 安装提示）",
    syncable: true,
  },
];

export function isBuiltinMcpStoreId(value: string): value is McpStoreId {
  return MCP_STORES.some((source) => source.id === value);
}

export type McpStoreRemote = {
  type: string;
  url: string;
  headers?: Array<{
    name: string;
    value?: string;
    description?: string;
    isRequired?: boolean;
    isSecret?: boolean;
  }>;
};

export type McpStorePackage = {
  registryType: string;
  identifier: string;
  version?: string;
  runtimeHint?: string;
  transport?: { type: string };
  runtimeArguments?: Array<{
    value?: string;
    type?: string;
    name?: string;
    default?: string;
    isRequired?: boolean;
  }>;
  packageArguments?: Array<{
    value?: string;
    type?: string;
    name?: string;
    default?: string;
    isRequired?: boolean;
  }>;
  environmentVariables?: Array<{
    name: string;
    description?: string;
    isRequired?: boolean;
    isSecret?: boolean;
    default?: string;
  }>;
};

export type McpStoreServer = {
  name: string;
  title?: string;
  description: string;
  version: string;
  repository?: { url?: string; source?: string };
  remotes?: McpStoreRemote[];
  packages?: McpStorePackage[];
  status?: string;
  /** Which store catalog this entry belongs to */
  storeId: McpStoreSourceId;
  /** Official registry name used to resolve packages (e.g. io.github.microsoft/markitdown) */
  registryName?: string;
  stars?: number;
  topics?: string[];
  category?: string;
  /** Raw install hint from awesome lists, e.g. npx -y @pkg */
  installHint?: string;
  /** Skills bundled by the same Codex / Claude plugin. */
  skills?: McpStoreSkill[];
  /** Hooks bundled by the same plugin (Claude hooks.json 子集). */
  hooks?: import("@zakura/shared").AgentHooksByEvent;
  /** True when this entry is a plugin package (may have zero MCP remotes). */
  isPlugin?: boolean;
  /** Plugin display / package id */
  pluginName?: string;
  installKinds: Array<"http" | "stdio-npm" | "stdio-pypi" | "stdio-oci" | "stdio-other">;
};

export type McpStoreSkill = {
  name: string;
  description?: string;
  source: string;
};

export type McpInstallPlan =
  | {
      kind: "http";
      providerId: "generic-mcp";
      name: string;
      slug: string;
      config: { mcpUrl: string; apiKey?: string; headerName?: string };
      envHints: McpStorePackage["environmentVariables"];
    }
  | {
      kind: "stdio";
      providerId: "stdio-mcp";
      name: string;
      slug: string;
      config: {
        command: string;
        args: string;
        env: string;
        image: string;
        workingDir: string;
        packageManager: "npm" | "pypi" | "oci" | "binary";
      };
      envHints: McpStorePackage["environmentVariables"];
    };

type CacheFile = {
  fetchedAt: string;
  storeId: McpStoreId;
  servers: McpStoreServer[];
};

type MarketCacheFile = {
  fetchedAt: string;
  marketId: string;
  servers: McpStoreServer[];
};

type MarketplaceFormat = "auto" | "codex" | "claude";
type MarketplacePlugin = {
  name?: string;
  description?: string;
  category?: string;
  source?: string | { source?: string; url?: string; ref?: string };
  mcpServers?: unknown;
  skills?: unknown;
  hooks?: unknown;
};

const MAX_MARKETPLACE_BYTES = 2 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function normalizeGitRepository(input: string): string {
  const value = input.trim().replace(/^git\+/, "");
  const scp = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(value);
  if (scp && !value.includes("://")) {
    return `https://${scp[1]}/${scp[2].replace(/^\/+/, "")}`;
  }
  if (/^[\w.-]+\/[\w.-]+(?:\.git)?$/.test(value)) {
    return `https://github.com/${value.replace(/\.git$/, "")}.git`;
  }
  if (!value.includes("://") && !value.startsWith("/")) {
    return `https://github.com/${value.replace(/^\/+|\/+$/g, "")}.git`;
  }
  if (/^github\.com\//i.test(value)) return `https://${value.replace(/\.git$/, "")}.git`;
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("仓库必须使用 HTTPS；owner/repo 会自动按 GitHub 处理");
  return url.toString();
}

function posixDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function joinRepoPath(base: string, relative: string): string {
  const stack = base.split("/").filter(Boolean);
  for (const part of relative.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

async function withGitRepository<T>(repository: string, fn: (files: string[], readJson: (path: string) => Promise<unknown>) => Promise<T>): Promise<T> {
  const remote = normalizeGitRepository(repository);
  await assertMarketplaceUrl(remote);
  const dir = mkdtempSync(join(tmpdir(), "recloud-mcp-store-"));
  try {
    const cloneArgs = ["-c", "protocol.file.allow=never", "clone", "--depth", "1", "--no-checkout", "--quiet", remote, dir];
    try {
      await execFileAsync("git", ["-c", "protocol.file.allow=never", "clone", "--depth", "1", "--filter=blob:none", "--no-checkout", "--quiet", remote, dir], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    } catch {
      rmSync(join(dir, ".git"), { recursive: true, force: true });
      await execFileAsync("git", cloneArgs, { timeout: 60_000, maxBuffer: 1024 * 1024 });
    }
    const listed = await execFileAsync("git", ["-C", dir, "ls-tree", "-r", "--name-only", "HEAD"], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const files = listed.stdout.split(/\r?\n/).filter(Boolean);
    const fileSet = new Set(files);
    const readJson = async (path: string): Promise<unknown> => {
      if (!fileSet.has(path)) throw new Error(`仓库中不存在 ${path}`);
      const shown = await execFileAsync("git", ["-C", dir, "show", `HEAD:${path}`], {
        timeout: 15_000,
        maxBuffer: MAX_MARKETPLACE_BYTES,
      });
      try { return JSON.parse(shown.stdout) as unknown; }
      catch { throw new Error(`${path} 不是有效 JSON`); }
    };
    return await fn(files, readJson);
  } catch (error) {
    if (error instanceof Error && /ENOENT/.test(error.message)) throw new Error("服务器未安装 git，无法读取仓库");
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function privateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  if (version === 6) {
    const value = ip.toLowerCase();
    return value === "::1" || value.startsWith("fc") || value.startsWith("fd") ||
      value.startsWith("fe80:") || value.startsWith("::ffff:");
  }
  return true;
}

async function assertMarketplaceUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("商店地址必须是公开的 HTTPS URL");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || isIP(host) && privateIp(host)) {
    throw new Error("商店地址不能指向本机或私有网络");
  }
  const records = await lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some((record) => privateIp(record.address))) {
    throw new Error("商店地址解析到了私有网络");
  }
  return url;
}

async function fetchMarketplaceJson(url: URL): Promise<unknown> {
  await assertMarketplaceUrl(url.toString());
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "reCloud-mcp-store/1.0" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`读取商店失败: HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_MARKETPLACE_BYTES) throw new Error("商店清单超过 2 MB 限制");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_MARKETPLACE_BYTES) throw new Error("商店清单超过 2 MB 限制");
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error("商店返回的不是有效 JSON"); }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function githubRawRoot(raw: string, ref = "main"): URL | null {
  const match = raw.replace(/\.git$/, "").match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\/tree\/([^/]+)\/?(.*))?$/i);
  if (!match) return null;
  const branch = match[3] ?? ref;
  const suffix = match[4] ? `${match[4].replace(/^\/+|\/+$/g, "")}/` : "";
  return new URL(`https://raw.githubusercontent.com/${match[1]}/${match[2]}/${branch}/${suffix}`);
}

function pluginRoot(source: MarketplacePlugin["source"], marketplaceUrl: URL): URL | null {
  if (typeof source === "string") {
    return githubRawRoot(source) ?? new URL(source.replace(/\/?$/, "/"), marketplaceUrl);
  }
  if (!source?.url) return null;
  return githubRawRoot(source.url, source.ref ?? "main") ?? new URL(source.url.replace(/\/?$/, "/"), marketplaceUrl);
}

function pluginSource(plugin: MarketplacePlugin): string | undefined {
  if (typeof plugin.source === "string") return plugin.source;
  return plugin.source?.url;
}

function joinSkillSource(base: string | undefined, path: string | undefined): string | undefined {
  if (!base) return undefined;
  if (!path) return base;
  const clean = path.replace(/^\.\//, "").replace(/^\/+/, "");
  const github = base.replace(/\.git$/, "").match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)\/?.*)?$/i);
  if (github) return `https://github.com/${github[1]}/${github[2]}/tree/${github[3] ?? "HEAD"}/${clean}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(base)) return `${base}/${clean}`;
  try { return new URL(clean, `${base.replace(/\/$/, "")}/`).toString(); }
  catch { return `${base.replace(/\/$/, "")}/${clean}`; }
}

export function pluginSkills(plugin: MarketplacePlugin, opts: { base?: string; paths?: string[]; repository?: string } = {}): McpStoreSkill[] {
  const base = pluginSource(plugin) ?? opts.repository;
  const declared = plugin.skills;
  const entries: Array<{ name?: string; path?: string }> = [];
  if (typeof declared === "string") entries.push({ path: declared });
  else if (Array.isArray(declared)) {
    for (const item of declared) {
      if (typeof item === "string") entries.push({ path: item });
      else if (item && typeof item === "object") {
        const value = item as Record<string, unknown>;
        entries.push({ name: typeof value.name === "string" ? value.name : undefined, path: typeof value.path === "string" ? value.path : undefined });
      }
    }
  }
  if (!entries.length && opts.paths?.length) {
    for (const path of opts.paths.filter((value) => /(?:^|\/)SKILL\.md$/i.test(value))) {
      const relative = opts.base && path.startsWith(`${opts.base}/`) ? path.slice(opts.base.length + 1) : path;
      entries.push({ path: relative });
    }
  }
  return entries.flatMap((entry) => {
    const source = joinSkillSource(base, [opts.base, entry.path].filter(Boolean).join("/") || undefined);
    if (!source) return [];
    const name = entry.name || (entry.path ?? plugin.name ?? "skill").split("/").filter(Boolean).slice(-2, -1)[0] || plugin.name || "skill";
    return [{ name, description: plugin.description, source }];
  });
}

export function pluginServer(
  plugin: MarketplacePlugin,
  storeId: McpStoreSourceId,
  skills: McpStoreSkill[],
  hooks?: AgentHooksByEvent,
): McpStoreServer {
  return {
    name: `plugin/${plugin.name ?? "plugin"}`,
    title: plugin.name ?? "Plugin",
    description: plugin.description ?? "",
    version: "latest",
    repository: pluginSource(plugin) ? { url: pluginSource(plugin) } : undefined,
    storeId,
    skills: skills.length ? skills : undefined,
    hooks,
    isPlugin: true,
    pluginName: plugin.name,
    installKinds: [],
  };
}

function entryToStoreServer(
  entry: ParsedMcpEntry,
  plugin: MarketplacePlugin,
  storeId: McpStoreSourceId,
  skills: McpStoreSkill[] = [],
  hooks?: AgentHooksByEvent,
): McpStoreServer {
  const environmentVariables = Object.keys(entry.env ?? {}).map((name) => ({
    name,
    isRequired: true,
    isSecret: /token|secret|password|key/i.test(name),
  }));
  const remotes: McpStoreRemote[] | undefined = entry.kind === "http" ? [{
    type: "http",
    url: entry.mcpUrl!,
    headers: Object.keys(entry.headers ?? {}).map((name) => ({
      name,
      isRequired: true,
      isSecret: /authorization|token|secret|key/i.test(name),
    })),
  }] : undefined;
  const packageIdentifier = entry.args?.find((arg) => !arg.startsWith("-")) ?? entry.command!;
  const packages: McpStorePackage[] | undefined = entry.kind === "stdio" ? [{
    registryType: entry.packageManager ?? "binary",
    identifier: packageIdentifier,
    runtimeHint: entry.command,
    transport: { type: "stdio" },
    packageArguments: (entry.args ?? [])
      .filter((value) => value !== packageIdentifier && value !== "-y")
      .map((value) => ({ value })),
    environmentVariables,
  }] : undefined;
  return {
    name: `${plugin.name ?? "plugin"}/${entry.key}`,
    title: entry.name,
    description: plugin.description ?? "",
    version: "latest",
    remotes,
    packages,
    category: plugin.category,
    storeId,
    skills: skills.length ? skills : undefined,
    hooks,
    isPlugin: true,
    pluginName: plugin.name,
    installKinds: classifyInstallKinds({ remotes, packages }),
  };
}

async function loadPluginHooksFromFiles(
  files: string[],
  readJson: (path: string) => Promise<unknown>,
  pluginRoot: string,
  pluginManifest: Record<string, unknown> | null,
): Promise<AgentHooksByEvent | undefined> {
  const candidates: string[] = [];
  const declared = pluginManifest?.hooks;
  if (typeof declared === "string") candidates.push(joinRepoPath(pluginRoot, declared));
  else if (Array.isArray(declared)) {
    for (const item of declared) {
      if (typeof item === "string") candidates.push(joinRepoPath(pluginRoot, item));
    }
  } else if (declared && typeof declared === "object") {
    const inline = parseHooksJson(declared);
    if (Object.keys(inline).length) return inline;
  }
  candidates.push(joinRepoPath(pluginRoot, "hooks/hooks.json"));
  for (const path of candidates) {
    const normalized = path.replace(/^\/+/, "");
    if (!files.includes(normalized)) continue;
    try {
      const parsed = parseHooksJson(await readJson(normalized));
      if (Object.keys(parsed).length) return parsed;
    } catch {
      /* next */
    }
  }
  return undefined;
}

function skillPathsFromFiles(files: string[], pluginRoot: string): string[] {
  const prefix = pluginRoot ? `${pluginRoot.replace(/\/$/, "")}/` : "";
  return files.filter(
    (path) =>
      path.startsWith(prefix) &&
      /(?:^|\/)skills\/[^/]+\/SKILL\.md$/i.test(path),
  );
}

export async function parseMarketplaceSource(input: {
  sourceUrl: string;
  format: MarketplaceFormat;
  storeId: McpStoreSourceId;
}): Promise<{ name: string; description: string; format: Exclude<MarketplaceFormat, "auto">; manifest: unknown; servers: McpStoreServer[] }> {
  const sourceUrl = await assertMarketplaceUrl(input.sourceUrl);
  const manifest = await fetchMarketplaceJson(sourceUrl);
  const root = record(manifest);
  const plugins = Array.isArray(root?.plugins) ? root.plugins.map(record).filter((item): item is Record<string, unknown> => !!item) : [];
  if (!root || !plugins.length) throw new Error("无法识别商店清单：缺少 plugins 数组");
  const detected = typeof root.$schema === "string" && root.$schema.includes("anthropic.com") ? "claude" : "codex";
  const format = input.format === "auto" ? detected : input.format;
  const servers: McpStoreServer[] = [];

  for (const rawPlugin of plugins) {
    const plugin = rawPlugin as MarketplacePlugin;
    const rootUrl = pluginRoot(plugin.source, sourceUrl);
    let pluginManifest: Record<string, unknown> | null = null;
    let config: unknown = plugin.mcpServers;
    if (rootUrl) {
      const manifestPaths = format === "claude"
        ? [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]
        : [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"];
      for (const path of manifestPaths) {
        try {
          pluginManifest = record(await fetchMarketplaceJson(new URL(path, rootUrl)));
          if (!config && pluginManifest?.mcpServers) config = pluginManifest.mcpServers;
          if (pluginManifest) break;
        } catch { /* try the other manifest convention */ }
      }
      if (!config) {
        try { config = await fetchMarketplaceJson(new URL(".mcp.json", rootUrl)); }
        catch { /* plugin has no MCP contribution */ }
      }
    }
    if (typeof config === "string" && rootUrl) {
      try { config = await fetchMarketplaceJson(new URL(config, rootUrl)); }
      catch { config = undefined; }
    }

    const skills = pluginSkills(plugin, {
      base: rootUrl ? String(rootUrl) : undefined,
      repository: rootUrl ? String(rootUrl) : pluginSource(plugin),
    });
    let hooks: AgentHooksByEvent | undefined;
    if (pluginManifest?.hooks) hooks = parseHooksJson(pluginManifest.hooks);
    if (!hooks && plugin.hooks) hooks = parseHooksJson(plugin.hooks);
    if (!hooks && rootUrl) {
      try {
        hooks = parseHooksJson(await fetchMarketplaceJson(new URL("hooks/hooks.json", rootUrl)));
      } catch { /* optional */ }
    }

    let mcpCount = 0;
    if (config) {
      try {
        for (const entry of parseEditorMcpConfig(config)) {
          servers.push(entryToStoreServer(entry, plugin, input.storeId, skills, hooks));
          mcpCount += 1;
        }
      } catch { /* non-MCP declaration */ }
    }
    if (mcpCount === 0 && (skills.length || (hooks && Object.keys(hooks).length))) {
      servers.push(pluginServer(plugin, input.storeId, skills, hooks));
    }
  }

  return {
    name: typeof root.name === "string" ? root.name : "Imported store",
    description: typeof root.description === "string" ? root.description : "",
    format,
    manifest,
    servers,
  };
}

async function parseRepositoryFiles(input: {
  files: string[];
  readJson: (path: string) => Promise<unknown>;
  storeId: McpStoreSourceId;
  fallbackName: string;
}): Promise<{ name: string; description: string; format: "codex" | "claude"; manifest: unknown; servers: McpStoreServer[] }> {
  const marketplacePaths = input.files.filter((path) =>
    /(?:^|\/)(?:marketplace|plugins?)\.json$/i.test(path) ||
    /\.(?:claude|codex)-plugin\/marketplace\.json$/i.test(path),
  );
  let marketplace: Record<string, unknown> | null = null;
  let marketplacePath = "";
  for (const path of marketplacePaths) {
    try {
      const candidate = record(await input.readJson(path));
      if (Array.isArray(candidate?.plugins)) {
        marketplace = candidate;
        marketplacePath = path;
        break;
      }
    } catch { /* inspect next candidate */ }
  }

  const claude = typeof marketplace?.$schema === "string" && marketplace.$schema.includes("anthropic.com") ||
    input.files.some((path) => path.includes(".claude-plugin/"));
  const format = claude ? "claude" : "codex";
  const servers: McpStoreServer[] = [];
  const seenConfigs = new Set<string>();
  const plugins = Array.isArray(marketplace?.plugins)
    ? marketplace.plugins.map(record).filter((plugin): plugin is Record<string, unknown> => !!plugin)
    : [];

  const addConfig = async (
    path: string,
    plugin: MarketplacePlugin,
    skills: McpStoreSkill[],
    hooks?: AgentHooksByEvent,
  ) => {
    const normalized = path.replace(/^\/+/, "");
    if (seenConfigs.has(normalized) || !input.files.includes(normalized)) return 0;
    seenConfigs.add(normalized);
    try {
      const config = await input.readJson(normalized);
      let n = 0;
      for (const entry of parseEditorMcpConfig(config)) {
        servers.push(entryToStoreServer(entry, plugin, input.storeId, skills, hooks));
        n += 1;
      }
      return n;
    } catch {
      return 0;
    }
  };

  for (const raw of plugins) {
    const plugin = raw as MarketplacePlugin;
    const source = typeof plugin.source === "string"
      ? plugin.source
      : record(plugin.source)?.url && typeof record(plugin.source)?.url === "string"
        ? String(record(plugin.source)?.url)
        : undefined;
    const base = source && !source.includes("://")
      ? joinRepoPath(posixDir(marketplacePath), source)
      : "";
    const manifests = [
      joinRepoPath(base, ".codex-plugin/plugin.json"),
      joinRepoPath(base, ".claude-plugin/plugin.json"),
    ];
    let declared: unknown = plugin.mcpServers;
    let pluginManifest: Record<string, unknown> | null = null;
    for (const manifestPath of manifests) {
      if (!input.files.includes(manifestPath)) continue;
      try {
        pluginManifest = record(await input.readJson(manifestPath));
        declared ??= pluginManifest?.mcpServers;
      } catch { /* continue */ }
    }

    const skillFilePaths = skillPathsFromFiles(input.files, base);
    const skills = pluginSkills(plugin, {
      base,
      paths: skillFilePaths,
      repository: pluginSource(plugin) ?? base,
    });
    const hooks = await loadPluginHooksFromFiles(input.files, input.readJson, base, pluginManifest);

    let mcpCount = 0;
    if (typeof declared === "string") {
      mcpCount += await addConfig(joinRepoPath(base, declared), plugin, skills, hooks);
    } else if (declared) {
      try {
        for (const entry of parseEditorMcpConfig(declared)) {
          servers.push(entryToStoreServer(entry, plugin, input.storeId, skills, hooks));
          mcpCount += 1;
        }
      } catch { /* ignore malformed declaration */ }
    } else {
      mcpCount += await addConfig(joinRepoPath(base, ".mcp.json"), plugin, skills, hooks);
    }
    if (mcpCount === 0 && (skills.length || (hooks && Object.keys(hooks).length))) {
      servers.push(pluginServer(plugin, input.storeId, skills, hooks));
    }
  }

  const pluginManifestPaths = input.files.filter((path) => /(?:^|\/)\.(?:codex|claude)-plugin\/plugin\.json$/i.test(path));
  for (const manifestPath of pluginManifestPaths) {
    const root = posixDir(posixDir(manifestPath));
    let manifest: Record<string, unknown> | null = null;
    try { manifest = record(await input.readJson(manifestPath)); } catch { /* ignore */ }
    const plugin: MarketplacePlugin = {
      name: typeof manifest?.name === "string" ? manifest.name : root.split("/").pop() || input.fallbackName,
      description: typeof manifest?.description === "string" ? manifest.description : undefined,
      skills: manifest?.skills,
      hooks: manifest?.hooks,
    };
    const skills = pluginSkills(plugin, {
      base: root,
      paths: skillPathsFromFiles(input.files, root),
      repository: root,
    });
    const hooks = await loadPluginHooksFromFiles(input.files, input.readJson, root, manifest);
    let mcpCount = 0;
    if (typeof manifest?.mcpServers === "string") {
      mcpCount += await addConfig(joinRepoPath(root, manifest.mcpServers), plugin, skills, hooks);
    } else if (manifest?.mcpServers) {
      try {
        for (const entry of parseEditorMcpConfig(manifest.mcpServers)) {
          servers.push(entryToStoreServer(entry, plugin, input.storeId, skills, hooks));
          mcpCount += 1;
        }
      } catch { /* ignore */ }
    } else {
      mcpCount += await addConfig(joinRepoPath(root, ".mcp.json"), plugin, skills, hooks);
    }
    if (mcpCount === 0 && (skills.length || (hooks && Object.keys(hooks).length))) {
      servers.push(pluginServer(plugin, input.storeId, skills, hooks));
    }
  }

  for (const configPath of input.files.filter((path) => /(?:^|\/)\.mcp\.json$/i.test(path))) {
    await addConfig(configPath, { name: posixDir(configPath).split("/").pop() || input.fallbackName }, []);
  }

  const unique = new Map(servers.map((server) => [`${server.name}:${server.installKinds.join(",")}`, server]));
  return {
    name: typeof marketplace?.name === "string" ? marketplace.name : input.fallbackName,
    description: typeof marketplace?.description === "string" ? marketplace.description : "",
    format,
    manifest: marketplace ?? { repository: input.fallbackName },
    servers: [...unique.values()],
  };
}

export async function parseMarketplaceRepository(input: { repository: string; storeId: McpStoreSourceId }) {
  const repository = normalizeGitRepository(input.repository);
  const fallbackName = repository.replace(/\.git\/?$/, "").split("/").pop() || "Imported store";
  return withGitRepository(repository, (files, readJson) => parseRepositoryFiles({
    files,
    readJson,
    storeId: input.storeId,
    fallbackName,
  }));
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || `mcp-${Date.now().toString(36)}`
  );
}

function classifyInstallKinds(server: {
  remotes?: McpStoreRemote[];
  packages?: McpStorePackage[];
  installHint?: string;
}): McpStoreServer["installKinds"] {
  const kinds = new Set<McpStoreServer["installKinds"][number]>();
  for (const r of server.remotes ?? []) {
    if (r.url && (r.type.includes("http") || r.type.includes("sse"))) {
      kinds.add("http");
    }
  }
  for (const p of server.packages ?? []) {
    if (p.transport?.type && p.transport.type !== "stdio") continue;
    if (p.registryType === "npm") kinds.add("stdio-npm");
    else if (p.registryType === "pypi") kinds.add("stdio-pypi");
    else if (p.registryType === "oci") kinds.add("stdio-oci");
    else kinds.add("stdio-other");
  }
  if (!kinds.size && server.installHint) {
    if (/\bnpx\b|\bnpm\b/i.test(server.installHint)) kinds.add("stdio-npm");
    else if (/\buvx\b|\bpipx?\b/i.test(server.installHint)) kinds.add("stdio-pypi");
    else kinds.add("stdio-other");
  }
  return [...kinds];
}

function normalizeOfficialEntry(
  raw: {
    server: {
      name: string;
      title?: string;
      description?: string;
      version?: string;
      repository?: { url?: string; source?: string };
      remotes?: McpStoreRemote[];
      packages?: McpStorePackage[];
    };
    _meta?: { "io.modelcontextprotocol.registry/official"?: { status?: string } };
  },
  storeId: McpStoreSourceId = "official-registry",
): McpStoreServer {
  const s = raw.server;
  return {
    name: s.name,
    title: s.title,
    description: s.description ?? "",
    version: s.version ?? "latest",
    repository: s.repository,
    remotes: s.remotes,
    packages: s.packages,
    status: raw._meta?.["io.modelcontextprotocol.registry/official"]?.status,
    storeId,
    registryName: s.name,
    installKinds: classifyInstallKinds(s),
  };
}

function parseNpxHint(hint: string): { command: string; args: string[] } | null {
  const m = hint.match(/`((?:npx|uvx|npm exec)[^`]+)`/i) || hint.match(/\b((?:npx|uvx)\s+-y\s+[^\s`]+(?:\s+[^\s`]+)*)/i);
  if (!m?.[1]) return null;
  const parts = m[1].trim().split(/\s+/);
  const command = parts[0]!;
  return { command, args: parts.slice(1) };
}

export class McpStoreService {
  private readonly db: Db | null;
  private readonly config: AppConfig;

  constructor(db: Db, config: AppConfig);
  constructor(config: AppConfig);
  constructor(dbOrConfig: Db | AppConfig, config?: AppConfig) {
    this.db = config ? dbOrConfig as Db : null;
    this.config = config ?? dbOrConfig as AppConfig;
  }

  private requireDb(): Db {
    if (!this.db) throw new Error("MCP 商店持久化需要数据库连接");
    return this.db;
  }

  private cacheDir(): string {
    const dir = join(this.config.dataDir, "mcp-store");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private cachePath(storeId: McpStoreId): string {
    return join(this.cacheDir(), `${storeId}.json`);
  }

  private marketCachePath(marketId: string): string {
    const safe = marketId.replace(/[^a-zA-Z0-9._-]+/g, "_");
    return join(this.cacheDir(), `market-${safe}.json`);
  }

  private readMarketCache(marketId: string): MarketCacheFile | null {
    const path = this.marketCachePath(marketId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as MarketCacheFile;
    } catch {
      return null;
    }
  }

  private writeMarketCache(marketId: string, servers: McpStoreServer[]) {
    const payload: MarketCacheFile = {
      fetchedAt: new Date().toISOString(),
      marketId,
      servers,
    };
    writeFileSync(this.marketCachePath(marketId), JSON.stringify(payload));
  }

  private marketCacheFresh(marketId: string, force?: boolean): MarketCacheFile | null {
    if (force) return null;
    const cached = this.readMarketCache(marketId);
    if (!cached?.fetchedAt) return null;
    const age = Date.now() - Date.parse(cached.fetchedAt);
    // 插件市场 24h 刷新
    if (Number.isFinite(age) && age < 24 * 60 * 60 * 1000) return cached;
    return cached?.servers.length ? cached : null;
  }

  /** 同步内置插件市场（Claude / Cursor 等 git marketplace） */
  async syncPluginMarket(
    marketId: string,
    repository: string,
    opts?: { force?: boolean; format?: MarketplaceFormat },
  ): Promise<{ count: number; fetchedAt: string; fromCache: boolean; error?: string }> {
    const storeId = `market:${marketId}` as McpStoreSourceId;
    const fresh = this.marketCacheFresh(marketId, opts?.force);
    if (fresh) {
      return { count: fresh.servers.length, fetchedAt: fresh.fetchedAt, fromCache: true };
    }
    try {
      const parsed = await parseMarketplaceRepository({
        repository: normalizeGitRepository(repository),
        storeId,
      });
      this.writeMarketCache(marketId, parsed.servers);
      return {
        count: parsed.servers.length,
        fetchedAt: new Date().toISOString(),
        fromCache: false,
      };
    } catch (err) {
      const cached = this.readMarketCache(marketId);
      return {
        count: cached?.servers.length ?? 0,
        fetchedAt: cached?.fetchedAt ?? "",
        fromCache: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  listPluginMarketServers(marketId: string): McpStoreServer[] {
    return this.readMarketCache(marketId)?.servers ?? [];
  }

  async ensurePluginMarket(
    marketId: string,
    repository: string,
    opts?: { force?: boolean },
  ): Promise<McpStoreServer[]> {
    const result = await this.syncPluginMarket(marketId, repository, opts);
    if (result.error && !result.count) {
      throw new Error(result.error);
    }
    return this.listPluginMarketServers(marketId);
  }

  private async customRows(tenantId: string) {
    return this.requireDb().select().from(mcpStoreSources).where(and(
      eq(mcpStoreSources.tenantId, tenantId),
      eq(mcpStoreSources.enabled, true),
    ));
  }

  private customMeta(row: typeof mcpStoreSources.$inferSelect): McpStoreMeta {
    return {
      id: `custom:${row.id}`,
      name: row.name,
      url: row.sourceUrl,
      description: row.description,
      syncable: true,
      format: row.format as MarketplaceFormat,
      removable: true,
    };
  }

  private customServers(row: typeof mcpStoreSources.$inferSelect): McpStoreServer[] {
    try { return JSON.parse(row.serversJson) as McpStoreServer[]; }
    catch { return []; }
  }

  async listSources(tenantId: string): Promise<McpStoreMeta[]> {
    const custom = await this.customRows(tenantId);
    return [
      ...MCP_STORES.map((source) => ({ ...source, format: "builtin" as const, removable: false })),
      ...custom.map((row) => this.customMeta(row)),
    ];
  }

  async importSource(tenantId: string, input: {
    name?: string;
    sourceUrl: string;
    format?: MarketplaceFormat;
  }): Promise<McpStoreMeta & { count: number }> {
    const id = newId();
    const parsed = await parseMarketplaceSource({
      sourceUrl: input.sourceUrl,
      format: input.format ?? "auto",
      storeId: `custom:${id}`,
    });
    const name = input.name?.trim() || parsed.name;
    if (!name) throw new Error("商店名称不能为空");
    const now = new Date();
    const [row] = await this.requireDb().insert(mcpStoreSources).values({
      id,
      tenantId,
      name,
      description: parsed.description,
      sourceUrl: input.sourceUrl,
      format: parsed.format,
      manifestJson: JSON.stringify(parsed.manifest),
      serversJson: JSON.stringify(parsed.servers),
      fetchedAt: now,
      updatedAt: now,
    }).returning();
    if (!row) throw new Error("保存商店失败");
    return { ...this.customMeta(row), count: parsed.servers.length };
  }

  async importRepository(tenantId: string, repository: string): Promise<McpStoreMeta & { count: number }> {
    const id = newId();
    const sourceUrl = normalizeGitRepository(repository);
    const parsed = await parseMarketplaceRepository({ repository: sourceUrl, storeId: `custom:${id}` });
    if (!parsed.servers.length) throw new Error("仓库中没有发现 MCP 配置（.mcp.json 或插件 mcpServers 声明）");
    const now = new Date();
    const [row] = await this.requireDb().insert(mcpStoreSources).values({
      id,
      tenantId,
      name: parsed.name,
      description: parsed.description,
      sourceUrl,
      format: parsed.format,
      manifestJson: JSON.stringify(parsed.manifest),
      serversJson: JSON.stringify(parsed.servers),
      fetchedAt: now,
      updatedAt: now,
    }).returning();
    if (!row) throw new Error("保存商店失败");
    return { ...this.customMeta(row), count: parsed.servers.length };
  }

  async syncCustomSource(tenantId: string, sourceId: McpStoreSourceId): Promise<{ storeId: McpStoreSourceId; count: number; fetchedAt: string; fromCache: false }> {
    const id = sourceId.startsWith("custom:") ? sourceId.slice(7) : "";
    const [row] = await this.requireDb().select().from(mcpStoreSources).where(and(
      eq(mcpStoreSources.id, id),
      eq(mcpStoreSources.tenantId, tenantId),
    ));
    if (!row) throw new Error("商店不存在");
    const parsed = row.sourceUrl.endsWith(".json")
      ? await parseMarketplaceSource({ sourceUrl: row.sourceUrl, format: row.format as MarketplaceFormat, storeId: sourceId })
      : await parseMarketplaceRepository({ repository: row.sourceUrl, storeId: sourceId });
    const now = new Date();
    await this.requireDb().update(mcpStoreSources).set({
      description: parsed.description,
      format: parsed.format,
      manifestJson: JSON.stringify(parsed.manifest),
      serversJson: JSON.stringify(parsed.servers),
      fetchedAt: now,
      updatedAt: now,
    }).where(and(eq(mcpStoreSources.id, id), eq(mcpStoreSources.tenantId, tenantId)));
    return { storeId: sourceId, count: parsed.servers.length, fetchedAt: now.toISOString(), fromCache: false };
  }

  async deleteSource(tenantId: string, sourceId: string): Promise<boolean> {
    if (!sourceId.startsWith("custom:")) return false;
    const [existing] = await this.requireDb().select({ id: mcpStoreSources.id }).from(mcpStoreSources).where(and(
      eq(mcpStoreSources.id, sourceId.slice(7)),
      eq(mcpStoreSources.tenantId, tenantId),
    ));
    if (!existing) return false;
    await this.requireDb().delete(mcpStoreSources).where(and(
      eq(mcpStoreSources.id, sourceId.slice(7)),
      eq(mcpStoreSources.tenantId, tenantId),
    ));
    return true;
  }

  private readCache(storeId: McpStoreId): CacheFile | null {
    const path = this.cachePath(storeId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    } catch {
      return null;
    }
  }

  private writeCache(storeId: McpStoreId, servers: McpStoreServer[]) {
    const payload: CacheFile = {
      fetchedAt: new Date().toISOString(),
      storeId,
      servers,
    };
    writeFileSync(this.cachePath(storeId), JSON.stringify(payload), "utf8");
  }

  private cacheFresh(storeId: McpStoreId, force?: boolean): CacheFile | null {
    if (force) return null;
    const cached = this.readCache(storeId);
    if (!cached) return null;
    if (Date.now() - new Date(cached.fetchedAt).getTime() < 60 * 60 * 1000) {
      return cached;
    }
    return null;
  }

  /** Sync one or more stores; default = all syncable */
  async sync(opts?: {
    stores?: McpStoreId[];
    force?: boolean;
    maxPages?: number;
  }): Promise<{
    results: Array<{
      storeId: McpStoreId;
      count: number;
      fetchedAt: string;
      fromCache: boolean;
      error?: string;
    }>;
  }> {
    const targets: McpStoreId[] = opts?.stores?.length
      ? opts.stores
      : MCP_STORES.filter((s) => s.syncable && isBuiltinMcpStoreId(s.id)).map((s) => s.id as McpStoreId);
    const results: Array<{
      storeId: McpStoreId;
      count: number;
      fetchedAt: string;
      fromCache: boolean;
      error?: string;
    }> = [];

    for (const storeId of targets) {
      try {
        const r = await this.syncStore(storeId, opts);
        results.push({ storeId, ...r });
      } catch (err) {
        results.push({
          storeId,
          count: this.readCache(storeId)?.servers.length ?? 0,
          fetchedAt: this.readCache(storeId)?.fetchedAt ?? "",
          fromCache: true,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { results };
  }

  async syncStore(
    storeId: McpStoreId,
    opts?: { force?: boolean; maxPages?: number },
  ): Promise<{ count: number; fetchedAt: string; fromCache: boolean }> {
    if (!isBuiltinMcpStoreId(storeId)) throw new Error(`未知的内置商店: ${storeId}`);
    const fresh = this.cacheFresh(storeId, opts?.force);
    if (fresh) {
      return { count: fresh.servers.length, fetchedAt: fresh.fetchedAt, fromCache: true };
    }

    let servers: McpStoreServer[] = [];
    switch (storeId) {
      case "github-mcp":
        servers = await this.fetchGithubMcp();
        break;
      case "official-registry":
        servers = await this.fetchOfficial(opts?.maxPages ?? 25);
        break;
      case "awesome-mcp":
        servers = await this.fetchAwesome();
        break;
      case "mcpservers-org":
        servers = await this.fetchMcpserversOrg();
        break;
      default:
        throw new Error(`Unknown store: ${storeId}`);
    }

    this.writeCache(storeId, servers);
    return {
      count: servers.length,
      fetchedAt: new Date().toISOString(),
      fromCache: false,
    };
  }

  /** GitHub MCP Registry — https://github.com/mcp */
  private async fetchGithubMcp(): Promise<McpStoreServer[]> {
    const first = await this.fetchGithubMcpPage(1);
    const totalPages = Math.max(1, first.totalPages);
    const all = [...first.servers];

    for (let page = 2; page <= totalPages; page++) {
      const next = await this.fetchGithubMcpPage(page);
      all.push(...next.servers);
    }

    const byName = new Map<string, McpStoreServer>();
    for (const s of all) {
      if (!byName.has(s.name)) byName.set(s.name, s);
    }
    return [...byName.values()];
  }

  private async fetchGithubMcpPage(page: number): Promise<{
    servers: McpStoreServer[];
    totalPages: number;
  }> {
    const url = `${GITHUB_MCP_REGISTRY}?page=${page}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Zakura-mcp-store/0.2",
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      throw new Error(`GitHub MCP registry HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      payload?: {
        mcpRegistryRoute?: {
          serversData?: {
            servers?: Array<{
              id?: string;
              name?: string;
              display_name?: string;
              description?: string;
              url?: string;
              created_at?: string;
              stargazer_count?: number;
              topics?: string[];
              full_name?: string;
              name_with_owner?: string;
              repository?: { url?: string; source?: string };
            }>;
            metadata?: { total_pages?: number; total?: number };
          };
        };
      };
    };

    const data = body.payload?.mcpRegistryRoute?.serversData;
    const servers: McpStoreServer[] = (data?.servers ?? []).map((raw) => {
      const registryName = raw.full_name || raw.id || raw.name || "";
      const title = raw.display_name || raw.name_with_owner || registryName;
      const repoUrl = raw.repository?.url || raw.url;
      return {
        name: registryName || raw.name_with_owner || title,
        title,
        description: raw.description ?? "",
        version: raw.created_at || "latest",
        repository: repoUrl ? { url: repoUrl, source: "github" } : undefined,
        storeId: "github-mcp",
        registryName: registryName || undefined,
        stars: raw.stargazer_count,
        topics: raw.topics,
        // Install metadata resolved lazily from GitHub detail / Official Registry
        installKinds: [],
      };
    });

    return {
      servers,
      totalPages: data?.metadata?.total_pages ?? 1,
    };
  }

  private async fetchOfficial(maxPages: number): Promise<McpStoreServer[]> {
    const servers: McpStoreServer[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const url = new URL(`${OFFICIAL_REGISTRY}/v0.1/servers`);
      url.searchParams.set("version", "latest");
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("cursor", cursor);

      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        throw new Error(`Official registry HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const body = (await res.json()) as {
        servers?: Array<Parameters<typeof normalizeOfficialEntry>[0]>;
        metadata?: { nextCursor?: string };
      };
      for (const entry of body.servers ?? []) {
        servers.push(normalizeOfficialEntry(entry, "official-registry"));
      }
      cursor = body.metadata?.nextCursor;
      if (!cursor) break;
    }

    const byName = new Map<string, McpStoreServer>();
    for (const s of servers) {
      if (!byName.has(s.name)) byName.set(s.name, s);
    }
    return [...byName.values()];
  }

  private async fetchAwesome(): Promise<McpStoreServer[]> {
    const res = await fetch(AWESOME_README, {
      headers: { Accept: "text/plain" },
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`Awesome README HTTP ${res.status}`);
    const text = await res.text();

    let category = "General";
    const servers: McpStoreServer[] = [];
    const seen = new Set<string>();

    for (const line of text.split("\n")) {
      const catMatch = line.match(/^###?\s+(.+)$/);
      if (catMatch) {
        category = catMatch[1]!
          .replace(/<[^>]+>/g, "")
          .replace(/🔗|#\w+/g, "")
          .trim() || category;
        continue;
      }

      const linkMatch = line.match(
        /^\s*-\s*\[([^\]]+)\]\((https:\/\/github\.com\/[^)\s]+)\)\s*(.*)$/,
      );
      if (!linkMatch) continue;

      const label = linkMatch[1]!.trim();
      const repoUrl = linkMatch[2]!.replace(/\.git$/, "");
      const rest = linkMatch[3] ?? "";
      const ownerRepo = repoUrl.replace(/^https:\/\/github\.com\//, "");
      if (seen.has(ownerRepo)) continue;
      seen.add(ownerRepo);

      const hintMatch = rest.match(/`((?:npx|uvx|npm exec)[^`]+)`/i);
      const installHint = hintMatch?.[1];
      const description = rest
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/`[^`]+`/g, "")
        .replace(/[^\x00-\x7F]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const packages: McpStorePackage[] = [];
      if (installHint) {
        const parsed = parseNpxHint(`\`${installHint}\``);
        if (parsed) {
          const pkgId = parsed.args.find((a) => a !== "-y") ?? "";
          if (pkgId && parsed.command === "npx") {
            packages.push({
              registryType: "npm",
              identifier: pkgId,
              transport: { type: "stdio" },
              runtimeArguments: parsed.args.filter((a) => a === "-y").map((v) => ({ value: v })),
              packageArguments: parsed.args
                .filter((a) => a !== "-y" && a !== pkgId)
                .map((v) => ({ value: v })),
            });
          } else if (pkgId && parsed.command === "uvx") {
            packages.push({
              registryType: "pypi",
              identifier: pkgId,
              transport: { type: "stdio" },
              packageArguments: parsed.args
                .filter((a) => a !== pkgId)
                .map((v) => ({ value: v })),
            });
          }
        }
      }

      const name = `github.com/${ownerRepo}`;
      const [owner, repo] = ownerRepo.split("/");
      servers.push({
        name,
        title: label.includes("/") ? label.split("/").pop() : label,
        description: description || label,
        version: "latest",
        repository: { url: repoUrl, source: "github" },
        packages: packages.length ? packages : undefined,
        storeId: "awesome-mcp",
        registryName: owner && repo ? `io.github.${owner}/${repo}` : undefined,
        category,
        installHint,
        installKinds: classifyInstallKinds({ packages, installHint }),
      });
    }

    return servers;
  }

  /**
   * MCP Servers 中文站 — no stable public API; seed from Official Registry search terms
   * popular on the Chinese portal, so items remain installable.
   */
  private async fetchMcpserversOrg(): Promise<McpStoreServer[]> {
    const keywords = [
      "filesystem",
      "github",
      "browser",
      "postgres",
      "sqlite",
      "memory",
      "fetch",
      "puppeteer",
      "playwright",
      "notion",
      "slack",
      "docker",
      "kubernetes",
      "search",
      "time",
      "everything",
      "sequential",
      "brave",
      "firecrawl",
      "context7",
    ];

    const byName = new Map<string, McpStoreServer>();
    for (const q of keywords) {
      const url = new URL(`${OFFICIAL_REGISTRY}/v0.1/servers`);
      url.searchParams.set("search", q);
      url.searchParams.set("version", "latest");
      url.searchParams.set("limit", "20");
      try {
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as {
          servers?: Array<Parameters<typeof normalizeOfficialEntry>[0]>;
        };
        for (const entry of body.servers ?? []) {
          const normalized = normalizeOfficialEntry(entry, "mcpservers-org");
          normalized.category = q;
          if (!byName.has(normalized.name)) byName.set(normalized.name, normalized);
        }
      } catch {
        /* skip keyword */
      }
    }
    return [...byName.values()];
  }

  async search(opts: {
    tenantId: string;
    q?: string;
    kind?: "http" | "stdio" | "all";
    store?: McpStoreSourceId | "all";
    limit?: number;
    offset?: number;
  }): Promise<{
    total: number;
    items: McpStoreServer[];
    fetchedAt: string | null;
    sources: McpStoreMeta[];
    storeCounts: Record<string, number>;
  }> {
    const storeFilter = opts.store ?? "all";
    const custom = await this.customRows(opts.tenantId);
    const customById = new Map(custom.map((row) => [`custom:${row.id}` as McpStoreSourceId, row]));
    const sources = await this.listSources(opts.tenantId);
    const storeIds: McpStoreSourceId[] = storeFilter === "all" ? sources.map((s) => s.id) : [storeFilter];

    // Ensure at least one cache exists for requested stores
    for (const id of storeIds) {
      if (!isBuiltinMcpStoreId(id)) continue;
      if (!this.readCache(id)) {
        try {
          await this.syncStore(id, { maxPages: id === "official-registry" ? 8 : 25 });
        } catch {
          /* empty */
        }
      }
    }

    let items: McpStoreServer[] = [];
    let fetchedAt: string | null = null;
    const storeCounts: Record<string, number> = {};

    for (const source of sources) {
      if (source.id.startsWith("custom:")) {
        const row = customById.get(source.id);
        storeCounts[source.id] = row ? this.customServers(row).length : 0;
        const at = row?.fetchedAt?.toISOString() ?? null;
        if (at && (!fetchedAt || at > fetchedAt)) fetchedAt = at;
      } else {
        if (!isBuiltinMcpStoreId(source.id)) continue;
        const cache = this.readCache(source.id);
        storeCounts[source.id] = cache?.servers.length ?? 0;
        if (cache?.fetchedAt && (!fetchedAt || cache.fetchedAt > fetchedAt)) {
          fetchedAt = cache.fetchedAt;
        }
      }
    }

    for (const id of storeIds) {
      if (id.startsWith("custom:")) {
        const row = customById.get(id);
        if (row) items.push(...this.customServers(row));
      } else {
        if (!isBuiltinMcpStoreId(id)) continue;
        const cache = this.readCache(id);
        if (cache) items.push(...cache.servers);
      }
    }

    const q = (opts.q ?? "").trim().toLowerCase();
    const kind = opts.kind ?? "all";

    if (q) {
      items = items.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.title?.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.topics?.some((t) => t.toLowerCase().includes(q)) ||
          s.category?.toLowerCase().includes(q),
      );
    }

    if (kind === "http") {
      items = items.filter(
        (s) => !s.installKinds.length || s.installKinds.includes("http"),
      );
    } else if (kind === "stdio") {
      items = items.filter(
        (s) =>
          !s.installKinds.length ||
          s.installKinds.some((k) => k.startsWith("stdio")),
      );
    }

    // Prefer starred / GitHub curated order within mixed results
    if (storeFilter === "all") {
      items.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
    }

    const offset = opts.offset ?? 0;
    const limit = Math.min(opts.limit ?? 40, 100);
    return {
      total: items.length,
      items: items.slice(offset, offset + limit),
      fetchedAt,
      sources,
      storeCounts,
    };
  }

  async getServer(name: string, storeId?: McpStoreSourceId, tenantId?: string): Promise<McpStoreServer | null> {
    if (storeId?.startsWith("custom:")) {
      if (!tenantId) return null;
      const [row] = await this.requireDb().select().from(mcpStoreSources).where(and(
        eq(mcpStoreSources.id, storeId.slice(7)),
        eq(mcpStoreSources.tenantId, tenantId),
      ));
      const hit = row ? this.customServers(row).find((server) => server.name === name || server.title === name) : undefined;
      return hit ? this.enrichForInstall(hit) : null;
    }
    if (storeId?.startsWith("market:")) {
      const marketId = storeId.slice("market:".length);
      const hit = this.listPluginMarketServers(marketId).find(
        (s) => s.name === name || s.registryName === name || s.title === name || s.pluginName === name,
      );
      return hit ? this.enrichForInstall(hit) : null;
    }
    const stores: McpStoreId[] = storeId && isBuiltinMcpStoreId(storeId)
      ? [storeId]
      : MCP_STORES.map((s) => s.id).filter(isBuiltinMcpStoreId);
    for (const id of stores) {
      const cache = this.readCache(id);
      const hit = cache?.servers.find(
        (s) => s.name === name || s.registryName === name || s.title === name,
      );
      if (hit) return this.enrichForInstall(hit);
    }

    // Fallback: official registry direct
    const encoded = encodeURIComponent(name);
    const res = await fetch(`${OFFICIAL_REGISTRY}/v0.1/servers/${encoded}/versions/latest`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Parameters<typeof normalizeOfficialEntry>[0];
    return normalizeOfficialEntry(body);
  }

  /** Prefer GitHub MCP detail raw_data; fall back to Official Registry / installHint */
  async enrichForInstall(server: McpStoreServer): Promise<McpStoreServer> {
    if (
      (server.packages?.length || server.remotes?.length) &&
      server.storeId !== "github-mcp" &&
      server.storeId !== "awesome-mcp"
    ) {
      return {
        ...server,
        installKinds: classifyInstallKinds(server),
      };
    }
    if (server.packages?.length || server.remotes?.length) {
      return {
        ...server,
        installKinds: classifyInstallKinds(server),
      };
    }

    // GitHub MCP detail pages embed full packages/remotes in raw_data.server
    if (server.storeId === "github-mcp") {
      const fromGithub = await this.fetchGithubMcpDetail(server);
      if (fromGithub) return fromGithub;
    }

    const candidates = [server.registryName, server.name].filter(
      (x): x is string => !!x,
    );

    const repoMatch = server.repository?.url?.match(/github\.com\/([^/]+)\/([^/#?]+)/);
    if (repoMatch) {
      candidates.push(`io.github.${repoMatch[1]}/${repoMatch[2]}`);
      candidates.push(`${repoMatch[1]}/${repoMatch[2]}`);
    }

    for (const candidate of candidates) {
      try {
        const encoded = encodeURIComponent(candidate);
        const res = await fetch(
          `${OFFICIAL_REGISTRY}/v0.1/servers/${encoded}/versions/latest`,
          {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!res.ok) continue;
        const body = (await res.json()) as Parameters<typeof normalizeOfficialEntry>[0];
        const detailed = normalizeOfficialEntry(body, server.storeId);
        return {
          ...server,
          remotes: detailed.remotes?.length ? detailed.remotes : server.remotes,
          packages: detailed.packages?.length ? detailed.packages : server.packages,
          version: detailed.version || server.version,
          installKinds: classifyInstallKinds({
            remotes: detailed.remotes ?? server.remotes,
            packages: detailed.packages ?? server.packages,
            installHint: server.installHint,
          }),
          registryName: detailed.name,
        };
      } catch {
        /* try next */
      }
    }

    // Last resort: parse installHint into packages
    if (server.installHint && !server.packages?.length) {
      const parsed = parseNpxHint(`\`${server.installHint}\``);
      if (parsed) {
        const pkgId = parsed.args.find((a) => a !== "-y");
        if (pkgId) {
          const packages: McpStorePackage[] =
            parsed.command === "uvx"
              ? [
                  {
                    registryType: "pypi",
                    identifier: pkgId,
                    runtimeHint: "uvx",
                    transport: { type: "stdio" },
                  },
                ]
              : [
                  {
                    registryType: "npm",
                    identifier: pkgId,
                    transport: { type: "stdio" },
                    runtimeArguments: [{ value: "-y" }],
                  },
                ];
          return {
            ...server,
            packages,
            installKinds: classifyInstallKinds({ packages, installHint: server.installHint }),
          };
        }
      }
    }

    return {
      ...server,
      installKinds: classifyInstallKinds(server),
    };
  }

  /** https://github.com/mcp/{owner}/{repo} → raw_data.server packages/remotes */
  private async fetchGithubMcpDetail(
    server: McpStoreServer,
  ): Promise<McpStoreServer | null> {
    const pathCandidates = new Set<string>();
    const pushPath = (v?: string) => {
      if (!v) return;
      // microsoft/markitdown or github/github-mcp-server
      if (/^[^/]+\/[^/]+$/.test(v) && !v.startsWith("io.")) {
        pathCandidates.add(v);
        return;
      }
      // io.github.github/github-mcp-server → github/github-mcp-server
      const io = v.match(/^io\.github\.([^/]+)\/(.+)$/);
      if (io) pathCandidates.add(`${io[1]}/${io[2]}`);
    };
    pushPath(server.name);
    pushPath(server.registryName);
    const repoMatch = server.repository?.url?.match(/github\.com\/([^/]+)\/([^/#?]+)/);
    if (repoMatch) pathCandidates.add(`${repoMatch[1]}/${repoMatch[2]}`);

    for (const path of pathCandidates) {
      try {
        const res = await fetch(`${GITHUB_MCP_REGISTRY}/${path}`, {
          headers: {
            Accept: "application/json",
            "User-Agent": "Zakura-mcp-store/0.2",
          },
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as {
          payload?: {
            mcpDetailsRoute?: {
              server_data?: {
                display_name?: string;
                description?: string;
                stargazer_count?: number;
                topics?: string[];
                full_name?: string;
                raw_data?: {
                  server?: {
                    name?: string;
                    title?: string;
                    description?: string;
                    version?: string;
                    packages?: McpStorePackage[];
                    remotes?: McpStoreRemote[];
                    repository?: { url?: string; source?: string };
                  };
                };
              };
            };
          };
        };
        const sd = body.payload?.mcpDetailsRoute?.server_data;
        const rawServer = sd?.raw_data?.server;
        if (!rawServer) continue;
        const packages = rawServer.packages ?? [];
        const remotes = rawServer.remotes ?? [];
        return {
          ...server,
          title: server.title || sd?.display_name || rawServer.title,
          description: server.description || sd?.description || rawServer.description || "",
          version: rawServer.version || server.version,
          repository: rawServer.repository ?? server.repository,
          packages: packages.length ? packages : server.packages,
          remotes: remotes.length ? remotes : server.remotes,
          stars: sd?.stargazer_count ?? server.stars,
          topics: sd?.topics ?? server.topics,
          registryName: rawServer.name || server.registryName,
          installKinds: classifyInstallKinds({
            packages: packages.length ? packages : server.packages,
            remotes: remotes.length ? remotes : server.remotes,
            installHint: server.installHint,
          }),
        };
      } catch {
        /* try next path */
      }
    }
    return null;
  }

  buildInstallPreview(server: McpStoreServer): InstallPreviewOption[] {
    return previewFromPackagesAndRemotes({
      packages: server.packages,
      remotes: server.remotes,
      installHint: server.installHint,
    });
  }

  buildInstallPlan(
    server: McpStoreServer,
    opts?: {
      prefer?: "http" | "stdio";
      remoteUrl?: string;
      env?: Record<string, string>;
      packageIndex?: number;
    },
  ): McpInstallPlan {
    // 有可运行 package（npm/pypi/oci）时默认走 stdio，避免 Markitdown 等
    // 同时声明空/不可用 HTTP remote 时误选 generic-mcp 触发 Empty SSE。
    const prefer =
      opts?.prefer ??
      (server.packages?.length
        ? "stdio"
        : server.remotes?.length
          ? "http"
          : "stdio");
    const displayName = server.title || server.name.split("/").pop() || server.name;
    const slug = slugify(server.name.split("/").pop() || server.name);
    const userEnv = opts?.env ?? {};

    if (
      prefer === "http" ||
      (!server.packages?.length && server.remotes?.length)
    ) {
      const remote =
        (opts?.remoteUrl
          ? server.remotes?.find((r) => r.url === opts.remoteUrl)
          : undefined) ??
        server.remotes?.find((r) => r.type.includes("http")) ??
        server.remotes?.[0];
      if (!remote?.url) {
        throw new Error(
          "该 MCP 暂无可用的 HTTP remote。可改选 Stdio 安装，或确认 Official Registry 已收录。",
        );
      }
      return {
        kind: "http",
        providerId: "generic-mcp",
        name: displayName,
        slug,
        config: {
          mcpUrl: normalizeRemoteUrl(remote.url),
          apiKey: userEnv.API_KEY || userEnv.Bearer || "",
          headerName: "Authorization",
        },
        envHints: [],
      };
    }

    const pkg =
      opts?.packageIndex != null
        ? server.packages?.[opts.packageIndex]
        : server.packages?.find((p) => p.registryType === "npm") ??
          server.packages?.find((p) => p.registryType === "pypi") ??
          server.packages?.find((p) => p.registryType !== "oci") ??
          server.packages?.[0];
    if (!pkg) {
      throw new Error(
        "该 MCP 没有可安装的 package。请换 Official Registry / GitHub MCP 中有安装元数据的条目。",
      );
    }

    const envHints = pkg.environmentVariables ?? [];
    const env: Record<string, string> = {};
    for (const hint of envHints) {
      if (userEnv[hint.name] != null) env[hint.name] = userEnv[hint.name]!;
      else if (hint.default != null) env[hint.name] = hint.default;
    }

    if (pkg.registryType === "npm") {
      const runtimeArgs = (pkg.runtimeArguments ?? [])
        .map((a) => a.value)
        .filter((v): v is string => !!v);
      const packageArgs = (pkg.packageArguments ?? [])
        .map((a) => a.value)
        .filter((v): v is string => !!v);
      return {
        kind: "stdio",
        providerId: "stdio-mcp",
        name: displayName,
        slug,
        config: {
          command: pkg.runtimeHint === "node" ? "node" : "npx",
          args: JSON.stringify(
            pkg.runtimeHint === "node"
              ? [pkg.identifier, ...packageArgs]
              : dedupeNpxArgs(pkg.identifier, runtimeArgs, packageArgs),
          ),
          env: JSON.stringify(env),
          image: DEFAULT_NODE_IMAGE,
          workingDir: "/data",
          packageManager: "npm",
        },
        envHints,
      };
    }

    if (pkg.registryType === "pypi") {
      const packageArgs = (pkg.packageArguments ?? [])
        .map((a) => a.value)
        .filter((v): v is string => !!v);
      return {
        kind: "stdio",
        providerId: "stdio-mcp",
        name: displayName,
        slug,
        config: {
          command: pkg.runtimeHint && pkg.runtimeHint !== "uvx" ? pkg.runtimeHint : "uvx",
          args: JSON.stringify([pkg.identifier, ...packageArgs]),
          env: JSON.stringify(env),
          image: DEFAULT_PYTHON_IMAGE,
          workingDir: "/data",
          packageManager: "pypi",
        },
        envHints,
      };
    }

    if (pkg.registryType === "oci") {
      const dockerArgs = buildOciDockerArgs(pkg);
      return {
        kind: "stdio",
        providerId: "stdio-mcp",
        name: displayName,
        slug,
        config: {
          command: "docker",
          args: JSON.stringify(dockerArgs),
          env: JSON.stringify(env),
          image: DEFAULT_NODE_IMAGE,
          workingDir: "/data",
          packageManager: "oci",
        },
        envHints,
      };
    }

    throw new Error(`暂不支持的 package 类型: ${pkg.registryType}`);
  }
}

/** Expand registry package/runtime argument descriptors into docker CLI argv. */
function expandRegistryArgs(
  items: NonNullable<McpStorePackage["runtimeArguments"]> | undefined,
): string[] {
  const out: string[] = [];
  for (const a of items ?? []) {
    const type = (a.type ?? "positional").toLowerCase();
    const value = a.value ?? a.default;
    if (type === "named" && a.name) {
      const flag = a.name;
      // Skip flags we always inject ourselves for stdio bridging
      if (flag === "-i" || flag === "--interactive" || flag === "-it" || flag === "--rm") {
        continue;
      }
      // Boolean named flags: presence means true when value is empty/"true"
      if (value == null || value === "" || value === "true") {
        out.push(flag);
        continue;
      }
      if (value === "false") continue;
      out.push(flag, String(value));
      continue;
    }
    if (value != null && value !== "") out.push(String(value));
  }
  return out;
}

/**
 * Build `docker run -i --rm … <image> …` args for OCI MCP packages.
 * The outer stdio-mcp container mounts docker.sock and runs this via the bridge.
 */
function buildOciDockerArgs(pkg: McpStorePackage): string[] {
  const args = ["run", "-i", "--rm"];
  // Forward env vars that the inner MCP image needs (set on outer container, passed through)
  for (const hint of pkg.environmentVariables ?? []) {
    if (!hint.name) continue;
    args.push("-e", hint.name);
  }
  args.push(...expandRegistryArgs(pkg.runtimeArguments));
  args.push(pkg.identifier);
  args.push(...expandRegistryArgs(pkg.packageArguments));
  return args;
}

function dedupeNpxArgs(
  identifier: string,
  runtimeArgs: string[],
  packageArgs: string[],
): string[] {
  const out = ["-y"];
  for (const a of runtimeArgs) {
    if (a && a !== "-y" && a !== identifier) out.push(a);
  }
  out.push(identifier);
  for (const a of packageArgs) {
    if (a) out.push(a);
  }
  return out;
}

function normalizeRemoteUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.toLowerCase();
    let path = u.pathname.replace(/\/+$/, "") || "/";
    if (host === "mcp.notion.com" && (path === "/" || path === "/sse")) path = "/mcp";
    if (host === "mcp.supabase.com" && (path === "/" || path === "")) path = "/mcp";
    u.pathname = path;
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw;
  }
}
