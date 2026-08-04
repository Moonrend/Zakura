/**
 * 统一连接目录：聚合平台集成、MCP 商店、技能商店与精选条目。
 * install 分发到现有 Orchestrator / Skills / IntegrationCatalog。
 */
import { decryptJson, globalRegistry } from "@zakura/core";
import {
  BUILTIN_MARKETS,
  CURATED_OAUTH_MCPS,
  type ConnectionInstallRequest,
  type ConnectionInstallResult,
  type ConnectionKind,
  type ConnectionListing,
  type ConnectionSourceMeta,
  type InstalledConnection,
  type StorePackageDetail,
  type StorePackageListResult,
} from "@zakura/shared";
import { and, eq } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  agentBindings,
  agentSkills,
  componentInstances,
  skills,
} from "../db/schema.js";
import type { IntegrationCatalogService } from "./integration-catalog.js";
import type { McpStoreService } from "./mcp-store.js";
import type { Orchestrator } from "./orchestrator.js";
import type { SkillsService } from "./skills/index.js";
import type { AgentService } from "./agents.js";
import { ConnectionPackageService, splitStoreRef } from "./connection-packages.js";

const CAPABILITY_PROVIDER_IDS = new Set(["web-search", "web-fetch"]);

function kindFromProvider(providerId: string, config: Record<string, unknown>): ConnectionKind {
  if (providerId === "stdio-mcp") return "mcp-stdio";
  if (providerId === "generic-mcp") return "mcp-http";
  if (typeof config.mcpUrl === "string" && String(config.mcpUrl).startsWith("zakura://")) {
    return "platform";
  }
  return "mcp-http";
}

function parseInstallRef(source: string): { kind: string; rest: string } {
  const idx = source.indexOf(":");
  if (idx <= 0) return { kind: "auto", rest: source };
  return { kind: source.slice(0, idx), rest: source.slice(idx + 1) };
}

export class ConnectionCatalogService {
  readonly packages: ConnectionPackageService;

  constructor(
    private readonly db: Db,
    private readonly appConfig: AppConfig,
    private readonly mcpStore: McpStoreService,
    private readonly skills: SkillsService,
    private readonly integrations: IntegrationCatalogService,
    private readonly orchestrator: Orchestrator,
    private readonly agents: AgentService,
    catalog?: import("./store-catalog.js").StoreCatalogService | null,
  ) {
    this.packages = new ConnectionPackageService(
      db,
      appConfig,
      mcpStore,
      skills,
      integrations,
      catalog ?? null,
    );
  }

  async listPackages(opts: {
    tenantId: string;
    source: string;
    q?: string;
    repo?: string;
    limit?: number;
    offset?: number;
  }): Promise<StorePackageListResult> {
    return this.packages.listPackages(opts);
  }

  async getPackage(tenantId: string, packageId: string): Promise<StorePackageDetail | null> {
    return this.packages.getPackage(tenantId, packageId);
  }

