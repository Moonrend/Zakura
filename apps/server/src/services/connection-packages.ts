/**
 * 商店包详情：把平台集成 / MCP / 技能仓库 / Codex·Claude 插件归一为 StorePackageDetail。
 * listPackages 支持 source=all 聚合分区，以及单个内置/自定义市场。
 */
import {
  BUILTIN_MARKETS,
  CURATED_OAUTH_MCPS,
  getBuiltinMarket,
  type BuiltinMarket,
  type StorePackageCard,
  type StorePackageComponent,
  type StorePackageDetail,
  type StorePackageKind,
  type StorePackageListResult,
  type StorePackageSection,
} from "@zakura/shared";
import { eq } from "drizzle-orm";
import { decryptJson } from "@zakura/core";
import type { Db } from "../db/client.js";
import { componentInstances, skills } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import type { IntegrationCatalogService } from "./integration-catalog.js";
import type { McpStoreService, McpStoreServer } from "./mcp-store.js";
import type { SkillsService } from "./skills/index.js";
import type { StoreCatalogService } from "./store-catalog.js";

const ALL_SECTION_PREVIEW = 8;

function marketLabel(source: string, fallback?: string): string {
  if (source === "all") return "全部市场";
  const builtin = getBuiltinMarket(source);
  if (builtin) return builtin.name;
  if (source.startsWith("custom:")) return fallback ?? "自定义插件市场";
  return fallback ?? source;
}

function countsFrom(components: StorePackageComponent[]): StorePackageCard["counts"] {
  const counts: StorePackageCard["counts"] = {};
  for (const c of components) {
    counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  }
  return counts;
}

/** mcp:storeId:name / plugin:storeId:name — storeId 可能含 custom: / market: */
export function splitStoreRef(rest: string): { storeId: string; name: string } | null {
  for (const prefix of ["custom:", "market:"] as const) {
    if (rest.startsWith(prefix)) {
      const after = rest.slice(prefix.length);
      const i = after.indexOf(":");
      if (i < 0) return null;
      return { storeId: `${prefix}${after.slice(0, i)}`, name: after.slice(i + 1) };
    }
  }
  const i = rest.indexOf(":");
  if (i < 0) return null;
  return { storeId: rest.slice(0, i), name: rest.slice(i + 1) };
}

function mcpServerToComponents(server: McpStoreServer): StorePackageComponent[] {
  const components: StorePackageComponent[] = [];
  const hasMcp =
    !!server.packages?.length ||
    !!server.remotes?.length ||
    (server.installKinds?.length ?? 0) > 0;

  if (hasMcp) {
    components.push({
      id: `mcp:${server.storeId}:${server.name}`,
      kind: "mcp",
      name: server.title || server.name.split("/").pop() || server.name,
      description: server.description,
      installRef: `mcp:${server.storeId}:${server.name}`,
      needsRunner: server.installKinds.some((k) => k.startsWith("stdio")) || !!server.packages?.length,
      auth: server.remotes?.length ? "oauth" : "none",
    });
  }

  for (const skill of server.skills ?? []) {
    components.push({
      id: `skill:${skill.name}`,
      kind: "skill",
      name: skill.name,
      description: skill.description,
      installRef: skill.source || skill.name,
    });
  }

  if (server.hooks && Object.keys(server.hooks).length) {
    components.push({
      id: `hooks:${server.pluginName ?? server.name}`,
      kind: "hook",
      name: "Hooks",
      description: `事件：${Object.keys(server.hooks).join(", ")}`,
      installRef: `hooks:${server.storeId}:${server.name}`,
      hookEvents: Object.keys(server.hooks),
    });
  }

  return components;
}

