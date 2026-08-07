import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { decryptJson } from "@zakura/core";
import {
  type ConnectorAuthSpec,
  type ConnectorField,
  type ConnectorStatus,
  authNeedsCredentials,
  authNeedsUserGrant,
  interpolateWithValues,
  missingRequiredFields,
  normalizeConnectorAuth,
} from "@zakura/shared";
import catalog from "../catalog/integration-packages.json" with { type: "json" };
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  agents,
  componentInstances,
  connectorAuthProfiles,
  agentSkills,
  integrationComponents,
  integrationPackages,
  newId,
  skills,
} from "../db/schema.js";
import {
  ConnectorAuthService,
  PLATFORM_SCOPE,
  type DeclaredAuthProfile,
} from "./connector-auth.js";
import { EmailConnectorInstanceService } from "./email-connector-instances.js";

export type IntegrationComponentKind = "connector" | "skill" | "tool" | "resource" | "prompt";

type ComponentConfig = {
  providerId?: string;
  mcpUrl?: string;
  connectorRef?: string;
  source?: string;
  hostPatterns?: string[];
  pathHints?: string[];
  [key: string]: unknown;
};

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** 声明了 defaultValue 的字段作为占位符插值兜底，避免服务代码写死厂商默认值 */
function fallbacksFromFields(fields: ConnectorField[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    if (field.defaultValue) out[field.key] = field.defaultValue;
  }
  return out;
}

export class IntegrationCatalogService {
  readonly auth: ConnectorAuthService;
  readonly emailInstances: EmailConnectorInstanceService;

  constructor(
    private readonly db: Db,
    private readonly appConfig: AppConfig,
  ) {
    this.auth = new ConnectorAuthService(db, appConfig);
    this.emailInstances = new EmailConnectorInstanceService(db, appConfig);
  }

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

  /**
   * The original email connector stored one provider profile under `email`.
   * Move that profile to the matching provider-specific connector once.
   */
  async migrateLegacyEmailProfiles(): Promise<void> {
    const legacyRows = await this.db
      .select()
      .from(connectorAuthProfiles)
      .where(eq(connectorAuthProfiles.profileKey, "email"));
    if (!legacyRows.length) return;

    const declared = await this.declaredProfiles();
    const declaredByKey = new Map(declared.map((item) => [item.key, item]));
    for (const row of legacyRows) {
      const values = (() => {
        try {
          return decryptJson<Record<string, unknown>>(this.appConfig.secret, row.configEnc);
        } catch {
          return {};
        }
      })();
      const rawProvider = String(values.provider ?? "").trim().toLowerCase();
      const provider =
        rawProvider ||
        (String(values.smtpHost ?? "").trim() ? "smtp" : "") ||
        (String(values.mailgunDomain ?? "").trim() ? "mailgun" : "") ||
        (String(values.baseUrl ?? "").trim() && String(values.mailbox ?? "").trim()
          ? "bettermail"
          : "") ||
        (String(values.apiToken ?? "").trim() ? "amail" : "");
      if (!["smtp", "mailgun", "resendapi", "amail", "bettermail"].includes(provider)) continue;

      const profileKey = `email-${provider}`;
      const declaredProfile = declaredByKey.get(profileKey);
      if (!declaredProfile) continue;
      const existing = await this.db.query.connectorAuthProfiles.findFirst({
        where: and(
          eq(connectorAuthProfiles.scopeKey, row.scopeKey),
          eq(connectorAuthProfiles.profileKey, profileKey),
        ),
      });
      if (!existing) {
        await this.auth.saveProfile(row.scopeKey, profileKey, {
          enabled: row.enabled,
          kind: "custom",
          values,
        }, declaredProfile);
      }

      const legacySettings = await this.auth.getSettings(row.scopeKey, "email");
      if (Object.keys(legacySettings).length) {
        const targetSettings = await this.auth.getSettings(row.scopeKey, `email-${provider}`);
        if (!Object.keys(targetSettings).length) {
          const allowed = new Set(declaredProfile.fields.map((field) => field.key));
          const settings = Object.fromEntries(
            Object.entries(legacySettings).filter(([key]) => allowed.has(key)),
          );
          if (Object.keys(settings).length) {
            await this.auth.saveSettings(
              row.scopeKey,
              `email-${provider}`,
              settings,
              declaredProfile.fields.map((field) => ({ ...field, required: false })),
            );
          }
        }
      }
      if (row.scopeKey !== PLATFORM_SCOPE) {
        await this.emailInstances.migrateLegacy(
          row.scopeKey,
          profileKey,
          { ...values, ...legacySettings, product: provider },
          row.enabled,
        );
      }
    }
  }