  async listSources(tenantId: string): Promise<ConnectionSourceMeta[]> {
    const mcpSources = await this.mcpStore.listSources(tenantId);
    const builtin: ConnectionSourceMeta[] = [
      {
        id: "all",
        name: "全部",
        description: "聚合所有内置与自定义市场；也可点选左侧单个市场单独浏览",
        kind: "builtin",
      },
      ...BUILTIN_MARKETS.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        kind: "builtin" as const,
        format: (m.kind === "plugin-repo"
          ? m.format === "claude" || m.format === "codex"
            ? m.format
            : "auto"
          : m.kind === "skill-repo" || m.kind === "skill-store"
            ? "skill"
            : m.kind === "mcp-curated" || m.kind === "mcp-registry"
              ? "mcp"
              : "auto") as ConnectionSourceMeta["format"],
        url: m.repository ? `https://github.com/${m.repository}` : undefined,
      })),
    ];
    const custom: ConnectionSourceMeta[] = mcpSources
      .filter((s) => s.id.startsWith("custom:"))
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description ?? "自定义插件市场",
        kind: "custom" as const,
        format: (s.format === "codex" || s.format === "claude" ? s.format : "auto") as
          | "auto"
          | "codex"
          | "claude",
        url: s.url,
      }));
    return [...builtin, ...custom];
  }

  async search(opts: {
    tenantId: string;
    q?: string;
    source?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ total: number; items: ConnectionListing[] }> {
    const source = opts.source ?? "all";
    const q = (opts.q ?? "").trim().toLowerCase();
    const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const items: ConnectionListing[] = [];

    if (source === "all" || source === "platform") {
      const packages = await this.integrations.list(opts.tenantId);
      for (const pkg of packages) {
        const connector = pkg.components.find((c) => c.kind === "connector");
        const rawFields = (connector?.config as {
          fields?: Array<{
            key: string;
            label: string;
            type: "text" | "secret" | "textarea" | "url";
            required?: boolean;
            placeholder?: string;
          }>;
        })?.fields;
        if (!q || pkg.name.toLowerCase().includes(q) || pkg.description.toLowerCase().includes(q)) {
          items.push({
            id: `platform:${pkg.slug}`,
            name: pkg.name,
            description: pkg.description,
            kind: "platform",
            source: "platform",
            auth: "connector",
            needsRunner: false,
            icon: pkg.icon ?? undefined,
            verified: pkg.verified,
            featured: pkg.featured,
            homepage: pkg.homepage ?? undefined,
            installRef: `platform:${pkg.slug}`,
            packageSlug: pkg.slug,
            connectorId: connector?.id,
            credentialFields: rawFields?.map((f) => ({
              key: f.key,
              label: f.label,
              type: f.type === "textarea" ? "text" : f.type === "url" ? "url" : f.type === "secret" ? "secret" : "text",
              required: f.required,
              placeholder: f.placeholder,
            })),
          });
        }
        for (const component of pkg.components) {
          if (component.kind === "tool") {
            const mcpUrl = (component.config as { mcpUrl?: string }).mcpUrl;
            if (!mcpUrl) continue;
            if (q && !component.name.toLowerCase().includes(q) && !component.description.toLowerCase().includes(q)) {
              continue;
            }
            items.push({
              id: `platform-tool:${pkg.slug}:${component.ref}`,
              name: component.name,
              description: component.description,
              kind: "platform",
              source: "platform",
              auth: "oauth",
              needsRunner: false,
              installRef: `zakura:${mcpUrl.replace(/^zakura:\/\//, "")}`,
              packageSlug: pkg.slug,
            });
          }
          if (component.kind === "skill") {
            const skillSource = (component.config as { source?: string }).source;
            if (!skillSource) continue;
            if (q && !component.name.toLowerCase().includes(q)) continue;
            items.push({
              id: `platform-skill:${component.ref}`,
              name: component.name,
              description: component.description,
              kind: "skill",
              source: "platform",
              auth: "none",
              needsRunner: false,
              installRef: skillSource,
            });
          }
        }
      }
    }

    if (source === "all" || source === "mcp-official") {
      for (const mcp of CURATED_OAUTH_MCPS) {
        if (q && !mcp.name.toLowerCase().includes(q) && !(mcp.description ?? "").toLowerCase().includes(q)) {
          continue;
        }
        items.push({
          id: `curated:${mcp.id}`,
          name: mcp.name,
          description: mcp.description,
          kind: mcp.kind === "stdio" ? "mcp-stdio" : "mcp-http",
          source: "mcp-official",
          auth: mcp.auth,
          needsRunner: mcp.kind === "stdio",
          icon: mcp.icon,
          tags: mcp.tags,
          docsUrl: mcp.docsUrl,
          installRef: `curated:${mcp.id}`,
        });
      }
    }

    if (
      source === "all" ||
      source === "mcp" ||
      source === "mcp-community" ||
      source === "plugin" ||
      source.startsWith("custom:")
    ) {
      const store =
        source.startsWith("custom:")
          ? source
          : source === "plugin"
            ? "all"
            : source === "all" || source === "mcp" || source === "mcp-community"
              ? "all"
              : source;
      const result = await this.mcpStore.search({
        tenantId: opts.tenantId,
        q: opts.q,
        store: store as "all",
        limit: 80,
        offset: 0,
      });
      for (const server of result.items) {
        if (source === "plugin" && !server.isPlugin && !server.storeId.startsWith("custom:")) {
          // 插件市场优先展示自定义源与明确标记为插件的条目；仍显示带捆绑的商店项
          if (!server.skills?.length && !server.hooks) continue;
        }
        const hasStdio = server.installKinds.some((k) => k.startsWith("stdio")) || !!server.packages?.length;
        const hasHttp = server.installKinds.includes("http") || !!server.remotes?.length;
        const kind: ConnectionKind = server.isPlugin
          ? "plugin"
          : hasStdio && !hasHttp
            ? "mcp-stdio"
            : hasStdio
              ? "plugin"
              : "mcp-http";
        items.push({
          id: `mcp:${server.storeId}:${server.name}`,
          name: server.title || server.name,
          description: server.description,
          kind,
          source: server.storeId,
          auth: hasHttp ? "oauth" : "none",
          needsRunner: hasStdio,
          docsUrl: server.repository?.url,
          bundledSkills: server.skills?.map((s) => ({ name: s.name, source: s.source })),
          bundledHookEvents: server.hooks ? Object.keys(server.hooks) : undefined,
          installRef: `mcp:${server.storeId}:${server.name}`,
        });
      }
    }

    if (source === "all" || source.startsWith("skill")) {
      const skillStoreId =
        source === "skill-builtin"
          ? "builtin"
          : source === "skill-curated"
            ? "curated"
            : source === "skill-skills-sh"
              ? "skills-sh"
              : source === "skill-github"
                ? "github"
                : "curated";
      const stores =
        source === "all" || source === "skill"
          ? (["builtin", "curated", "skills-sh"] as const)
          : [skillStoreId as "builtin" | "curated" | "skills-sh" | "github"];
      for (const store of stores) {
        const page = await this.skills.search(opts.tenantId, {
          query: opts.q ?? "",
          store,
          limit: 40,
          offset: 0,
        });
        for (const item of page.items) {
          items.push({
            id: `skill:${store}:${item.name}`,
            name: item.title || item.name,
            description: item.description,
            kind: "skill",
            source: `skill-${store}`,
            auth: "none",
            needsRunner: false,
            installRef: item.installSpec || item.source || `builtin:${item.name}`,
          });
        }
      }
    }

    const sliced = items.slice(offset, offset + limit);
    return { total: items.length, items: sliced };
  }

  async listInstalled(tenantId: string): Promise<InstalledConnection[]> {
    const [instances, skillRows, bindings, agentSkillRows] = await Promise.all([
      this.db.select().from(componentInstances).where(eq(componentInstances.tenantId, tenantId)),
      this.db.select().from(skills).where(eq(skills.tenantId, tenantId)),
      this.db.select().from(agentBindings).where(eq(agentBindings.tenantId, tenantId)),
      this.db.select().from(agentSkills).where(eq(agentSkills.tenantId, tenantId)),
    ]);

    const bindByInstance = new Map<string, string[]>();
    for (const b of bindings) {
      const list = bindByInstance.get(b.instanceId) ?? [];
      list.push(b.agentId);
      bindByInstance.set(b.instanceId, list);
    }
    const agentsBySkill = new Map<string, string[]>();
    for (const row of agentSkillRows) {
      const list = agentsBySkill.get(row.skillId) ?? [];
      list.push(row.agentId);
      agentsBySkill.set(row.skillId, list);
    }

    const out: InstalledConnection[] = [];
    for (const row of instances) {
      if (CAPABILITY_PROVIDER_IDS.has(row.providerId)) continue;
      if (
        globalRegistry.has(row.providerId) &&
        globalRegistry.get(row.providerId).category === "connector"
      ) {
        continue;
      }
      let config: Record<string, unknown> = {};
      try {
        config = decryptJson(this.appConfig.secret, row.configEnc);
      } catch {
        /* ignore */
      }
      out.push({
        id: `instance:${row.id}`,
        name: row.name,
        kind: kindFromProvider(row.providerId, config),
        status: row.status,
        providerId: row.providerId,
        slug: row.slug,
        runtimeNodeId: row.runtimeNodeId,
        endpointUrl: row.endpointUrl,
        healthStatus: row.healthStatus,
        agentIds: bindByInstance.get(row.id) ?? [],
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    }
    for (const row of skillRows) {
      out.push({
        id: `skill:${row.id}`,
        name: row.title || row.name,
        kind: "skill",
        status: "installed",
        skillName: row.name,
        builtin: row.builtin,
        autoUpdate: row.builtin ? false : Boolean(row.autoUpdate),
        agentIds: agentsBySkill.get(row.id) ?? [],
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    }
    return out;
  }

  async installPackage(
    tenantId: string,
    packageId: string,
    req: Omit<ConnectionInstallRequest, "source" | "packageId"> & { source?: string } = {},
  ): Promise<ConnectionInstallResult> {
    const detail = await this.getPackage(tenantId, packageId);
    if (!detail) throw new Error(`未找到商店包: ${packageId}`);

    const selected = new Set(req.componentIds ?? []);
    const installApp = selected.size === 0 || [...selected].some((id) => id.startsWith("app:"));
    let components = detail.components.filter((c) => c.kind !== "app");
    if (selected.size > 0 && !installApp) {
      components = components.filter((c) => selected.has(c.id));
    }
    if (!components.length) throw new Error("没有可安装的组件");

    const needsAgent = components.some((c) => c.kind === "skill" || c.kind === "hook");
    if (needsAgent && !req.agentIds?.length) {
      throw new Error("安装技能或 Hooks 需要选择至少一个 Agent");
    }

    const bundled: ConnectionInstallResult[] = [];
    for (const component of components) {
      // 避免 plugin: 递归
      if (component.installRef.startsWith("plugin:")) continue;
      try {
        const result = await this.install(tenantId, {
          source: component.installRef,
          runtimeNodeId: req.runtimeNodeId,
          agentIds: req.agentIds,
          config: req.config,
          name: component.name,
        });
        bundled.push(result);
      } catch (err) {
        bundled.push({
          id: component.id,
          kind: component.kind === "skill" ? "skill" : component.kind === "hook" ? "plugin" : "mcp-http",
          name: component.name,
          status: `error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return {
      id: detail.id,
      kind:
        detail.kind === "plugin"
          ? "plugin"
          : detail.kind === "platform"
            ? "platform"
            : detail.kind === "skill" || detail.kind === "skill-repo"
              ? "skill"
              : "mcp-http",
      name: detail.name,
      status: "installed",
      bundled,
    };
  }

  async install(
    tenantId: string,
    req: ConnectionInstallRequest,
  ): Promise<ConnectionInstallResult> {
    if (req.packageId?.trim()) {
      return this.installPackage(tenantId, req.packageId.trim(), req);
    }
    if (req.componentIds?.length && !req.source.startsWith("mcp:") && !req.source.startsWith("curated:") && !req.source.startsWith("zakura:") && !req.source.startsWith("hooks:")) {
      // 包级 installRef（plugin: / platform: / skill-repo 详情 id）
      const maybePackage = await this.getPackage(tenantId, req.source.trim()).catch(() => null);
      if (maybePackage) {
        return this.installPackage(tenantId, maybePackage.id, req);
      }
    }

    const source = req.source.trim();
    const { kind, rest } = parseInstallRef(source);

    if (kind === "plugin") {
      return this.installPackage(tenantId, `plugin:${rest}`, req);
    }

    if (kind === "hooks") {
      const parsed = splitStoreRef(rest);
      if (!parsed) throw new Error("hooks installRef 格式应为 hooks:<store>:<name>");
      const { storeId, name } = parsed;
      if (storeId.startsWith("market:")) {
        const marketId = storeId.slice("market:".length);
        const market = BUILTIN_MARKETS.find((m) => m.id === marketId);
        if (market?.repository) {
          await this.mcpStore.ensurePluginMarket(marketId, market.repository).catch(() => undefined);
        }
      }
      const server = await this.mcpStore.getServer(name, storeId as never, tenantId);
      if (!server?.hooks || !Object.keys(server.hooks).length) {
        throw new Error(`未找到 hooks: ${name}`);
      }
      const agentIds = req.agentIds ?? [];
      if (!agentIds.length) throw new Error("安装 Hooks 需要选择至少一个 Agent");
      for (const agentId of agentIds) {
        await this.agents.mergeHookPackage(tenantId, agentId, {
          id: `plugin:${server.pluginName ?? server.name}`,
          name: server.title || server.pluginName || server.name,
          source: `mcp:${storeId}:${server.name}`,
          enabled: true,
          events: server.hooks,
        });
      }
      return {
        id: `hooks:${server.pluginName ?? server.name}`,
        kind: "plugin",
        name: `${server.title || server.name} hooks`,
        status: "installed",
      };
    }

    if (kind === "curated") {
      const mcp = CURATED_OAUTH_MCPS.find((m) => m.id === rest);
      if (!mcp) throw new Error(`未知精选 MCP: ${rest}`);
      if (!mcp.mcpUrl) throw new Error("精选条目缺少 mcpUrl");
      const slug =
        req.name?.trim() ||
        mcp.id;
      const instance = await this.orchestrator.createInstance({
        tenantId,
        providerId: "generic-mcp",
        name: req.name?.trim() || mcp.name,
        slug: slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40),
        config: {
          mcpUrl: mcp.mcpUrl,
          apiKey: typeof req.config?.apiKey === "string" ? req.config.apiKey : "",
          headerName: mcp.headerName ?? "Authorization",
        },
        runtimeNodeId: null,
      });
      let authRequired = mcp.auth === "oauth";
      try {
        await this.orchestrator.startInstance(tenantId, instance.id);
        const handle = await this.orchestrator.toHandle(tenantId, instance.id);
        if (handle.config.authRequired === true) authRequired = true;
      } catch {
        /* leave stopped */
      }
      if (req.agentIds?.length) {
        for (const agentId of req.agentIds) {
          await this.agents.bindInstance(tenantId, agentId, instance.id).catch(() => undefined);
        }
      }
      return {
        id: `instance:${instance.id}`,
        kind: "mcp-http",
        name: instance.name,
        status: "running",
        authRequired,
        instanceId: instance.id,
        runtimeNodeId: null,
      };
    }

    if (kind === "mcp") {
      const parsed = splitStoreRef(rest);
      if (!parsed) throw new Error("installRef 格式应为 mcp:<store>:<name>");
      const { storeId, name } = parsed;
      if (storeId.startsWith("market:")) {
        const marketId = storeId.slice("market:".length);
        const market = BUILTIN_MARKETS.find((m) => m.id === marketId);
        if (market?.repository) {
          await this.mcpStore.ensurePluginMarket(marketId, market.repository).catch(() => undefined);
        }
      }
      const server = await this.mcpStore.getServer(name, storeId as never, tenantId);
      if (!server) throw new Error(`商店中未找到 ${name}`);

      const hasMcp =
        !!server.packages?.length ||
        !!server.remotes?.length ||
        (server.installKinds?.length ?? 0) > 0;

      const bundled: ConnectionInstallResult[] = [];
      const agentIds = req.agentIds?.length ? req.agentIds : [];

      // 纯插件：只有 skills / hooks
      if (!hasMcp && (server.skills?.length || server.hooks)) {
        if (!agentIds.length) {
          throw new Error("安装插件需要选择至少一个 Agent（用于写入 skills / hooks）");
        }
        if (server.skills?.length) {
          for (const skill of server.skills) {
            try {
              const r = await this.skills.install(tenantId, {
                source: skill.source || skill.name,
                agentIds,
              });
              for (const s of r.skills) {
                bundled.push({
                  id: `skill:${s.id}`,
                  kind: "skill",
                  name: s.name,
                  status: "installed",
                  skillId: s.id,
                });
              }
            } catch {
              /* skip */
            }
          }
        }
        if (server.hooks && Object.keys(server.hooks).length) {
          for (const agentId of agentIds) {
            await this.agents.mergeHookPackage(tenantId, agentId, {
              id: `plugin:${server.pluginName ?? server.name}`,
              name: server.title || server.pluginName || server.name,
              source: `mcp:${storeId}:${server.name}`,
              enabled: true,
              events: server.hooks,
            });
          }
          bundled.push({
            id: `hooks:${server.pluginName ?? server.name}`,
            kind: "plugin",
            name: `${server.title || server.name} hooks`,
            status: "installed",
          });
        }
        return {
          id: `plugin:${server.pluginName ?? server.name}`,
          kind: "plugin",
          name: server.title || server.name,
          status: "installed",
          bundled,
        };
      }

      const prefer =
        (typeof req.config?.prefer === "string" && (req.config.prefer === "http" || req.config.prefer === "stdio")
          ? req.config.prefer
          : undefined) ??
        (server.packages?.length ? "stdio" : "http");
      const plan = this.mcpStore.buildInstallPlan(server, {
        prefer,
        remoteUrl: typeof req.config?.remoteUrl === "string" ? req.config.remoteUrl : undefined,
        env:
          req.config?.env && typeof req.config.env === "object"
            ? (req.config.env as Record<string, string>)
            : undefined,
        packageIndex:
          typeof req.config?.packageIndex === "number" ? req.config.packageIndex : undefined,
      });
      const needsRunner = plan.providerId === "stdio-mcp";
      const instance = await this.orchestrator.createInstance({
        tenantId,
        providerId: plan.providerId,
        name: req.name?.trim() || plan.name,
        slug: plan.slug,
        config: plan.config,
        runtimeNodeId: needsRunner ? (req.runtimeNodeId ?? null) : null,
      });
      let started = false;
      let authRequired = false;
      try {
        await this.orchestrator.startInstance(tenantId, instance.id);
        started = true;
        if (plan.providerId === "generic-mcp") {
          const handle = await this.orchestrator.toHandle(tenantId, instance.id);
          authRequired = handle.config.authRequired === true;
        }
      } catch {
        /* leave */
      }
      if (agentIds.length) {
        for (const agentId of agentIds) {
          await this.agents.bindInstance(tenantId, agentId, instance.id).catch(() => undefined);
        }
      }
      if (server.skills?.length && agentIds.length) {
        for (const skill of server.skills) {
          try {
            const r = await this.skills.install(tenantId, {
              source: skill.source || skill.name,
              agentIds,
            });
            for (const s of r.skills) {
              bundled.push({
                id: `skill:${s.id}`,
                kind: "skill",
                name: s.name,
                status: "installed",
                skillId: s.id,
              });
            }
          } catch {
            /* skip bundled skill */
          }
        }
      }
      if (server.hooks && Object.keys(server.hooks).length && agentIds.length) {
        for (const agentId of agentIds) {
          await this.agents.mergeHookPackage(tenantId, agentId, {
            id: `plugin:${server.pluginName ?? server.name}`,
            name: server.title || server.pluginName || server.name,
            source: `mcp:${storeId}:${server.name}`,
            enabled: true,
            events: server.hooks,
          });
        }
        bundled.push({
          id: `hooks:${server.pluginName ?? server.name}`,
          kind: "plugin",
          name: `${server.title || server.name} hooks`,
          status: "installed",
        });
      }
      return {
        id: `instance:${instance.id}`,
        kind: server.isPlugin ? "plugin" : needsRunner ? "mcp-stdio" : "mcp-http",
        name: instance.name,
        status: started ? "running" : "stopped",
        authRequired,
        instanceId: instance.id,
        runtimeNodeId: instance.runtimeNodeId,
        bundled,
      };
    }

    if (kind === "platform") {
      // 安装平台包本身不创建实例；返回目录信息。工具用 zakura: 安装。
      const pkg = await this.integrations.get(tenantId, rest);
      if (!pkg) throw new Error(`未知平台包: ${rest}`);
      return {
        id: `platform:${pkg.slug}`,
        kind: "platform",
        name: pkg.name,
        status: "available",
      };
    }

    if (kind === "zakura") {
      const mcpUrl = `zakura://${rest}`;
      const target = await this.integrations.resolveConnectorTarget(tenantId, mcpUrl);
      if (!target) throw new Error(`无法解析平台工具: ${mcpUrl}`);
      return {
        id: `connector:${target.connectorRef}`,
        kind: "platform",
        name: target.connectorName,
        status: target.needsUserGrant && !target.authorization ? "auth_required" : "ready",
        authRequired: target.needsUserGrant && !target.authorization,
        runtimeNodeId: null,
      };
    }

    // skill / builtin / github 等：交给 SkillsService
    const skillSource =
      kind === "skill" || kind === "builtin" || kind === "github" || kind === "https" || kind === "npx"
        ? source
        : source;
    const result = await this.skills.install(tenantId, {
      source: skillSource,
      agentIds: req.agentIds,
      names: typeof req.ref === "string" ? [req.ref] : undefined,
    });
    const first = result.skills[0];
    if (!first) throw new Error("技能安装未返回结果");
    return {
      id: `skill:${first.id}`,
      kind: "skill",
      name: first.name,
      status: "installed",
      skillId: first.id,
    };
  }

  async bind(
    tenantId: string,
    connectionId: string,
    agentId: string,
  ): Promise<void> {
    if (connectionId.startsWith("connector:")) return;
    if (connectionId.startsWith("instance:")) {
      const instanceId = connectionId.slice("instance:".length);
      await this.agents.bindInstance(tenantId, agentId, instanceId);
      return;
    }
    if (connectionId.startsWith("skill:")) {
      const skillId = connectionId.slice("skill:".length);
      await this.skills.install(tenantId, { skillId, agentIds: [agentId] });
      return;
    }
    throw new Error(`无法绑定: ${connectionId}`);
  }

  async remove(tenantId: string, connectionId: string): Promise<void> {
    if (connectionId.startsWith("connector:")) return;
    if (connectionId.startsWith("instance:")) {
      const instanceId = connectionId.slice("instance:".length);
      const instance = await this.db.query.componentInstances.findFirst({
        where: and(
          eq(componentInstances.id, instanceId),
          eq(componentInstances.tenantId, tenantId),
        ),
      });
      if (!instance) throw new Error("实例不存在");
      if (instance.status === "running" || instance.status === "starting") {
        await this.orchestrator.stopInstance(tenantId, instanceId);
      }
      await this.db
        .delete(agentBindings)
        .where(and(eq(agentBindings.tenantId, tenantId), eq(agentBindings.instanceId, instanceId)));
      await this.db
        .delete(componentInstances)
        .where(and(eq(componentInstances.id, instanceId), eq(componentInstances.tenantId, tenantId)));
      return;
    }
    if (connectionId.startsWith("skill:")) {
      const skillId = connectionId.slice("skill:".length);
      await this.skills.remove(tenantId, skillId);
      return;
    }
    throw new Error(`无法删除: ${connectionId}`);
  }
}