function pluginGroupDetail(
  pluginName: string,
  servers: McpStoreServer[],
  storeId: string,
): StorePackageDetail {
  const primary = servers[0]!;
  const components: StorePackageComponent[] = [];
  const seenSkills = new Set<string>();
  let hooksAdded = false;

  components.push({
    id: `app:${pluginName}`,
    kind: "app",
    name: pluginName,
    description: primary.description || "Codex / Claude 插件包",
    installRef: `plugin:${storeId}:${pluginName}`,
  });

  for (const server of servers) {
    const hasMcp =
      !!server.packages?.length ||
      !!server.remotes?.length ||
      (server.installKinds?.length ?? 0) > 0;
    if (hasMcp) {
      components.push({
        id: `mcp:${server.storeId}:${server.name}`,
        kind: "mcp",
        name: server.title || server.name.split("/").pop() || server.name,
        description: server.description,
        installRef: `mcp:${server.storeId}:${server.name}`,
        needsRunner:
          server.installKinds.some((k) => k.startsWith("stdio")) || !!server.packages?.length,
        auth: server.remotes?.length ? "oauth" : "none",
      });
    }
    for (const skill of server.skills ?? []) {
      if (seenSkills.has(skill.name)) continue;
      seenSkills.add(skill.name);
      components.push({
        id: `skill:${skill.name}`,
        kind: "skill",
        name: skill.name,
        description: skill.description,
        installRef: skill.source || skill.name,
      });
    }
    if (!hooksAdded && server.hooks && Object.keys(server.hooks).length) {
      hooksAdded = true;
      components.push({
        id: `hooks:${pluginName}`,
        kind: "hook",
        name: "Hooks",
        description: `事件：${Object.keys(server.hooks).join(", ")}`,
        installRef: `hooks:${storeId}:${server.name}`,
        hookEvents: Object.keys(server.hooks),
      });
    }
  }

  return {
    id: `plugin:${storeId}:${pluginName}`,
    name: pluginName,
    description: primary.description,
    summary: primary.description,
    kind: "plugin",
    source: storeId,
    sourceLabel: marketLabel(storeId.startsWith("market:") ? storeId.slice("market:".length) : storeId),
    homepage: primary.repository?.url,
    publisher: primary.storeId,
    category: primary.category,
    verified: false,
    installRef: `plugin:${storeId}:${pluginName}`,
    components,
    info: [
      {
        label: "功能",
        value: components
          .map((c) => c.kind)
          .filter((v, i, a) => a.indexOf(v) === i)
          .join(", "),
      },
      { label: "来源", value: storeId },
      ...(primary.repository?.url
        ? [{ label: "仓库", value: primary.repository.url, href: primary.repository.url }]
        : []),
    ],
  };
}

function groupPluginServers(servers: McpStoreServer[]): Map<string, McpStoreServer[]> {
  const groups = new Map<string, McpStoreServer[]>();
  for (const server of servers) {
    const key = server.pluginName || server.title || server.name;
    const list = groups.get(key) ?? [];
    list.push(server);
    groups.set(key, list);
  }
  return groups;
}

function tagSection(
  items: StorePackageCard[],
  sectionId: string,
  sectionName: string,
): StorePackageCard[] {
  return items.map((item) => ({ ...item, sectionId, sectionName }));
}

function toSection(
  id: string,
  name: string,
  description: string | undefined,
  items: StorePackageCard[],
  preview: number | null,
): StorePackageSection {
  const tagged = tagSection(items, id, name);
  const totalInSection = tagged.length;
  const sliced = preview != null ? tagged.slice(0, preview) : tagged;
  return {
    id,
    name,
    description,
    truncated: preview != null && totalInSection > preview,
    totalInSection,
    items: sliced,
  };
}

type InstalledIndex = {
  skillNames: Set<string>;
  mcpNames: Set<string>;
  mcpSlugs: Set<string>;
  mcpUrls: Set<string>;
};

export class ConnectionPackageService {
  constructor(
    private readonly db: Db,
    private readonly appConfig: AppConfig,
    private readonly mcpStore: McpStoreService,
    private readonly skills: SkillsService,
    private readonly integrations: IntegrationCatalogService,
    private readonly catalog?: StoreCatalogService | null,
  ) {}

  private async loadInstalled(tenantId: string): Promise<InstalledIndex> {
    const [instances, skillRows] = await Promise.all([
      this.db.select().from(componentInstances).where(eq(componentInstances.tenantId, tenantId)),
      this.db.select().from(skills).where(eq(skills.tenantId, tenantId)),
    ]);
    const mcpNames = new Set<string>();
    const mcpSlugs = new Set<string>();
    const mcpUrls = new Set<string>();
    for (const row of instances) {
      mcpNames.add(row.name.toLowerCase());
      mcpSlugs.add(row.slug.toLowerCase());
      if (row.endpointUrl) mcpUrls.add(row.endpointUrl.replace(/\/$/, "").toLowerCase());
      try {
        const cfg = decryptJson<Record<string, unknown>>(this.appConfig.secret, row.configEnc);
        if (typeof cfg.mcpUrl === "string") {
          mcpUrls.add(cfg.mcpUrl.replace(/\/$/, "").toLowerCase());
        }
      } catch {
        /* ignore */
      }
    }
    return {
      skillNames: new Set(skillRows.map((s) => s.name.toLowerCase())),
      mcpNames,
      mcpSlugs,
      mcpUrls,
    };
  }

