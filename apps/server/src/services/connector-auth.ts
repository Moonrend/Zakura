/**
 * 命名凭据档案（auth profile）。
 *
 * 连接器不直接持有凭据，而是通过 `auth.profile` 引用一个名字。多个连接器写同一个
 * 名字即共享同一份客户端；管理员也可以整站预配任意名字（包括目录里尚不存在的），
 * 供后续连接器或上游 MCP 引用。
 *
 * 字段 schema 一律来自目录声明或 kind 的通用默认值，服务代码不枚举任何厂商。
 *
 * 作用域：
 * - OAuth 客户端配置 → connector_auth_profiles（租户/平台全局）
 * - 连接器实例设置 → connector_settings（租户级）
 * - 用户授权 / 安装 → agent_connector_installations（按 Agent）
 */
import { decryptJson, encryptJson } from "@zakura/core";
import {
  type ConnectorAuthKind,
  type ConnectorCredentialSource,
  type ConnectorField,
  missingRequiredFields,
} from "@zakura/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  agentConnectorInstallations,
  connectorAuthProfiles,
  connectorSettings,
  newId,
} from "../db/schema.js";

export const PLATFORM_SCOPE = "platform";

/** 已保存值的占位符：前端回填时表示「保持原值」 */
const KEEP_VALUE = "***";

/** 目录声明的档案（由 IntegrationCatalogService 汇总后传入） */
export interface DeclaredAuthProfile {
  key: string;
  label: string;
  kind: ConnectorAuthKind;
  fields: ConnectorField[];
  docsUrl?: string;
  /** 引用该档案的连接器 ref，用于管理端展示影响面 */
  connectorRefs: string[];
}

export interface AuthProfileView {
  key: string;
  label: string;
  kind: ConnectorAuthKind;
  enabled: boolean;
  /** 目录声明的档案为 false；管理员手动新建的为 true */
  custom: boolean;
  fields: ConnectorField[];
  configuredFields: string[];
  docsUrl?: string;
  connectorRefs: string[];
  updatedAt?: string;
}

export interface ResolvedProfile {
  values: Record<string, unknown>;
  source: ConnectorCredentialSource;
  kind: ConnectorAuthKind;
}

export interface AgentConnectorInstallationView {
  id: string;
  agentId: string;
  connectorRef: string;
  enabled: boolean;
  authorized: boolean;
  updatedAt: string;
}

/** 无目录声明时（管理员自建档案）按 kind 给出的通用字段 */
export function defaultFieldsForKind(kind: ConnectorAuthKind): ConnectorField[] {
  switch (kind) {
    case "oauth2":
      return [
        { key: "clientId", label: "Client ID", type: "text", required: true },
        { key: "clientSecret", label: "Client Secret", type: "secret" },
        { key: "authorizationEndpoint", label: "Authorization Endpoint", type: "url" },
        { key: "tokenEndpoint", label: "Token Endpoint", type: "url" },
        { key: "scopes", label: "默认 Scopes", type: "text" },
      ];
    case "token":
      return [{ key: "token", label: "令牌", type: "secret", required: true }];
    case "custom":
      return [];
    default:
      return [];
  }
}

function decrypt(secret: string, enc: string): Record<string, unknown> {
  if (!enc) return {};
  try {
    return decryptJson<Record<string, unknown>>(secret, enc);
  } catch {
    return {};
  }
}

function configuredKeys(values: Record<string, unknown>): string[] {
  return Object.keys(values).filter(
    (key) => values[key] != null && String(values[key]).trim() !== "",
  );
}

function hasUsableOauth(values: Record<string, unknown>): boolean {
  return typeof values.oauthAccessToken === "string" && values.oauthAccessToken.trim().length > 0;
}

export class ConnectorAuthService {
  constructor(
    private readonly db: Db,
    private readonly appConfig: AppConfig,
  ) {}

