import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { decryptJson, encryptJson } from "@zakura/core";
import catalog from "../catalog/integration-packages.json" with { type: "json" };
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  componentInstances,
  connectorCredentials,
  integrationComponents,
  integrationPackages,
  newId,
  skills,
} from "../db/schema.js";

export type IntegrationComponentKind = "connector" | "skill" | "tool" | "resource" | "prompt";
export type CredentialField = {
  key: string;
  label: string;
  type: "text" | "secret" | "textarea";
  required?: boolean;
  placeholder?: string;
};

type ComponentConfig = {
  credentialKind?: string;
  fields?: CredentialField[];
  docsUrl?: string;
  providerId?: string;
  mcpUrl?: string;
  connectorRef?: string;
  source?: string;
  hostPatterns?: string[];
  pathHints?: string[];
  authorizeParams?: Record<string, string>;
  [key: string]: unknown;
};

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class IntegrationCatalogService {
  constructor(private readonly db: Db, private readonly appConfig: AppConfig) {}

  async sync(): Promise<void> {
    const now = new Date();
    const catalogSlugs = catalog.map((pkg) => pkg.slug);
    if (catalogSlugs.length) {
      await this.db
        .delete(integrationPackages)
        .where(notInArray(integrationPackages.slug, catalogSlugs));
    }
    for (const pkg of catalog) {
      const [saved] = await this.db
        .insert(integrationPackages)
        .values({
          id: newId(),
          slug: pkg.slug,
          name: pkg.name,
          description: pkg.description,
          publisher: pkg.publisher,
          category: pkg.category,
          icon: pkg.icon,
          accent: pkg.accent,
          homepage: pkg.homepage,
          verified: pkg.verified,
          featured: pkg.featured ?? false,
          manifestJson: JSON.stringify(pkg.manifest ?? {}),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: integrationPackages.slug,
          set: {
            name: pkg.name,
            description: pkg.description,
            publisher: pkg.publisher,
            category: pkg.category,
            icon: pkg.icon,
            accent: pkg.accent,
            homepage: pkg.homepage,
            verified: pkg.verified,
            featured: pkg.featured ?? false,
            manifestJson: JSON.stringify(pkg.manifest ?? {}),
            updatedAt: now,
          },
        })
        .returning();
      const packageRow = saved ?? (await this.db.query.integrationPackages.findFirst({
        where: eq(integrationPackages.slug, pkg.slug),
      }));
      if (!packageRow) continue;
      const existingComponents = await this.db
        .select()
        .from(integrationComponents)
        .where(eq(integrationComponents.packageId, packageRow.id));
      const wanted = new Set(pkg.components.map((component) => `${component.kind}:${component.ref}`));
      const staleIds = existingComponents
        .filter((component) => !wanted.has(`${component.kind}:${component.ref}`))
        .map((component) => component.id);
      if (staleIds.length) {
        await this.db
          .delete(integrationComponents)
          .where(inArray(integrationComponents.id, staleIds));
      }
      for (const [sortOrder, component] of pkg.components.entries()) {
        await this.db
          .insert(integrationComponents)
          .values({
            id: newId(),
            packageId: packageRow.id,
            kind: component.kind,
            ref: component.ref,
            name: component.name,
            description: component.description,
            configJson: JSON.stringify(component.config ?? {}),
            sortOrder,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [integrationComponents.packageId, integrationComponents.kind, integrationComponents.ref],
            set: {
              name: component.name,
              description: component.description,
              configJson: JSON.stringify(component.config ?? {}),
              sortOrder,
              updatedAt: now,
            },
          });
      }
    }
  }

  async list(tenantId: string) {
    await this.sync();
    const [packages, components, instances, installedSkills] = await Promise.all([
      this.db.select().from(integrationPackages).orderBy(asc(integrationPackages.name)),
      this.db.select().from(integrationComponents).orderBy(asc(integrationComponents.sortOrder)),
      this.db.select().from(componentInstances).where(eq(componentInstances.tenantId, tenantId)),
      this.db.select().from(skills).where(eq(skills.tenantId, tenantId)),
    ]);
    const instanceConfigs = instances.map((row) => ({
      row,
      config: (() => {
        try { return decryptJson<Record<string, unknown>>(this.appConfig.secret, row.configEnc); }
        catch { return {}; }
      })(),
    }));
    const skillNames = new Set(installedSkills.map((row) => row.name));
    return packages
      .map((pkg) => {
        const children = components
          .filter((component) => component.packageId === pkg.id)
          .map((component) => {
            const config = parseJson<ComponentConfig>(component.configJson, {});
            const installed = component.kind === "skill"
              ? skillNames.has(component.ref)
              : component.kind === "tool"
                ? instanceConfigs.some(({ row, config: current }) =>
                    (config.providerId && row.providerId === config.providerId && current.product === config.product) ||
                    (config.mcpUrl && (row.endpointUrl === config.mcpUrl || current.mcpUrl === config.mcpUrl)))
                : false;
            return { ...component, config, installed };
          });
        return {
          ...pkg,
          manifest: parseJson<Record<string, unknown>>(pkg.manifestJson, {}),
          components: children,
          componentCounts: children.reduce<Record<string, number>>((counts, item) => {
            counts[item.kind] = (counts[item.kind] ?? 0) + 1;
            return counts;
          }, {}),
        };
      })
      // 平台连接器只暴露自调 API 的包（至少有一个 tool）
      .filter((pkg) => (pkg.componentCounts.tool ?? 0) > 0);
  }

  async get(tenantId: string, slug: string) {
    const packages = await this.list(tenantId);
    return packages.find((pkg) => pkg.slug === slug) ?? null;
  }

  async listConnectors(scopeKey: string) {
    await this.sync();
    const connectors = await this.db
      .select({ component: integrationComponents, pkg: integrationPackages })
      .from(integrationComponents)
      .innerJoin(integrationPackages, eq(integrationComponents.packageId, integrationPackages.id))
      .where(eq(integrationComponents.kind, "connector"))
      .orderBy(asc(integrationPackages.name));
    const ids = connectors.map((row) => row.component.id);
    const credentials = ids.length
      ? await this.db.select().from(connectorCredentials).where(and(
          eq(connectorCredentials.scopeKey, scopeKey),
          inArray(connectorCredentials.connectorId, ids),
        ))
      : [];
    const byConnector = new Map(credentials.map((row) => [row.connectorId, row]));
    // 团队视角：查出整站预配，用于锁定提示（管理员预配后团队不可自配）
    const platformCredentials =
      scopeKey !== "platform" && ids.length
        ? await this.db.select().from(connectorCredentials).where(and(
            eq(connectorCredentials.scopeKey, "platform"),
            eq(connectorCredentials.enabled, true),
            inArray(connectorCredentials.connectorId, ids),
          ))
        : [];
    const platformReady = new Set(platformCredentials.map((row) => row.connectorId));
    const packageIds = connectors.map((row) => row.pkg.id);
    const packageComponents = packageIds.length
      ? await this.db.select().from(integrationComponents).where(inArray(integrationComponents.packageId, packageIds))
      : [];
    const [instances, installedSkills] = scopeKey === "platform"
      ? [[], []]
      : await Promise.all([
          this.db.select().from(componentInstances).where(eq(componentInstances.tenantId, scopeKey)),
          this.db.select().from(skills).where(eq(skills.tenantId, scopeKey)),
        ]);
    const skillNames = new Set(installedSkills.map((row) => row.name));
    const instanceConfigs = instances.map((row) => ({
      row,
      config: (() => {
        try { return decryptJson<Record<string, unknown>>(this.appConfig.secret, row.configEnc); }
        catch { return {}; }
      })(),
    }));
    return connectors
      .map(({ component, pkg }) => {
      const config = parseJson<ComponentConfig>(component.configJson, {});
      const lockedByPlatform = scopeKey !== "platform" && platformReady.has(component.id);
      const credential = lockedByPlatform
        ? platformCredentials.find((row) => row.connectorId === component.id)
        : byConnector.get(component.id);
      const values = credential
        ? (() => {
            try { return decryptJson<Record<string, unknown>>(this.appConfig.secret, credential.configEnc); }
            catch { return {}; }
          })()
        : {};
      const enabled = lockedByPlatform
        ? true
        : credential?.enabled ?? config.credentialKind === "oauth2_dynamic";
      const hasTools = packageComponents.some(
        (item) => item.packageId === pkg.id && item.kind === "tool",
      );
      return {
        id: component.id,
        ref: component.ref,
        name: component.name,
        description: component.description,
        package: { slug: pkg.slug, name: pkg.name, icon: pkg.icon, accent: pkg.accent },
        credentialKind: config.credentialKind ?? "none",
        fields: config.fields ?? [],
        docsUrl: config.docsUrl,
        enabled,
        ready: config.credentialKind === "oauth2_dynamic" || !!enabled,
        lockedByPlatform,
        credentialSource: lockedByPlatform
          ? "platform" as const
          : credential
            ? (scopeKey === "platform" ? "platform" as const : "tenant" as const)
            : null,
        configuredFields: Object.keys(values).filter((key) => values[key] !== "" && values[key] != null),
        hasTools,
        capabilities: packageComponents
          .filter((item) => item.packageId === pkg.id && item.kind !== "connector")
          .map((item) => {
            const itemConfig = parseJson<ComponentConfig>(item.configJson, {});
            return {
              id: item.id,
              kind: item.kind,
              ref: item.ref,
              name: item.name,
              description: item.description,
              config: itemConfig,
              installed: item.kind === "skill"
                ? skillNames.has(item.ref)
                : instanceConfigs.some(({ row, config: current }) =>
                    row.providerId === itemConfig.providerId &&
                    current.product === itemConfig.product &&
                    typeof current.oauthAccessToken === "string" &&
                    current.oauthAccessToken.trim().length > 0),
            };
          }),
      };
    })
      .filter((item) => item.hasTools);
  }

  async saveCredentials(scopeKey: string, connectorId: string, input: {
    enabled?: boolean;
    values?: Record<string, unknown>;
  }) {
    const connector = await this.db.query.integrationComponents.findFirst({
      where: and(eq(integrationComponents.id, connectorId), eq(integrationComponents.kind, "connector")),
    });
    if (!connector) throw new Error("连接器不存在");
    if (scopeKey !== "platform") {
      const platformRow = await this.db.query.connectorCredentials.findFirst({
        where: and(
          eq(connectorCredentials.scopeKey, "platform"),
          eq(connectorCredentials.connectorId, connectorId),
          eq(connectorCredentials.enabled, true),
        ),
      });
      if (platformRow) {
        throw new Error("管理员已预配该 OAuth 客户端，团队不可自行配置");
      }
    }
    const config = parseJson<ComponentConfig>(connector.configJson, {});
    const existing = await this.db.query.connectorCredentials.findFirst({
      where: and(
        eq(connectorCredentials.scopeKey, scopeKey),
        eq(connectorCredentials.connectorId, connectorId),
      ),
    });
    let current: Record<string, unknown> = {};
    if (existing) {
      try { current = decryptJson<Record<string, unknown>>(this.appConfig.secret, existing.configEnc); }
      catch { current = {}; }
    }
    for (const [key, value] of Object.entries(input.values ?? {})) {
      const field = config.fields?.find((item) => item.key === key);
      if (!field) throw new Error(`未知凭据字段: ${key}`);
      if (value === "***" || value === undefined) continue;
      if (typeof value !== "string") throw new Error(`${field.label} 必须是文本`);
      if (value === "") delete current[key];
      else current[key] = value;
    }
    const enabled = input.enabled ?? existing?.enabled ?? false;
    if (enabled && config.credentialKind !== "oauth2_dynamic") {
      const missing = (config.fields ?? [])
        .filter((field) => field.required && !String(current[field.key] ?? "").trim())
        .map((field) => field.label);
      if (missing.length) throw new Error(`缺少必填凭据: ${missing.join("、")}`);
    }
    const now = new Date();
    await this.db
      .insert(connectorCredentials)
      .values({
        id: existing?.id ?? newId(),
        scopeKey,
        connectorId,
        enabled,
        credentialKind: config.credentialKind ?? "custom",
        configEnc: encryptJson(this.appConfig.secret, current),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [connectorCredentials.scopeKey, connectorCredentials.connectorId],
        set: {
          enabled,
          credentialKind: config.credentialKind ?? "custom",
          configEnc: encryptJson(this.appConfig.secret, current),
          updatedAt: now,
        },
      });
    return (await this.listConnectors(scopeKey)).find((item) => item.id === connectorId)!;
  }

  async resolveCredentials(tenantId: string, connectorRef: string) {
    await this.sync();
    const connector = await this.db.query.integrationComponents.findFirst({
      where: and(eq(integrationComponents.kind, "connector"), eq(integrationComponents.ref, connectorRef)),
    });
    if (!connector) return null;
    // 整站预配启用时优先；否则团队配置优先，再回退整站
    const platformRow = await this.db.query.connectorCredentials.findFirst({
      where: and(
        eq(connectorCredentials.scopeKey, "platform"),
        eq(connectorCredentials.connectorId, connector.id),
        eq(connectorCredentials.enabled, true),
      ),
    });
    const order = platformRow ? ["platform", tenantId] : [tenantId, "platform"];
    for (const scopeKey of order) {
      const row = await this.db.query.connectorCredentials.findFirst({
        where: and(
          eq(connectorCredentials.scopeKey, scopeKey),
          eq(connectorCredentials.connectorId, connector.id),
          eq(connectorCredentials.enabled, true),
        ),
      });
      if (!row) continue;
      try {
        return {
          values: decryptJson<Record<string, unknown>>(this.appConfig.secret, row.configEnc),
          source: scopeKey === "platform" ? "platform" as const : "tenant" as const,
        };
      } catch { /* try next */ }
    }
    return null;
  }

  async matchConnector(mcpUrl: string) {
    await this.sync();
    const normalized = mcpUrl.trim().toLowerCase();
    let host = "";
    try { host = new URL(mcpUrl).hostname.toLowerCase(); } catch { /* custom scheme */ }
    const connectors = await this.db
      .select()
      .from(integrationComponents)
      .where(eq(integrationComponents.kind, "connector"));
    for (const connector of connectors) {
      const config = parseJson<ComponentConfig>(connector.configJson, {});
      const hinted = config.pathHints?.some((hint) => normalized.startsWith(hint.toLowerCase()));
      const hosted = config.hostPatterns?.some((pattern) => {
        const wanted = pattern.toLowerCase();
        return wanted.startsWith("*.")
          ? host === wanted.slice(2) || host.endsWith(wanted.slice(1))
          : host === wanted;
      });
      if (hinted || hosted) return { connector, config };
    }
    return null;
  }

  async resolveHostOauthClient(
    tenantId: string,
    mcpUrl: string,
    opts?: { connectorRef?: string },
  ) {
    const byHost = mcpUrl.trim() ? await this.matchConnector(mcpUrl) : null;
    const connectorRef =
      byHost?.connector.ref ||
      (opts?.connectorRef?.trim() ? opts.connectorRef.trim() : "");
    if (!connectorRef) return null;

    let matched = byHost;
    if (!matched) {
      await this.sync();
      const connector = await this.db.query.integrationComponents.findFirst({
        where: and(
          eq(integrationComponents.kind, "connector"),
          eq(integrationComponents.ref, connectorRef),
        ),
      });
      if (!connector) return null;
      matched = {
        connector,
        config: parseJson<ComponentConfig>(connector.configJson, {}),
      };
    }

    const resolved = await this.resolveCredentials(tenantId, matched.connector.ref);
    if (!resolved) return null;
    const clientId = String(resolved.values.clientId ?? "").trim();
    if (!clientId) return null;
    return {
      connectorRef: matched.connector.ref,
      connectorName: matched.connector.name,
      clientId,
      clientSecret: String(resolved.values.clientSecret ?? "").trim() || undefined,
      source: resolved.source,
      authorizationEndpoint:
        typeof matched.config.authorizationEndpoint === "string"
          ? matched.config.authorizationEndpoint
          : undefined,
      tokenEndpoint:
        typeof matched.config.tokenEndpoint === "string"
          ? matched.config.tokenEndpoint
          : undefined,
    };
  }

  /** 供前端安装流判断：远程 MCP 是否可复用已配置的连接器 OAuth 客户端 */
  async peekSharedOauth(tenantId: string, mcpUrl: string, connectorRef?: string) {
    const client = await this.resolveHostOauthClient(tenantId, mcpUrl, { connectorRef });
    if (!client) {
      return { ready: false as const, connectorRef: connectorRef ?? null };
    }
    return {
      ready: true as const,
      connectorRef: client.connectorRef,
      connectorName: client.connectorName,
      source: client.source,
    };
  }

  /** 平台内建连接器能力。外部 MCP 不进入此目录。 */
  async matchConnectorCapability(target: string) {
    await this.sync();
    const normalized = target.trim().toLowerCase();
    const tools = await this.db
      .select()
      .from(integrationComponents)
      .where(eq(integrationComponents.kind, "tool"));
    for (const tool of tools) {
      const config = parseJson<ComponentConfig>(tool.configJson, {});
      if (String(config.mcpUrl ?? "").toLowerCase() !== normalized) continue;
      const connector = await this.db.query.integrationComponents.findFirst({
        where: and(
          eq(integrationComponents.packageId, tool.packageId),
          eq(integrationComponents.kind, "connector"),
        ),
      });
      if (!connector) return null;
      return {
        tool,
        toolConfig: config,
        connector,
        connectorConfig: parseJson<ComponentConfig>(connector.configJson, {}),
      };
    }
    return null;
  }

  async resolveConnectorTarget(tenantId: string, target: string) {
    const matched = await this.matchConnectorCapability(target);
    if (!matched) return null;
    const providerId = String(matched.toolConfig.providerId ?? "").trim();
    const product = String(matched.toolConfig.product ?? "").trim();
    const mcpUrl = String(matched.toolConfig.mcpUrl ?? target).trim();
    if (!providerId || !product || !mcpUrl) return null;
    const resolved = await this.resolveCredentials(tenantId, matched.connector.ref);
    const values = resolved?.values ?? {};
    const tenant = String(values.tenantId ?? "common").trim() || "common";
    const interpolate = (value: unknown) =>
      typeof value === "string" ? value.replaceAll("{tenantId}", tenant) : undefined;
    const authorizationEndpoint = interpolate(matched.connectorConfig.authorizationEndpoint);
    const tokenEndpoint = interpolate(matched.connectorConfig.tokenEndpoint);
    if (!authorizationEndpoint || !tokenEndpoint) {
      throw new Error(`连接器 ${matched.connector.ref} 的 OAuth 端点配置不完整`);
    }
    const instances = await this.db
      .select()
      .from(componentInstances)
      .where(and(
        eq(componentInstances.tenantId, tenantId),
        eq(componentInstances.providerId, providerId),
      ));
    const existingInstance = instances.find((row) => {
      try {
        const current = decryptJson<Record<string, unknown>>(this.appConfig.secret, row.configEnc);
        return current.product === product;
      } catch {
        return false;
      }
    }) ?? null;
    const instanceSlug = `connector-${matched.tool.ref}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32);
    return {
      providerId,
      product,
      mcpUrl,
      instanceSlug,
      existingInstance,
      scopes: String(matched.toolConfig.scopes ?? "").trim(),
      client: resolved
        ? {
            clientId: String(values.clientId ?? "").trim(),
            clientSecret: String(values.clientSecret ?? "").trim() || undefined,
            source: resolved.source,
          }
        : null,
      discovery: {
        mcpUrl,
        authorizationServers: [],
        authorizationEndpoint,
        tokenEndpoint,
        scopesSupported: String(matched.toolConfig.scopes ?? "").trim().split(/\s+/).filter(Boolean),
        codeChallengeMethodsSupported: ["S256"],
      },
      authorizeParams: matched.connectorConfig.authorizeParams,
    };
  }
}