  private markInstalled(card: StorePackageCard, installed: InstalledIndex): StorePackageCard {
    if (card.installed) return card;
    if (card.kind === "skill" || card.kind === "skill-repo") {
      const hit = installed.skillNames.has(card.name.toLowerCase());
      return hit ? { ...card, installed: true } : card;
    }
    if (card.kind === "curated") {
      const id = card.id.replace(/^curated:/, "");
      const mcp = CURATED_OAUTH_MCPS.find((m) => m.id === id);
      const url = mcp?.mcpUrl?.replace(/\/$/, "").toLowerCase();
      const hit =
        installed.mcpNames.has(card.name.toLowerCase()) ||
        installed.mcpSlugs.has(id) ||
        [...installed.mcpSlugs].some((s) => s.includes(id)) ||
        (!!url && installed.mcpUrls.has(url));
      return hit ? { ...card, installed: true } : card;
    }
    if (card.kind === "mcp" || card.kind === "plugin") {
      const hit =
        installed.mcpNames.has(card.name.toLowerCase()) ||
        [...installed.mcpSlugs].some((s) => card.name.toLowerCase().includes(s) || s.includes(card.name.toLowerCase().slice(0, 12)));
      return hit ? { ...card, installed: true } : card;
    }
    return card;
  }

  private async listMcpRegistry(
    tenantId: string,
    q: string,
    storeId?: string,
    opts?: { sync?: boolean },
  ): Promise<StorePackageCard[]> {
    const store = (storeId ?? "all") as never;
    // 浏览页优先读缓存，避免首屏同步官方全量 registry
    if (opts?.sync !== false && storeId && storeId !== "all") {
      try {
        if (storeId === "github-mcp" || storeId === "official-registry" || storeId === "awesome-mcp" || storeId === "mcpservers-org") {
          await this.mcpStore.syncStore(storeId, { force: false, maxPages: storeId === "official-registry" ? 8 : 25 });
        }
      } catch {
        /* use cache */
      }
    }
    const result = await this.mcpStore.search({
      tenantId,
      q,
      store,
      limit: storeId && storeId !== "all" ? 100 : 40,
      offset: 0,
    });
    return result.items
      .filter((s) => !s.isPlugin)
      .filter((s) => !storeId || storeId === "all" || s.storeId === storeId)
      .map((server) => {
        const components = mcpServerToComponents(server);
        return {
          id: `mcp:${server.storeId}:${server.name}`,
          name: server.title || server.name,
          description: server.description,
          kind: (server.isPlugin ? "plugin" : "mcp") as StorePackageKind,
          source: server.storeId,
          counts: countsFrom(components),
          needsRunner: components.some((c) => c.needsRunner),
          detailId: `mcp:${server.storeId}:${server.name}`,
        };
      });
  }

  private async packagesForMarket(
    tenantId: string,
    market: BuiltinMarket,
    q: string,
    opts?: { syncPlugins?: boolean; syncMcp?: boolean },
  ): Promise<StorePackageCard[]> {
    switch (market.kind) {
      case "platform":
        return this.listPlatform(tenantId, q);
      case "mcp-curated":
        return this.listMcpOfficial(q);
      case "mcp-registry":
        return this.listMcpRegistry(tenantId, q, market.mcpStoreId, {
          sync: opts?.syncMcp === true,
        });
      case "plugin-repo":
        return this.listPluginRepoMarket(market, q, { sync: opts?.syncPlugins !== false });
      case "skill-repo":
        return this.listSkillRepoMarket(tenantId, market.skillRepoSlug ?? "", q, true);
      case "skill-store":
        return this.listSkillStore(
          tenantId,
          market.skillStoreId ?? "builtin",
          market.id,
          q,
        );
      default:
        return [];
    }
  }