  /**
   * 目录声明的档案 ∪ 已存档案。
   * 并集保证管理员手工新建的名字也出现在列表里。
   */
  async listProfiles(
    scopeKey: string,
    declared: DeclaredAuthProfile[],
  ): Promise<AuthProfileView[]> {
    const rows = await this.db
      .select()
      .from(connectorAuthProfiles)
      .where(eq(connectorAuthProfiles.scopeKey, scopeKey));
    const byKey = new Map(rows.map((row) => [row.profileKey, row]));
    const declaredByKey = new Map(declared.map((item) => [item.key, item]));

    const out: AuthProfileView[] = declared.map((item) => {
      const row = byKey.get(item.key);
      const values = row ? decrypt(this.appConfig.secret, row.configEnc) : {};
      return {
        key: item.key,
        label: item.label,
        kind: item.kind,
        enabled: row?.enabled ?? false,
        custom: false,
        fields: item.fields.length ? item.fields : defaultFieldsForKind(item.kind),
        configuredFields: configuredKeys(values),
        docsUrl: item.docsUrl,
        connectorRefs: item.connectorRefs,
        updatedAt: row?.updatedAt.toISOString(),
      };
    });

    for (const row of rows) {
      if (declaredByKey.has(row.profileKey)) continue;
      const values = decrypt(this.appConfig.secret, row.configEnc);
      const kind = row.kind as ConnectorAuthKind;
      out.push({
        key: row.profileKey,
        label: row.label || row.profileKey,
        kind,
        enabled: row.enabled,
        custom: true,
        fields: defaultFieldsForKind(kind),
        configuredFields: configuredKeys(values),
        connectorRefs: [],
        updatedAt: row.updatedAt.toISOString(),
      });
    }

    return out.sort((a, b) => a.label.localeCompare(b.label));
  }

  async getProfile(
    scopeKey: string,
    profileKey: string,
  ): Promise<{ enabled: boolean; kind: ConnectorAuthKind; values: Record<string, unknown> } | null> {
    const row = await this.db.query.connectorAuthProfiles.findFirst({
      where: and(
        eq(connectorAuthProfiles.scopeKey, scopeKey),
        eq(connectorAuthProfiles.profileKey, profileKey),
      ),
    });
    if (!row) return null;
    return {
      enabled: row.enabled,
      kind: row.kind as ConnectorAuthKind,
      values: decrypt(this.appConfig.secret, row.configEnc),
    };
  }

  /** Internal runtime values, such as an auto-generated webhook secret. */
  async mergeProfileValues(
    scopeKey: string,
    profileKey: string,
    values: Record<string, unknown>,
  ): Promise<void> {
    const row = await this.db.query.connectorAuthProfiles.findFirst({
      where: and(
        eq(connectorAuthProfiles.scopeKey, scopeKey),
        eq(connectorAuthProfiles.profileKey, profileKey),
      ),
    });
    if (!row) throw new Error("凭据档案不存在");
    const current = decrypt(this.appConfig.secret, row.configEnc);
    await this.db
      .update(connectorAuthProfiles)
      .set({
        configEnc: encryptJson(this.appConfig.secret, { ...current, ...values }),
        updatedAt: new Date(),
      })
      .where(eq(connectorAuthProfiles.id, row.id));
  }

  /** 哪些档案被整站预配并启用（团队侧据此锁定） */
  async platformProvisionedKeys(profileKeys: string[]): Promise<Set<string>> {
    if (!profileKeys.length) return new Set();
    const rows = await this.db
      .select({ profileKey: connectorAuthProfiles.profileKey })
      .from(connectorAuthProfiles)
      .where(
        and(
          eq(connectorAuthProfiles.scopeKey, PLATFORM_SCOPE),
          eq(connectorAuthProfiles.enabled, true),
          inArray(connectorAuthProfiles.profileKey, profileKeys),
        ),
      );
    return new Set(rows.map((row) => row.profileKey));
  }

  async saveProfile(
    scopeKey: string,
    profileKey: string,
    input: {
      enabled?: boolean;
      kind?: ConnectorAuthKind;
      label?: string;
      values?: Record<string, unknown>;
    },
    declared?: DeclaredAuthProfile,
  ): Promise<void> {
    const key = profileKey.trim();
    if (!key) throw new Error("凭据档案名称不能为空");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(key)) {
      throw new Error("档案名称只能包含字母、数字、点、下划线和连字符，且不超过 64 个字符");
    }