  async migrateConfiguredEmailProfiles(): Promise<void> {
    const rows = await this.db.select().from(connectorAuthProfiles);
    for (const row of rows) {
      if (row.scopeKey === PLATFORM_SCOPE || !/^email-(smtp|mailgun|resendapi|amail|bettermail)$/.test(row.profileKey)) {
        continue;
      }
      const values = (() => {
        try {
          return decryptJson<Record<string, unknown>>(this.appConfig.secret, row.configEnc);
        } catch {
          return {};
        }
      })();
      const product = row.profileKey.slice("email-".length);
      const settings = await this.auth.getSettings(row.scopeKey, row.profileKey);
      await this.emailInstances.migrateLegacy(
        row.scopeKey,
        row.profileKey,
        { ...values, ...settings, product },
        row.enabled,
      );
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

  /** 目录里所有连接器组件（含归一化后的 auth 声明） */
  private async loadConnectorComponents() {
    await this.sync();
    const rows = await this.db
      .select({ component: integrationComponents, pkg: integrationPackages })
      .from(integrationComponents)
      .innerJoin(integrationPackages, eq(integrationComponents.packageId, integrationPackages.id))
      .where(eq(integrationComponents.kind, "connector"))
      .orderBy(asc(integrationPackages.name));
    return rows.map(({ component, pkg }) => {
      const config = parseJson<ComponentConfig>(component.configJson, {});
      return { component, pkg, config, auth: normalizeConnectorAuth(component.ref, config) };
    });
  }

  /**
   * 目录声明的凭据档案。同名档案会被多个连接器共享，这里按名字归并，
   * 并记录引用它的连接器，供管理端展示影响面。
   */
  async declaredProfiles(): Promise<DeclaredAuthProfile[]> {
    const connectors = await this.loadConnectorComponents();
    const byKey = new Map<string, DeclaredAuthProfile>();
    for (const { component, auth } of connectors) {
      if (!authNeedsCredentials(auth.kind)) continue;
      const existing = byKey.get(auth.profile);
      if (existing) {
        existing.connectorRefs.push(component.ref);
        // 同名档案字段取并集，避免某个连接器少声明字段导致无法配置
        for (const field of auth.fields) {
          if (!existing.fields.some((item) => item.key === field.key)) {
            existing.fields.push(field);
          }
        }
        continue;
      }
      byKey.set(auth.profile, {
        key: auth.profile,
        label: auth.profileLabel ?? component.name,
        kind: auth.kind,
        fields: [...auth.fields],
        docsUrl: auth.docsUrl,
        connectorRefs: [component.ref],
      });
    }
    return [...byKey.values()];
  }

  async listProfiles(scopeKey: string) {
    return this.auth.listProfiles(scopeKey, await this.declaredProfiles());
  }

  async saveProfile(
    scopeKey: string,
    profileKey: string,
    input: Parameters<ConnectorAuthService["saveProfile"]>[2],
  ) {
    const declared = (await this.declaredProfiles()).find((item) => item.key === profileKey);
    await this.auth.saveProfile(scopeKey, profileKey, input, declared);
    return (await this.listProfiles(scopeKey)).find((item) => item.key === profileKey) ?? null;
  }

  /**
   * Compatibility adapter for connector-scoped callers.
   * Credentials belong to the declared profile; settings remain connector-scoped.
   */
  async saveCredentials(
    scopeKey: string,
    connectorId: string,
    input: {
      enabled?: boolean;
      values?: Record<string, unknown>;
      settings?: Record<string, unknown>;
    },
  ) {
    const connectors = await this.loadConnectorComponents();
    const match = connectors.find(
      ({ component }) => component.id === connectorId || component.ref === connectorId,
    );
    if (!match) throw new Error("连接器不存在");

    const fieldKeys = new Set(match.auth.fields.map((field) => field.key));
    const settingKeys = new Set(match.auth.settings.map((field) => field.key));
    const values = { ...(input.values ?? {}) };
    const profileValues: Record<string, unknown> = {};
    const settingValues: Record<string, unknown> = { ...(input.settings ?? {}) };
    for (const [key, value] of Object.entries(values)) {
      if (settingKeys.has(key) && !fieldKeys.has(key)) settingValues[key] = value;
      else profileValues[key] = value;
    }

    if (authNeedsCredentials(match.auth.kind)) {
      await this.saveProfile(scopeKey, match.auth.profile, {
        enabled: input.enabled,
        values: profileValues,
      });
    } else if (input.enabled === false) {
      await this.saveProfile(scopeKey, match.auth.profile, { enabled: false });
    }
    if (match.auth.settings.length && Object.keys(settingValues).length) {
      await this.saveConnectorSettings(scopeKey, match.component.ref, settingValues);
    }

    return (await this.listConnectors(scopeKey)).find(
      (item) => item.id === match.component.id,
    ) ?? null;
  }

  async deleteProfile(scopeKey: string, profileKey: string) {
    await this.auth.deleteProfile(scopeKey, profileKey);
  }

  /**
   * 连接器列表。
   * scopeKey === "platform" 时不按「是否有工具」过滤：管理员也可为纯客户端档案预配。
   */
  async listConnectors(scopeKey: string) {
    const connectors = await this.loadConnectorComponents();
    const profileKeys = [...new Set(connectors.map((item) => item.auth.profile))];
    const [scopeProfiles, platformProvisioned] = await Promise.all([
      this.auth.listProfiles(scopeKey, await this.declaredProfiles()),
      scopeKey === PLATFORM_SCOPE
        ? Promise.resolve(new Set<string>())
        : this.auth.platformProvisionedKeys(profileKeys),
    ]);
    const profileByKey = new Map(scopeProfiles.map((item) => [item.key, item]));

    const packageIds = connectors.map((item) => item.pkg.id);
    const packageComponents = packageIds.length
      ? await this.db.select().from(integrationComponents).where(inArray(integrationComponents.packageId, packageIds))
      : [];

    const [installedSkills] = scopeKey === PLATFORM_SCOPE
      ? [[]]
      : await Promise.all([
          this.db.select().from(agentSkills).where(eq(agentSkills.tenantId, scopeKey)),
        ]);
    const skillNames = new Set(
      installedSkills.filter((row) => row.status === "installed").map((row) => row.name),
    );

    const settingsByRef = new Map<string, Record<string, unknown>>();
    for (const { component } of connectors) {
      settingsByRef.set(component.ref, await this.auth.getSettings(scopeKey, component.ref));
    }

    const installationRows =
      scopeKey === PLATFORM_SCOPE
        ? []
        : await this.auth.listInstallations(scopeKey);
    const agentNameById = new Map<string, string>();
    if (installationRows.length) {
      const agentRows = await this.db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(
          and(
            eq(agents.tenantId, scopeKey),
            inArray(
              agents.id,
              [...new Set(installationRows.map((row) => row.agentId))],
            ),
          ),
        );
      for (const row of agentRows) agentNameById.set(row.id, row.name);
    }
    const installationsByRef = new Map<string, typeof installationRows>();
    for (const row of installationRows) {
      const list = installationsByRef.get(row.connectorRef) ?? [];
      list.push(row);
      installationsByRef.set(row.connectorRef, list);
    }

    const items = connectors.map(({ component, pkg, auth }) => {
      const profile = profileByKey.get(auth.profile);
      const lockedByPlatform = platformProvisioned.has(auth.profile);
      const settingsValues = settingsByRef.get(component.ref) ?? {};
      const status = resolveStatus(auth, profile, lockedByPlatform, settingsValues);
      const hasTools = packageComponents.some(
        (item) => item.packageId === pkg.id && item.kind === "tool",
      );
      const installs = (installationsByRef.get(component.ref) ?? []).map((row) => ({
        ...row,
        agentName: agentNameById.get(row.agentId) ?? row.agentId,
      }));

      return {
        id: component.id,
        ref: component.ref,
        name: component.name,
        description: component.description,
        package: { slug: pkg.slug, name: pkg.name, icon: pkg.icon, accent: pkg.accent, homepage: pkg.homepage },
        auth,
        status,
        ready: status === "ready" || status === "platform-provisioned",
        enabled: status === "ready" || status === "platform-provisioned",
        lockedByPlatform,
        profile: {
          key: auth.profile,
          label: profile?.label ?? auth.profileLabel ?? component.name,
          shared: (profile?.connectorRefs.length ?? 0) > 1,
          connectorRefs: profile?.connectorRefs ?? [component.ref],
          configuredFields: profile?.configuredFields ?? [],
          enabled: profile?.enabled ?? false,
        },
        credentialSource: lockedByPlatform
          ? ("platform" as const)
          : profile?.configuredFields.length
            ? (scopeKey === PLATFORM_SCOPE ? ("platform" as const) : ("tenant" as const))
            : null,
        configuredFields: profile?.configuredFields ?? [],
        configuredSettings: Object.keys(settingsValues).filter(
          (key) =>
            !key.startsWith("oauth") &&
            settingsValues[key] != null &&
            String(settingsValues[key]).trim() !== "",
        ),
        /** 任一 Agent 安装已授权 */
        authorized: installs.some((row) => row.authorized) || hasUsableToken(settingsValues),
        installations: installs,
        docsUrl: auth.docsUrl,
        hasTools,
        capabilities: packageComponents
          .filter((item) => {
            if (item.packageId !== pkg.id || item.kind === "connector") return false;
            const itemConfig = parseJson<ComponentConfig>(item.configJson, {});
            return !itemConfig.connectorRef || itemConfig.connectorRef === component.ref;
          })
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
                : installs.some((row) => row.enabled),
            };
          }),
      };
    });