  async listPackages(opts: {
    tenantId: string;
    source: string;
    q?: string;
    repo?: string;
    limit?: number;
    offset?: number;
  }): Promise<StorePackageListResult> {
    const source = opts.source || "all";
    const q = (opts.q ?? "").trim().toLowerCase();
    const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const preview = source === "all" ? ALL_SECTION_PREVIEW : null;
    const syncPlugins = source !== "all";
    const syncMcp = source !== "all";

    // 有查询词且目录就绪：走 pg_trgm，避免扫全量缓存
    if (q && this.catalog && (source === "all" || getBuiltinMarket(source) || source.startsWith("custom:"))) {
      try {
        const hits = await this.catalog.search({
          tenantId: opts.tenantId,
          q,
          sourceId: source === "all" ? undefined : source,
          limit,
        });
        if (hits.length) {
          const installed = await this.loadInstalled(opts.tenantId);
          const items = hits.map((h) =>
            this.markInstalled(
              {
                id: h.ref,
                name: h.name,
                description: h.description,
                kind: (h.kind === "skill-repo" ? "skill-repo" : h.kind === "curated" ? "curated" : h.kind === "platform" ? "platform" : h.kind === "plugin" ? "plugin" : h.kind === "skill" ? "skill" : "mcp") as StorePackageKind,
                source: h.sourceId,
                publisher: h.meta.publisher,
                needsRunner: h.meta.needsRunner,
                counts: h.meta.counts ?? {},
                icon: h.meta.icon,
                detailId: h.meta.detailId ?? h.ref,
                sectionId: h.sourceId,
                sectionName: marketLabel(h.sourceId),
              },
              installed,
            ),
          );
          const bySource = new Map<string, StorePackageCard[]>();
          for (const item of items) {
            const sid = item.sectionId ?? item.source;
            const list = bySource.get(sid) ?? [];
            list.push(item);
            bySource.set(sid, list);
          }
          const sections = [...bySource.entries()].map(([id, list]) =>
            toSection(id, marketLabel(id), undefined, list, null),
          );
          return {
            total: items.length,
            items: items.slice(offset, offset + limit),
            sections,
            sourceLabel: marketLabel(source),
          };
        }
      } catch {
        /* fall through to live list */
      }
    }

    const sections: StorePackageSection[] = [];
    const installed = await this.loadInstalled(opts.tenantId);

    const finish = (items: StorePackageCard[]) =>
      items.map((c) => this.markInstalled(c, installed));

    if (source === "all") {
      for (const market of BUILTIN_MARKETS) {
        const items = finish(
          await this.packagesForMarket(opts.tenantId, market, q, {
            syncPlugins: false,
            syncMcp: false,
          }),
        );
        if (!items.length) continue;
        sections.push(toSection(market.id, market.name, market.description, items, preview));
      }
      const sources = await this.mcpStore.listSources(opts.tenantId);
      for (const custom of sources.filter((s) => s.id.startsWith("custom:"))) {
        const items = finish(await this.listCustomMarket(opts.tenantId, custom.id, q));
        if (!items.length) continue;
        sections.push(toSection(custom.id, custom.name, custom.description, items, preview));
      }
    } else if (source.startsWith("custom:")) {
      const meta = (await this.mcpStore.listSources(opts.tenantId)).find((s) => s.id === source);
      const items = finish(await this.listCustomMarket(opts.tenantId, source, q));
      sections.push(
        toSection(source, meta?.name ?? "自定义市场", meta?.description, items, null),
      );
    } else if (source === "mcp") {
      // 兼容旧链接：聚合四个 MCP 注册表
      for (const market of BUILTIN_MARKETS.filter((m) => m.kind === "mcp-registry")) {
        const items = finish(
          await this.packagesForMarket(opts.tenantId, market, q, { syncMcp: true }),
        );
        if (!items.length) continue;
        sections.push(toSection(market.id, market.name, market.description, items, null));
      }
    } else if (source === "plugin") {
      for (const market of BUILTIN_MARKETS.filter(
        (m) => m.group === "plugin" || m.kind === "plugin-repo",
      )) {
        const items = finish(
          await this.packagesForMarket(opts.tenantId, market, q, { syncPlugins: true }),
        );
        if (!items.length) continue;
        sections.push(toSection(market.id, market.name, market.description, items, null));
      }
      const sources = await this.mcpStore.listSources(opts.tenantId);
      for (const custom of sources.filter((s) => s.id.startsWith("custom:"))) {
        const items = finish(await this.listCustomMarket(opts.tenantId, custom.id, q));
        if (!items.length) continue;
        sections.push(toSection(custom.id, custom.name, custom.description, items, null));
      }
    } else if (source === "skill-curated" || source === "skill") {
      for (const market of BUILTIN_MARKETS.filter(
        (m) => m.kind === "skill-repo" || m.kind === "skill-store",
      )) {
        const items = finish(await this.packagesForMarket(opts.tenantId, market, q));
        if (!items.length) continue;
        sections.push(toSection(market.id, market.name, market.description, items, null));
      }
    } else {
      const market = getBuiltinMarket(source);
      if (market) {
        const items = finish(
          await this.packagesForMarket(opts.tenantId, market, q, {
            syncPlugins,
            syncMcp,
          }),
        );
        sections.push(toSection(market.id, market.name, market.description, items, null));
      }
    }

    const flat = sections.flatMap((s) => s.items);
    return {
      total: sections.reduce((sum, s) => sum + (s.totalInSection ?? s.items.length), 0),
      items: flat.slice(offset, offset + limit),
      sections,
      sourceLabel: marketLabel(source),
    };
  }

