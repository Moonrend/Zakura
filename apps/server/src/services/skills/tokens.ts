/**
 * 技能来源令牌：平台默认 + 租户自备，密文入库。
 *
 * GitHub 未鉴权只有 60 次/小时，SaaS 下很快就打满。这里提供两级令牌：
 *   - platform：整站默认，由平台管理员配置（也可用 GITHUB_TOKEN 环境变量兜底）
 *   - tenant：租户自备，仅用于该租户能看到的私有仓库
 *
 * 隔离原则：抓取先用平台令牌（或匿名），失败才升级到租户令牌；
 * 用租户令牌拿到的内容一律不写入跨租户共享缓存（见 cache.ts）。
 */
import { and, eq, inArray } from "drizzle-orm";
import { decryptJson, encryptJson } from "@zakura/core";
import type { SkillTokenInfo, SkillTokenProvider, SkillTokenScope } from "@zakura/shared";
import type { Db } from "../../db/client.js";
import { newId, skillSourceTokens, type SkillSourceTokenRow } from "../../db/schema.js";

export const PLATFORM_SCOPE = "platform";

function toInfo(row: SkillSourceTokenRow): SkillTokenInfo {
  return {
    scope: row.scopeKey === PLATFORM_SCOPE ? "platform" : "tenant",
    provider: row.provider === "gitlab" ? "gitlab" : "github",
    hint: row.hint,
    label: row.label,
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

export class SkillTokenStore {
  private readonly db: Db;
  private readonly secret: string;
  /** 环境变量兜底的平台令牌（OSS 部署常用） */
  private readonly envToken: string | undefined;

  constructor(deps: { db: Db; secret: string; envToken?: string | undefined }) {
    this.db = deps.db;
    this.secret = deps.secret;
    this.envToken = deps.envToken?.trim() || undefined;
  }

  private async read(
    scopeKey: string,
    provider: SkillTokenProvider,
  ): Promise<string | undefined> {
    const row = await this.db.query.skillSourceTokens.findFirst({
      where: and(
        eq(skillSourceTokens.scopeKey, scopeKey),
        eq(skillSourceTokens.provider, provider),
      ),
    });
    if (!row) return undefined;
    try {
      return decryptJson<{ token: string }>(this.secret, row.tokenEnc).token || undefined;
    } catch {
      return undefined;
    }
  }

  /** 平台默认令牌：数据库优先，其次 GITHUB_TOKEN 环境变量 */
  async platformToken(provider: SkillTokenProvider = "github"): Promise<string | undefined> {
    return (await this.read(PLATFORM_SCOPE, provider)) ?? (provider === "github" ? this.envToken : undefined);
  }

  /** 租户自备令牌（没有则 undefined） */
  async tenantToken(
    tenantId: string,
    provider: SkillTokenProvider = "github",
  ): Promise<string | undefined> {
    return this.read(tenantId, provider);
  }

  /** 界面展示：平台条目仅在 includePlatform 时返回 */
  async list(tenantId: string, includePlatform: boolean): Promise<SkillTokenInfo[]> {
    const scopes = includePlatform ? [tenantId, PLATFORM_SCOPE] : [tenantId];
    const rows = await this.db
      .select()
      .from(skillSourceTokens)
      .where(inArray(skillSourceTokens.scopeKey, scopes));
    const infos = rows.map(toInfo);
    // 环境变量配置的平台令牌也要让管理员看到，否则会误以为没配
    if (includePlatform && this.envToken && !infos.some((i) => i.scope === "platform")) {
      infos.push({
        scope: "platform",
        provider: "github",
        hint: this.envToken.slice(-4),
        label: "GITHUB_TOKEN 环境变量",
        updatedAt: new Date(0).toISOString(),
        lastUsedAt: null,
      });
    }
    return infos;
  }

  async set(opts: {
    scope: SkillTokenScope;
    tenantId: string;
    provider: SkillTokenProvider;
    token: string;
    label?: string | undefined;
  }): Promise<SkillTokenInfo> {
    const token = opts.token.trim();
    if (!token) throw new Error("令牌不能为空");
    const scopeKey = opts.scope === "platform" ? PLATFORM_SCOPE : opts.tenantId;
    const now = new Date();
    const values = {
      scopeKey,
      provider: opts.provider,
      tokenEnc: encryptJson(this.secret, { token }),
      label: opts.label?.trim() || null,
      hint: token.slice(-4),
      updatedAt: now,
    };

    const existing = await this.db.query.skillSourceTokens.findFirst({
      where: and(
        eq(skillSourceTokens.scopeKey, scopeKey),
        eq(skillSourceTokens.provider, opts.provider),
      ),
    });
    if (existing) {
      await this.db
        .update(skillSourceTokens)
        .set(values)
        .where(eq(skillSourceTokens.id, existing.id));
      return toInfo({ ...existing, ...values });
    }
    const row = { id: newId(), ...values, lastUsedAt: null, createdAt: now };
    await this.db.insert(skillSourceTokens).values(row);
    return toInfo(row as SkillSourceTokenRow);
  }

  async remove(
    scope: SkillTokenScope,
    tenantId: string,
    provider: SkillTokenProvider,
  ): Promise<void> {
    const scopeKey = scope === "platform" ? PLATFORM_SCOPE : tenantId;
    await this.db
      .delete(skillSourceTokens)
      .where(
        and(
          eq(skillSourceTokens.scopeKey, scopeKey),
          eq(skillSourceTokens.provider, provider),
        ),
      );
  }

  /** 记录使用时间，方便管理员判断令牌是否还在被用 */
  async markUsed(scopeKey: string, provider: SkillTokenProvider): Promise<void> {
    await this.db
      .update(skillSourceTokens)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(skillSourceTokens.scopeKey, scopeKey),
          eq(skillSourceTokens.provider, provider),
        ),
      )
      .catch(() => undefined);
  }
}