    const existing = await this.db.query.connectorAuthProfiles.findFirst({
      where: and(
        eq(connectorAuthProfiles.scopeKey, scopeKey),
        eq(connectorAuthProfiles.profileKey, key),
      ),
    });

    // 整站已预配并启用时，团队不可自配同名档案
    if (scopeKey !== PLATFORM_SCOPE) {
      const platformRow = await this.db.query.connectorAuthProfiles.findFirst({
        where: and(
          eq(connectorAuthProfiles.scopeKey, PLATFORM_SCOPE),
          eq(connectorAuthProfiles.profileKey, key),
          eq(connectorAuthProfiles.enabled, true),
        ),
      });
      if (platformRow) {
        throw new Error("管理员已预配该凭据档案（整站生效），团队不可自行配置");
      }
    }

    const kind =
      declared?.kind ??
      input.kind ??
      (existing?.kind as ConnectorAuthKind | undefined) ??
      "custom";
    const fields = declared?.fields.length
      ? declared.fields
      : defaultFieldsForKind(kind);

    const current = existing ? decrypt(this.appConfig.secret, existing.configEnc) : {};
    for (const [field, value] of Object.entries(input.values ?? {})) {
      // custom 档案允许管理员自定义键；有声明的档案严格按 schema 校验
      if (fields.length && !fields.some((item) => item.key === field)) {
        if (kind !== "custom") throw new Error(`未知凭据字段: ${field}`);
      }
      if (kind === "custom" && !/^[a-zA-Z0-9_.-]{1,64}$/.test(field)) {
        throw new Error(`凭据字段名不合法: ${field}`);
      }
      if (value === KEEP_VALUE || value === undefined) continue;
      if (typeof value !== "string") {
        const label = fields.find((item) => item.key === field)?.label ?? field;
        throw new Error(`${label} 必须是文本`);
      }
      if (value === "") delete current[field];
      else current[field] = value;
    }

    const enabled = input.enabled ?? existing?.enabled ?? false;
    if (enabled) {
      const missing = missingRequiredFields(fields, current);
      if (missing.length) throw new Error(`缺少必填凭据: ${missing.join("、")}`);
    }

