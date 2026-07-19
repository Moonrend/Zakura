import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import { DEFAULT_NODE_IMAGE } from "../providers/stdio-mcp.js";
import {
  previewFromPackagesAndRemotes,
  type InstallPreviewOption,
} from "../lib/mcp-install-parse.js";

const OFFICIAL_REGISTRY = "https://registry.modelcontextprotocol.io";
const GITHUB_MCP_REGISTRY = "https://github.com/mcp";
const AWESOME_README =
  "https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md";

export type McpStoreId =
  | "github-mcp"
  | "official-registry"
  | "mcpservers-org"
  | "awesome-mcp";

export type McpStoreMeta = {
  id: McpStoreId;
  name: string;
  url: string;
  description: string;
  /** Whether sync pulls installable metadata into local cache */
  syncable: boolean;
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
  storeId: McpStoreId;
  /** Official registry name used to resolve packages (e.g. io.github.microsoft/markitdown) */
  registryName?: string;
  stars?: number;
  topics?: string[];
  category?: string;
  /** Raw install hint from awesome lists, e.g. npx -y @pkg */
  installHint?: string;
  installKinds: Array<"http" | "stdio-npm" | "stdio-pypi" | "stdio-oci" | "stdio-other">;
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
  storeId: McpStoreId = "official-registry",
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
  constructor(private readonly config: AppConfig) {}

  private cacheDir(): string {
    const dir = join(this.config.dataDir, "mcp-store");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private cachePath(storeId: McpStoreId): string {
    return join(this.cacheDir(), `${storeId}.json`);
  }

  listSources(): McpStoreMeta[] {
    return MCP_STORES;
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
    const targets =
      opts?.stores?.length ? opts.stores : MCP_STORES.filter((s) => s.syncable).map((s) => s.id);
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
    q?: string;
    kind?: "http" | "stdio" | "all";
    store?: McpStoreId | "all";
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
    const storeIds: McpStoreId[] =
      storeFilter === "all" ? MCP_STORES.map((s) => s.id) : [storeFilter];

    // Ensure at least one cache exists for requested stores
    for (const id of storeIds) {
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

    for (const id of MCP_STORES.map((s) => s.id)) {
      const cache = this.readCache(id);
      storeCounts[id] = cache?.servers.length ?? 0;
      if (cache?.fetchedAt && (!fetchedAt || cache.fetchedAt > fetchedAt)) {
        fetchedAt = cache.fetchedAt;
      }
    }

    for (const id of storeIds) {
      const cache = this.readCache(id);
      if (cache) items.push(...cache.servers);
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
      sources: MCP_STORES,
      storeCounts,
    };
  }

  async getServer(name: string, storeId?: McpStoreId): Promise<McpStoreServer | null> {
    const stores = storeId ? [storeId] : MCP_STORES.map((s) => s.id);
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
    const prefer =
      opts?.prefer ??
      (server.installKinds.includes("http") && !server.packages?.length
        ? "http"
        : server.installKinds.includes("http")
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
          image: DEFAULT_NODE_IMAGE,
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