  private async listPlatform(tenantId: string, q: string): Promise<StorePackageCard[]> {
    const packages = await this.integrations.list(tenantId);
    const items: StorePackageCard[] = [];
    for (const pkg of packages) {
      if (q && !pkg.name.toLowerCase().includes(q) && !pkg.description.toLowerCase().includes(q)) {
        continue;
      }
      const components: StorePackageComponent[] = [];
      for (const c of pkg.components) {
        if (c.kind === "connector") {
          components.push({
            id: `app:${c.ref}`,
            kind: "app",
            name: c.name,
            description: c.description,
            installRef: `platform:${pkg.slug}`,
            auth: "connector",
          });
        } else if (c.kind === "tool") {
          const mcpUrl = (c.config as { mcpUrl?: string }).mcpUrl;
          components.push({
            id: `tool:${c.ref}`,
            kind: "tool",
            name: c.name,
            description: c.description,
            installRef: mcpUrl ? `zakura:${mcpUrl.replace(/^zakura:\/\//, "")}` : `platform:${pkg.slug}`,
            auth: "oauth",
            installed: c.installed,
          });
        } else if (c.kind === "skill") {
          const skillSource = (c.config as { source?: string }).source;
          components.push({
            id: `skill:${c.ref}`,
            kind: "skill",
            name: c.name,
            description: c.description,
            installRef: skillSource ?? `builtin:${c.ref}`,
            installed: c.installed,
          });
        }
      }
      items.push({
        id: `platform:${pkg.slug}`,
        name: pkg.name,
        description: pkg.description,
        kind: "platform",
        source: "platform",
        icon: pkg.icon ?? undefined,
        verified: pkg.verified,
        featured: pkg.featured,
        counts: countsFrom(components),
        detailId: `platform:${pkg.slug}`,
      });
    }
    return items;
  }

  private listMcpOfficial(q: string): StorePackageCard[] {
    return CURATED_OAUTH_MCPS.filter(
      (mcp) =>
        !q ||
        mcp.name.toLowerCase().includes(q) ||
        (mcp.description ?? "").toLowerCase().includes(q),
    ).map((mcp) => ({
      id: `curated:${mcp.id}`,
      name: mcp.name,
      description: mcp.description,
      kind: "curated" as const,
      source: "mcp-official",
      icon: mcp.icon,
      counts: { mcp: 1 },
      detailId: `curated:${mcp.id}`,
    }));
  }

  private async listPluginRepoMarket(
    market: BuiltinMarket,
    q: string,
    opts?: { sync?: boolean },
  ): Promise<StorePackageCard[]> {
    if (!market.repository) return [];
    let servers: McpStoreServer[] = this.mcpStore.listPluginMarketServers(market.id);
    if (opts?.sync !== false) {
      try {
        servers = await this.mcpStore.ensurePluginMarket(market.id, market.repository);
      } catch {
        servers = this.mcpStore.listPluginMarketServers(market.id);
      }
    }
    const items: StorePackageCard[] = [];
    for (const [pluginName, group] of groupPluginServers(servers)) {
      const detail = pluginGroupDetail(pluginName, group, `market:${market.id}`);
      if (
        q &&
        !detail.name.toLowerCase().includes(q) &&
        !(detail.description ?? "").toLowerCase().includes(q)
      ) {
        continue;
      }
      items.push({
        id: detail.id,
        name: detail.name,
        description: detail.description,
        kind: "plugin",
        source: market.id,
        publisher: market.publisher,
        counts: countsFrom(detail.components),
        needsRunner: detail.components.some((c) => c.needsRunner),
        detailId: detail.id,
      });
    }
    // 聚合页尚未同步时：放一张入口卡，避免「全部」卡死在 git clone
    if (!items.length && opts?.sync === false) {
      items.push({
        id: `market-hub:${market.id}`,
        name: market.name,
        description: market.description ?? "打开此市场以同步插件目录",
        kind: "plugin",
        source: market.id,
        publisher: market.publisher,
        counts: {},
        detailId: `plugin:market:${market.id}:${market.id}`,
      });
    }
    return items;
  }