    return scopeKey === PLATFORM_SCOPE
      ? items
      : items.filter((item) => item.hasTools || item.package.slug === "agent-remote");
  }

  async saveConnectorSettings(
    scopeKey: string,
    connectorRef: string,
    values: Record<string, unknown>,
  ) {
    const connectors = await this.loadConnectorComponents();
    const match = connectors.find((item) => item.component.ref === connectorRef);
    if (!match) throw new Error("连接器不存在");
    await this.auth.saveSettings(scopeKey, connectorRef, values, match.auth.settings);
    return (await this.listConnectors(scopeKey)).find((item) => item.ref === connectorRef) ?? null;
  }

  async saveConnectorAuthorization(
    tenantId: string,
    connectorRef: string,
    values: { accessToken: string; refreshToken?: string; expiresAt?: number },
    agentId: string,
  ) {
    if (!agentId?.trim()) throw new Error("授权需要指定 Agent");
    await this.auth.saveInstallationAuthorization(tenantId, agentId.trim(), connectorRef, values);
    return (await this.listConnectors(tenantId)).find((item) => item.ref === connectorRef) ?? null;
  }

  async installConnector(tenantId: string, connectorRef: string, agentIds: string[]) {
    const connectors = await this.loadConnectorComponents();
    const match = connectors.find((item) => item.component.ref === connectorRef);
    if (!match) throw new Error("连接器不存在");
    const listed = await this.listConnectors(tenantId);
    const view = listed.find((item) => item.ref === connectorRef);
    if (!view?.ready) throw new Error("请先完成租户 OAuth / 凭据配置");
    await this.auth.ensureInstallations(tenantId, connectorRef, agentIds);
    return (await this.listConnectors(tenantId)).find((item) => item.ref === connectorRef) ?? null;
  }

  async uninstallConnector(tenantId: string, connectorRef: string, agentId: string) {
    await this.auth.removeInstallation(tenantId, connectorRef, agentId);
    return (await this.listConnectors(tenantId)).find((item) => item.ref === connectorRef) ?? null;
  }

  /** 解析某连接器在该租户下可用的凭据（经由它引用的档案） */
  async resolveCredentials(tenantId: string, connectorRef: string) {
    const connectors = await this.loadConnectorComponents();
    const match = connectors.find((item) => item.component.ref === connectorRef);
    if (!match) return null;
    const resolved = await this.auth.resolveProfile(tenantId, match.auth.profile);
    if (!resolved) return null;
    return { values: resolved.values, source: resolved.source };
  }

  async matchConnector(mcpUrl: string) {
    const normalized = mcpUrl.trim().toLowerCase();
    let host = "";
    try { host = new URL(mcpUrl).hostname.toLowerCase(); } catch { /* custom scheme */ }
    const connectors = await this.loadConnectorComponents();
    for (const { component, config, auth } of connectors) {
      const hinted = config.pathHints?.some((hint) => normalized.startsWith(hint.toLowerCase()));
      const hosted = config.hostPatterns?.some((pattern) => {
        const wanted = pattern.toLowerCase();
        return wanted.startsWith("*.")
          ? host === wanted.slice(2) || host.endsWith(wanted.slice(1))
          : host === wanted;
      });
      if (hinted || hosted) return { connector: component, config, auth };
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
      const connectors = await this.loadConnectorComponents();
      const found = connectors.find((item) => item.component.ref === connectorRef);
      if (!found) return null;
      matched = { connector: found.component, config: found.config, auth: found.auth };
    }

    const resolved = await this.auth.resolveProfile(tenantId, matched.auth.profile);
    if (!resolved) return null;
    const clientId = String(resolved.values.clientId ?? "").trim();
    if (!clientId) return null;
    const fallbacks = fallbacksFromFields(matched.auth.fields);
    return {
      connectorRef: matched.connector.ref,
      connectorName: matched.connector.name,
      profileKey: matched.auth.profile,
      clientId,
      clientSecret: String(resolved.values.clientSecret ?? "").trim() || undefined,
      source: resolved.source,
      authorizationEndpoint: interpolateWithValues(
        matched.auth.authorizationEndpoint,
        resolved.values,
        fallbacks,
      ),
      tokenEndpoint: interpolateWithValues(matched.auth.tokenEndpoint, resolved.values, fallbacks),
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
      profileKey: client.profileKey,
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
      const connector = config.connectorRef
        ? await this.db.query.integrationComponents.findFirst({
            where: and(
              eq(integrationComponents.packageId, tool.packageId),
              eq(integrationComponents.kind, "connector"),
              eq(integrationComponents.ref, String(config.connectorRef)),
            ),
          })
        : await this.db.query.integrationComponents.findFirst({
            where: and(
              eq(integrationComponents.packageId, tool.packageId),
              eq(integrationComponents.kind, "connector"),
            ),
          });
      if (!connector) return null;
      const connectorConfig = parseJson<ComponentConfig>(connector.configJson, {});
      return {
        tool,
        toolConfig: config,
        connector,
        connectorConfig,
        auth: normalizeConnectorAuth(connector.ref, connectorConfig),
      };
    }
    return null;
  }

  async resolveConnectorTarget(
    tenantId: string,
    target: string,
    opts?: {
      agentId?: string;
      credentials?: {
        values: Record<string, unknown>;
        settings?: Record<string, unknown>;
      };
    },
  ) {
    const matched = await this.matchConnectorCapability(target);
    if (!matched) return null;
    const providerId = String(matched.toolConfig.providerId ?? "").trim();
    const product = String(matched.toolConfig.product ?? "").trim();
    const mcpUrl = String(matched.toolConfig.mcpUrl ?? target).trim();
    if (!providerId || !product || !mcpUrl) return null;

    const auth = matched.auth;
    const resolved = opts?.credentials
      ? null
      : await this.auth.resolveProfile(tenantId, auth.profile);
    const values = opts?.credentials?.values ?? resolved?.values ?? {};
    const tenantSettings = await this.auth.getSettings(tenantId, matched.connector.ref);
    const installConfig = opts?.agentId
      ? await this.auth.getInstallationConfig(tenantId, opts.agentId, matched.connector.ref)
      : {};
    // 安装级 OAuth 令牌优先；回退租户 settings 兼容旧数据
    const settings =
      opts?.credentials?.settings ??
      { ...tenantSettings, ...installConfig };
    const fallbacks = {
      ...fallbacksFromFields(auth.settings),
      ...fallbacksFromFields(auth.fields),
    };
    const context = { ...settings, ...values };
    const authorizationEndpoint = interpolateWithValues(
      auth.authorizationEndpoint,
      context,
      fallbacks,
    );
    const tokenEndpoint = interpolateWithValues(auth.tokenEndpoint, context, fallbacks);
    const needsGrant = authNeedsUserGrant(auth.kind);
    if (needsGrant && (!authorizationEndpoint || !tokenEndpoint)) {
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

    const scopes = String(matched.toolConfig.scopes ?? "").trim();
    const authorization =
      typeof settings.oauthAccessToken === "string" && settings.oauthAccessToken.trim()
        ? {
            oauthAccessToken: settings.oauthAccessToken,
            ...(typeof settings.oauthRefreshToken === "string"
              ? { oauthRefreshToken: settings.oauthRefreshToken }
              : {}),
            ...(typeof settings.oauthExpiresAt === "number"
              ? { oauthExpiresAt: settings.oauthExpiresAt }
              : {}),
          }
        : null;
    return {
      connectorRef: matched.connector.ref,
      connectorName: matched.connector.name,
      capabilityRef: matched.tool.ref,
      providerId,
      product,
      mcpUrl,
      instanceSlug,
      existingInstance,
      scopes,
      auth,
      agentId: opts?.agentId ?? null,
      /** 非 OAuth 认证时需要写入实例的凭据与设置 */
      credentials: needsGrant ? null : { values, settings },
      authorization,
      /** true 时安装后需要用户完成浏览器授权 */
      needsUserGrant: needsGrant,
      client: resolved && auth.kind === "oauth2"
        ? {
            clientId: String(values.clientId ?? "").trim(),
            clientSecret: String(values.clientSecret ?? "").trim() || undefined,
            source: resolved.source,
          }
        : null,
      discovery: {
        mcpUrl,
        authorizationServers: [],
        authorizationEndpoint: authorizationEndpoint ?? "",
        tokenEndpoint: tokenEndpoint ?? "",
        scopesSupported: scopes.split(/\s+/).filter(Boolean),
        codeChallengeMethodsSupported: ["S256"],
      },
      authorizeParams: auth.authorizeParams,
    };
  }

  /**
   * 已授权给指定 Agent 的平台连接器工具目标。
   * 这些目标只用于 Agent 工具分发，不会创建 component_instances。
   */
  async listDirectConnectorTargets(tenantId: string, agentId: string) {
    if (!agentId?.trim()) return [];
    const installs = await this.auth.listInstallations(tenantId, { agentId: agentId.trim() });
    const enabledRefs = new Set(
      installs.filter((row) => row.enabled).map((row) => row.connectorRef),
    );
    if (!enabledRefs.size && !(await this.emailInstances.getTargetConfig(tenantId)).length) {
      return [];
    }

    const connectors = await this.listConnectors(tenantId);
    const targets: Array<Awaited<ReturnType<IntegrationCatalogService["resolveConnectorTarget"]>>> = [];
    for (const connector of connectors) {
      if (!connector.ready || !enabledRefs.has(connector.ref)) continue;
      for (const capability of connector.capabilities) {
        if (capability.kind !== "tool") continue;
        const mcpUrl = String(capability.config.mcpUrl ?? "").trim();
        if (!mcpUrl.startsWith("zakura://")) continue;
        const target = await this.resolveConnectorTarget(tenantId, mcpUrl, { agentId });
        if (!target) continue;
        if (target.needsUserGrant && !target.authorization) continue;
        targets.push(target);
      }
    }
    for (const instance of await this.emailInstances.getTargetConfig(tenantId)) {
      const product = String(instance.config.product ?? "").trim();
      if (!product) continue;
      // 多账号邮箱实例仍按租户配置；仅在装了对应 email 连接器的 Agent 上注入
      const productRef = `email-${product}`;
      if (!enabledRefs.has(productRef) && !enabledRefs.has("email")) continue;
      const base = await this.resolveConnectorTarget(
        tenantId,
        `zakura://email/${product}`,
        { agentId, credentials: { values: instance.config } },
      );
      if (!base) continue;
      const connectorRef = `email-instance-${instance.row.id}`;
      targets.push({
        ...base,
        connectorRef,
        connectorName: instance.row.name,
        instanceSlug: connectorRef,
        auth: { ...base.auth, profile: connectorRef },
        credentials: { values: {}, settings: instance.config },
        existingInstance: null,
      });
    }
    return targets.filter(
      (target): target is NonNullable<typeof target> => target !== null,
    );
  }

  /** 入站等租户级场景：汇总所有 Agent 已安装的直连目标 */
  async listAllDirectConnectorTargets(tenantId: string) {
    const installs = await this.auth.listInstallations(tenantId);
    const agentIds = [...new Set(installs.filter((row) => row.enabled).map((row) => row.agentId))];
    const out: Awaited<ReturnType<IntegrationCatalogService["listDirectConnectorTargets"]>> = [];
    for (const agentId of agentIds) {
      out.push(...(await this.listDirectConnectorTargets(tenantId, agentId)));
    }
    return out;
  }
}
/** 实例是否已经拿到可用令牌（OAuth 或静态 token） */
function hasUsableToken(config: Record<string, unknown>): boolean {
  return (
    (typeof config.oauthAccessToken === "string" && config.oauthAccessToken.trim().length > 0) ||
    (typeof config.apiToken === "string" && config.apiToken.trim().length > 0)
  );
}

function resolveStatus(
  auth: ConnectorAuthSpec,
  profile: { enabled: boolean; configuredFields: string[] } | undefined,
  lockedByPlatform: boolean,
  settingsValues: Record<string, unknown>,
): ConnectorStatus {
  if (lockedByPlatform) return "platform-provisioned";
  const missingSettings = missingRequiredFields(auth.settings, settingsValues);
  if (missingSettings.length) return "needs-config";
  if (!authNeedsCredentials(auth.kind)) return "ready";
  if (!profile) return "needs-config";
  const present = new Set(profile.configuredFields);
  const missing = auth.fields.filter((field) => field.required && !present.has(field.key));
  if (missing.length) return "needs-config";
  if (!profile.enabled) return profile.configuredFields.length ? "disabled" : "needs-config";
  return "ready";
}