    const now = new Date();
    await this.db
      .insert(connectorAuthProfiles)
      .values({
        id: existing?.id ?? newId(),
        scopeKey,
        profileKey: key,
        label: input.label?.trim() || declared?.label || existing?.label || key,
        kind,
        enabled,
        configEnc: encryptJson(this.appConfig.secret, current),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [connectorAuthProfiles.scopeKey, connectorAuthProfiles.profileKey],
        set: {
          label: input.label?.trim() || declared?.label || existing?.label || key,
          kind,
          enabled,
          configEnc: encryptJson(this.appConfig.secret, current),
          updatedAt: now,
        },
      });
  }

  async deleteProfile(scopeKey: string, profileKey: string): Promise<void> {
    await this.db
      .delete(connectorAuthProfiles)
      .where(
        and(
          eq(connectorAuthProfiles.scopeKey, scopeKey),
          eq(connectorAuthProfiles.profileKey, profileKey),
        ),
      );
  }

  /**
   * 解析某租户可用的档案值。
   * 整站预配启用时优先（团队不可覆盖）；否则团队优先，再回退整站。
   */
  async resolveProfile(tenantId: string, profileKey: string): Promise<ResolvedProfile | null> {
    if (!profileKey) return null;
    const platform = await this.db.query.connectorAuthProfiles.findFirst({
      where: and(
        eq(connectorAuthProfiles.scopeKey, PLATFORM_SCOPE),
        eq(connectorAuthProfiles.profileKey, profileKey),
        eq(connectorAuthProfiles.enabled, true),
      ),
    });
    const order = platform ? [PLATFORM_SCOPE, tenantId] : [tenantId, PLATFORM_SCOPE];
    for (const scopeKey of order) {
      const row =
        scopeKey === PLATFORM_SCOPE && platform
          ? platform
          : await this.db.query.connectorAuthProfiles.findFirst({
              where: and(
                eq(connectorAuthProfiles.scopeKey, scopeKey),
                eq(connectorAuthProfiles.profileKey, profileKey),
                eq(connectorAuthProfiles.enabled, true),
              ),
            });
      if (!row) continue;
      return {
        values: decrypt(this.appConfig.secret, row.configEnc),
        source: scopeKey === PLATFORM_SCOPE ? "platform" : "tenant",
        kind: row.kind as ConnectorAuthKind,
      };
    }
    return null;
  }

  async getSettings(scopeKey: string, connectorRef: string): Promise<Record<string, unknown>> {
    const row = await this.db.query.connectorSettings.findFirst({
      where: and(
        eq(connectorSettings.scopeKey, scopeKey),
        eq(connectorSettings.connectorRef, connectorRef),
      ),
    });
    return row ? decrypt(this.appConfig.secret, row.configEnc) : {};
  }

  /**
   * @deprecated 认证资源已迁到 agent_connector_installations；保留仅作旧数据回读兼容。
   */
  async saveAuthorization(
    scopeKey: string,
    connectorRef: string,
    values: {
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
    },
  ): Promise<void> {
    const existing = await this.db.query.connectorSettings.findFirst({
      where: and(
        eq(connectorSettings.scopeKey, scopeKey),
        eq(connectorSettings.connectorRef, connectorRef),
      ),
    });
    const current = existing ? decrypt(this.appConfig.secret, existing.configEnc) : {};
    current.oauthAccessToken = values.accessToken;
    if (values.refreshToken) current.oauthRefreshToken = values.refreshToken;
    if (values.expiresAt !== undefined) current.oauthExpiresAt = values.expiresAt;
    const now = new Date();
    await this.db
      .insert(connectorSettings)
      .values({
        id: existing?.id ?? newId(),
        scopeKey,
        connectorRef,
        configEnc: encryptJson(this.appConfig.secret, current),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [connectorSettings.scopeKey, connectorSettings.connectorRef],
        set: { configEnc: encryptJson(this.appConfig.secret, current), updatedAt: now },
      });
  }

  async saveSettings(
    scopeKey: string,
    connectorRef: string,
    values: Record<string, unknown>,
    fields: ConnectorField[],
  ): Promise<Record<string, unknown>> {
    const existing = await this.db.query.connectorSettings.findFirst({
      where: and(
        eq(connectorSettings.scopeKey, scopeKey),
        eq(connectorSettings.connectorRef, connectorRef),
      ),
    });
    const current = existing ? decrypt(this.appConfig.secret, existing.configEnc) : {};
    for (const [key, value] of Object.entries(values)) {
      const field = fields.find((item) => item.key === key);
      if (!field) throw new Error(`未知设置字段: ${key}`);
      if (value === KEEP_VALUE || value === undefined) continue;
      if (typeof value !== "string") throw new Error(`${field.label} 必须是文本`);
      if (value === "") delete current[key];
      else current[key] = value;
    }
    const missing = missingRequiredFields(fields, current);
    if (missing.length) throw new Error(`缺少必填设置: ${missing.join("、")}`);

    const now = new Date();
    await this.db
      .insert(connectorSettings)
      .values({
        id: existing?.id ?? newId(),
        scopeKey,
        connectorRef,
        configEnc: encryptJson(this.appConfig.secret, current),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [connectorSettings.scopeKey, connectorSettings.connectorRef],
        set: { configEnc: encryptJson(this.appConfig.secret, current), updatedAt: now },
      });
    return current;
  }

  // ── Agent 安装（认证资源）──────────────────────────────────────────────

  async listInstallations(
    tenantId: string,
    opts?: { connectorRef?: string; agentId?: string },
  ): Promise<AgentConnectorInstallationView[]> {
    const conditions = [eq(agentConnectorInstallations.tenantId, tenantId)];
    if (opts?.connectorRef) {
      conditions.push(eq(agentConnectorInstallations.connectorRef, opts.connectorRef));
    }
    if (opts?.agentId) {
      conditions.push(eq(agentConnectorInstallations.agentId, opts.agentId));
    }
    const rows = await this.db
      .select()
      .from(agentConnectorInstallations)
      .where(and(...conditions));
    return rows.map((row) => {
      const values = decrypt(this.appConfig.secret, row.configEnc);
      return {
        id: row.id,
        agentId: row.agentId,
        connectorRef: row.connectorRef,
        enabled: row.enabled,
        authorized: hasUsableOauth(values),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  async getInstallationConfig(
    tenantId: string,
    agentId: string,
    connectorRef: string,
  ): Promise<Record<string, unknown>> {
    const row = await this.db.query.agentConnectorInstallations.findFirst({
      where: and(
        eq(agentConnectorInstallations.tenantId, tenantId),
        eq(agentConnectorInstallations.agentId, agentId),
        eq(agentConnectorInstallations.connectorRef, connectorRef),
      ),
    });
    return row ? decrypt(this.appConfig.secret, row.configEnc) : {};
  }

  async ensureInstallations(
    tenantId: string,
    connectorRef: string,
    agentIds: string[],
  ): Promise<void> {
    const unique = [...new Set(agentIds.map((id) => id.trim()).filter(Boolean))];
    if (!unique.length) throw new Error("请至少选择一个 Agent");
    const now = new Date();
    for (const agentId of unique) {
      const existing = await this.db.query.agentConnectorInstallations.findFirst({
        where: and(
          eq(agentConnectorInstallations.tenantId, tenantId),
          eq(agentConnectorInstallations.agentId, agentId),
          eq(agentConnectorInstallations.connectorRef, connectorRef),
        ),
      });
      if (existing) {
        if (!existing.enabled) {
          await this.db
            .update(agentConnectorInstallations)
            .set({ enabled: true, updatedAt: now })
            .where(eq(agentConnectorInstallations.id, existing.id));
        }
        continue;
      }
      await this.db.insert(agentConnectorInstallations).values({
        id: newId(),
        tenantId,
        agentId,
        connectorRef,
        enabled: true,
        configEnc: encryptJson(this.appConfig.secret, {}),
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  async removeInstallation(
    tenantId: string,
    connectorRef: string,
    agentId: string,
  ): Promise<void> {
    await this.db
      .delete(agentConnectorInstallations)
      .where(
        and(
          eq(agentConnectorInstallations.tenantId, tenantId),
          eq(agentConnectorInstallations.agentId, agentId),
          eq(agentConnectorInstallations.connectorRef, connectorRef),
        ),
      );
  }

  /**
   * OAuth 用户授权属于 Agent 安装的认证资源，不属于共享 OAuth 客户端档案。
   */
  async saveInstallationAuthorization(
    tenantId: string,
    agentId: string,
    connectorRef: string,
    values: {
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
    },
  ): Promise<void> {
    let row = await this.db.query.agentConnectorInstallations.findFirst({
      where: and(
        eq(agentConnectorInstallations.tenantId, tenantId),
        eq(agentConnectorInstallations.agentId, agentId),
        eq(agentConnectorInstallations.connectorRef, connectorRef),
      ),
    });
    if (!row) {
      await this.ensureInstallations(tenantId, connectorRef, [agentId]);
      row = await this.db.query.agentConnectorInstallations.findFirst({
        where: and(
          eq(agentConnectorInstallations.tenantId, tenantId),
          eq(agentConnectorInstallations.agentId, agentId),
          eq(agentConnectorInstallations.connectorRef, connectorRef),
        ),
      });
      if (!row) throw new Error("安装连接器失败");
    }
    const current = decrypt(this.appConfig.secret, row.configEnc);
    current.oauthAccessToken = values.accessToken;
    if (values.refreshToken) current.oauthRefreshToken = values.refreshToken;
    if (values.expiresAt !== undefined) current.oauthExpiresAt = values.expiresAt;
    await this.db
      .update(agentConnectorInstallations)
      .set({
        enabled: true,
        configEnc: encryptJson(this.appConfig.secret, current),
        updatedAt: new Date(),
      })
      .where(eq(agentConnectorInstallations.id, row.id));
  }
}