  private async listCustomMarket(
    tenantId: string,
    sourceId: string,
    q: string,
  ): Promise<StorePackageCard[]> {
    const result = await this.mcpStore.search({
      tenantId,
      q,
      store: sourceId as never,
      limit: 500,
      offset: 0,
    });
    const items: StorePackageCard[] = [];
    for (const [pluginName, group] of groupPluginServers(result.items)) {
      const detail = pluginGroupDetail(pluginName, group, sourceId);
      items.push({
        id: detail.id,
        name: detail.name,
        description: detail.description,
        kind: "plugin",
        source: sourceId,
        counts: countsFrom(detail.components),
        needsRunner: detail.components.some((c) => c.needsRunner),
        detailId: detail.id,
      });
    }
    return items;
  }

  private async listSkillRepoMarket(
    tenantId: string,
    slug: string,
    q: string,
    asSkills: boolean,
  ): Promise<StorePackageCard[]> {
    if (!asSkills) {
      // 详情入口卡片（少用；聚合时直接列技能）
      const repos = await this.skills.listRepos();
      const repo = repos.find((r) => r.slug === slug);
      if (!repo) return [];
      return [
        {
          id: `skill-repo:${slug}`,
          name: repo.name,
          description: repo.description || `${repo.skillCount} 个技能`,
          kind: "skill-repo",
          source: `skill-repo:${slug}`,
          publisher: repo.publisher,
          counts: { skill: repo.skillCount },
          detailId: `skill-repo:${slug}`,
        },
      ];
    }

    const repos = await this.skills.listRepos();
    const repo = repos.find((r) => r.slug === slug);
    if (repo && (repo.pending || repo.skillCount === 0)) {
      try {
        await this.skills.syncRepo(slug);
      } catch {
        /* ignore */
      }
    }

    const page = await this.skills.search(tenantId, {
      query: q,
      store: "curated",
      repoSlug: slug,
      limit: 200,
      offset: 0,
    });
    return page.items.map((item) => ({
      id: `skill:curated:${item.name}`,
      name: item.title || item.name,
      description: item.description,
      kind: "skill" as const,
      source: `skill-repo:${slug}`,
      publisher: item.publisher,
      counts: { skill: 1 as const },
      detailId: `skill:curated:${item.installSpec || item.source}`,
      installed: item.installed,
    }));
  }

  private async listSkillStore(
    tenantId: string,
    storeId: "builtin" | "skills-sh" | "github",
    source: string,
    q: string,
  ): Promise<StorePackageCard[]> {
    const page = await this.skills.search(tenantId, {
      query: q,
      store: storeId,
      limit: 80,
      offset: 0,
    });
    return page.items.map((item) => ({
      id: `skill:${storeId}:${item.name}`,
      name: item.title || item.name,
      description: item.description,
      kind: "skill" as const,
      source,
      publisher: item.publisher,
      counts: { skill: 1 as const },
      detailId: `skill:${storeId}:${item.installSpec || item.source}`,
      installed: item.installed,
    }));
  }

  async getPackage(tenantId: string, packageId: string): Promise<StorePackageDetail | null> {
    const id = decodeURIComponent(packageId);
    const installed = await this.loadInstalled(tenantId);
    const mark = (detail: StorePackageDetail): StorePackageDetail => ({
      ...detail,
      components: detail.components.map((c) => {
        if (c.installed) return c;
        if (c.kind === "skill") {
          return installed.skillNames.has(c.name.toLowerCase()) ? { ...c, installed: true } : c;
        }
        if (c.kind === "mcp" || c.kind === "tool") {
          const hit =
            installed.mcpNames.has(c.name.toLowerCase()) ||
            (c.installRef.startsWith("curated:") &&
              [...installed.mcpSlugs].some((s) => s.includes(c.installRef.slice(8)))) ||
            (c.installRef.startsWith("zakura:") &&
              installed.mcpUrls.has(
                `zakura://${c.installRef.slice("zakura:".length)}`.replace(/\/$/, "").toLowerCase(),
              ));
          // also match by mcpUrl in installRef for curated via component name
          if (hit) return { ...c, installed: true };
          if (installed.mcpNames.has(c.name.toLowerCase())) return { ...c, installed: true };
        }
        return c;
      }),
    });

    if (id.startsWith("platform:")) {
      const slug = id.slice("platform:".length);
      const pkg = await this.integrations.get(tenantId, slug);
      if (!pkg) return null;
      const components: StorePackageComponent[] = [];
      for (const c of pkg.components) {
        if (c.kind === "connector") {
          components.push({
            id: `app:${c.ref}`,
            kind: "app",
            name: c.name,
            description: c.description,
            installRef: `platform:${pkg.slug}`,
            auth: "connector",
          });
        } else if (c.kind === "tool") {
          const mcpUrl = (c.config as { mcpUrl?: string }).mcpUrl;
          components.push({
            id: `tool:${c.ref}`,
            kind: "tool",
            name: c.name,
            description: c.description,
            installRef: mcpUrl ? `zakura:${mcpUrl.replace(/^zakura:\/\//, "")}` : `platform:${pkg.slug}`,
            auth: "oauth",
            installed: c.installed,
          });
        } else if (c.kind === "skill") {
          const skillSource = (c.config as { source?: string }).source;
          components.push({
            id: `skill:${c.ref}`,
            kind: "skill",
            name: c.name,
            description: c.description,
            installRef: skillSource ?? `builtin:${c.ref}`,
            installed: c.installed,
          });
        }
      }
      const summary =
        typeof (pkg.manifest as { summary?: string })?.summary === "string"
          ? (pkg.manifest as { summary: string }).summary
          : pkg.description;
      return mark({
        id,
        name: pkg.name,
        description: pkg.description,
        summary,
        icon: pkg.icon ?? undefined,
        kind: "platform",
        source: "platform",
        sourceLabel: marketLabel("platform"),
        homepage: pkg.homepage ?? undefined,
        publisher: pkg.publisher,
        category: pkg.category,
        verified: pkg.verified,
        featured: pkg.featured,
        installRef: `platform:${pkg.slug}`,
        components,
        info: [
          {
            label: "功能",
            value: components
              .map((c) => c.kind)
              .filter((v, i, a) => a.indexOf(v) === i)
              .join(" · "),
          },
          { label: "开发者", value: pkg.publisher },
          { label: "类别", value: pkg.category },
          ...(pkg.homepage ? [{ label: "网站", value: pkg.homepage, href: pkg.homepage }] : []),
        ],
      });
    }

    if (id.startsWith("curated:")) {
      const curatedId = id.slice("curated:".length);
      const mcp = CURATED_OAUTH_MCPS.find((m) => m.id === curatedId);
      if (!mcp) return null;
      return mark({
        id,
        name: mcp.name,
        description: mcp.description,
        summary: mcp.description,
        icon: mcp.icon,
        kind: "curated",
        source: "mcp-official",
        sourceLabel: marketLabel("mcp-official"),
        docsUrl: mcp.docsUrl,
        homepage: mcp.docsUrl,
        category: mcp.group,
        tags: mcp.tags,
        installRef: `curated:${mcp.id}`,
        components: [
          {
            id: `mcp:curated:${mcp.id}`,
            kind: "mcp",
            name: mcp.name,
            description: mcp.description,
            installRef: `curated:${mcp.id}`,
            auth: mcp.auth,
          },
        ],
        info: [
          { label: "功能", value: "Interactive · Read · Write" },
          { label: "鉴权", value: mcp.auth },
          ...(mcp.docsUrl ? [{ label: "文档", value: mcp.docsUrl, href: mcp.docsUrl }] : []),
        ],
      });
    }

    if (id.startsWith("skill-repo:")) {
      const slug = id.slice("skill-repo:".length);
      let repos = await this.skills.listRepos();
      let repo = repos.find((r) => r.slug === slug);
      if (!repo) return null;
      if (repo.pending || repo.skillCount === 0) {
        try {
          await this.skills.syncRepo(slug);
          repos = await this.skills.listRepos();
          repo = repos.find((r) => r.slug === slug) ?? repo;
        } catch {
          /* keep pending */
        }
      }
      const page = await this.skills.search(tenantId, {
        query: "",
        store: "curated",
        repoSlug: slug,
        limit: 200,
        offset: 0,
      });
      const components: StorePackageComponent[] = page.items.map((item) => ({
        id: `skill:${item.name}`,
        kind: "skill" as const,
        name: item.title || item.name,
        description: item.description,
        installRef: item.installSpec || item.source,
        installed: item.installed,
      }));
      return mark({
        id,
        name: repo.name,
        description: repo.description,
        summary: `${repo.skillCount || components.length} 个技能 · ${repo.publisher}`,
        kind: "skill-repo",
        source: `skill-repo:${slug}`,
        sourceLabel: marketLabel(`skill-repo:${slug}`, repo.name),
        publisher: repo.publisher,
        installRef: id,
        components,
        info: [
          { label: "功能", value: "Skills" },
          { label: "开发者", value: repo.publisher },
          { label: "技能数", value: String(repo.skillCount || components.length) },
          {
            label: "仓库",
            value: `https://github.com/${repo.slug}`,
            href: `https://github.com/${repo.slug}`,
          },
        ],
      });
    }

    if (id.startsWith("plugin:")) {
      const parsed = splitStoreRef(id.slice("plugin:".length));
      if (!parsed) return null;
      const { storeId, name: pluginName } = parsed;

      let servers: McpStoreServer[] = [];
      if (storeId.startsWith("market:")) {
        const marketId = storeId.slice("market:".length);
        const market = getBuiltinMarket(marketId);
        if (market?.repository) {
          try {
            servers = await this.mcpStore.ensurePluginMarket(marketId, market.repository);
          } catch {
            servers = this.mcpStore.listPluginMarketServers(marketId);
          }
        } else {
          servers = this.mcpStore.listPluginMarketServers(marketId);
        }
      } else {
        const result = await this.mcpStore.search({
          tenantId,
          store: storeId as never,
          limit: 500,
          offset: 0,
        });
        servers = result.items;
      }

      const matched = servers.filter(
        (s) =>
          s.pluginName === pluginName ||
          s.name === `plugin/${pluginName}` ||
          s.name === pluginName ||
          s.title === pluginName ||
          s.name.startsWith(`${pluginName}/`),
      );
      if (!matched.length) {
        const fuzzy = servers.filter(
          (s) => s.name.includes(pluginName) || (s.title ?? "").includes(pluginName),
        );
        if (!fuzzy.length) return null;
        return mark(pluginGroupDetail(pluginName, fuzzy, storeId));
      }
      return mark(pluginGroupDetail(pluginName, matched, storeId));
    }

    if (id.startsWith("mcp:")) {
      const parsed = splitStoreRef(id.slice("mcp:".length));
      if (!parsed) return null;
      const { storeId, name } = parsed;
      const server = await this.mcpStore.getServer(name, storeId as never, tenantId);
      if (!server) return null;
      const components = mcpServerToComponents(server);
      if (server.isPlugin || server.pluginName) {
        return mark(pluginGroupDetail(server.pluginName || server.name, [server], storeId));
      }
      return mark({
        id,
        name: server.title || server.name,
        description: server.description,
        summary: server.description,
        kind: "mcp",
        source: storeId,
        sourceLabel: marketLabel(storeId.startsWith("market:") ? storeId.slice(7) : "mcp"),
        homepage: server.repository?.url,
        category: server.category,
        version: server.version,
        tags: server.topics,
        installRef: `mcp:${storeId}:${server.name}`,
        components,
        info: [
          { label: "功能", value: server.installKinds.join(" · ") || "MCP" },
          { label: "版本", value: server.version || "latest" },
          ...(server.repository?.url
            ? [{ label: "仓库", value: server.repository.url, href: server.repository.url }]
            : []),
        ],
      });
    }

    if (id.startsWith("skill:")) {
      const rest = id.slice("skill:".length);
      const page = await this.skills.search(tenantId, {
        query: rest.includes(":") ? rest.split(":").slice(1).join(":") : rest,
        store: rest.startsWith("builtin")
          ? "builtin"
          : rest.startsWith("skills-sh")
            ? "skills-sh"
            : rest.startsWith("github")
              ? "github"
              : "curated",
        limit: 20,
        offset: 0,
      });
      const item =
        page.items.find((i) => i.installSpec === rest || i.name === rest.split(":").pop()) ??
        page.direct ??
        page.items[0];
      if (!item) return null;
      return mark({
        id,
        name: item.title || item.name,
        description: item.description,
        summary: item.description,
        kind: "skill",
        source: `skill-${item.store}`,
        sourceLabel: marketLabel(`skill-${item.store}`),
        publisher: item.publisher,
        homepage: item.homepage,
        installRef: item.installSpec || item.source,
        components: [
          {
            id: `skill:${item.name}`,
            kind: "skill",
            name: item.title || item.name,
            description: item.description,
            installRef: item.installSpec || item.source,
            installed: item.installed,
          },
        ],
        info: [
          { label: "功能", value: "Skill" },
          ...(item.publisher ? [{ label: "开发者", value: item.publisher }] : []),
          ...(item.homepage ? [{ label: "网站", value: item.homepage, href: item.homepage }] : []),
        ],
      });
    }

    return null;
  }
}

export type { StorePackageKind };
