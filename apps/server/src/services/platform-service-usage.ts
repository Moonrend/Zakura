import { and, eq } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { newId, platformServiceQuotas, platformServiceUsage } from "../db/schema.js";
import type { PlatformServiceKey } from "@zakura/shared";

export const PLATFORM_QUOTA_SCOPE = "__platform__";

export class QuotaExceededError extends Error {
  constructor(
    message: string,
    public readonly serviceKey: string,
    public readonly period: string,
    public readonly limit: number,
  ) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

function monthPeriod(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function dayPeriod(d = new Date()): string {
  return `${monthPeriod(d)}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export type ResolvedQuota = {
  monthlyLimit: number | null;
  dailyLimit: number | null;
  source: "tenant" | "platform" | "none";
};

export class PlatformServiceUsageService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {}

  /** OSS: no enforcement. SaaS: check + increment. */
  async checkAndIncrement(opts: {
    tenantId: string;
    userId?: string | null;
    serviceKey: PlatformServiceKey | string;
  }): Promise<void> {
    if (!this.config.multiTenant) return;

    const quota = await this.resolveQuota(opts.tenantId, opts.serviceKey);
    const now = new Date();
    const month = monthPeriod(now);
    const day = dayPeriod(now);
    const userId = opts.userId?.trim() ?? "";

    if (quota.monthlyLimit != null) {
      const used = await this.getCount(opts.tenantId, opts.serviceKey, month);
      if (used >= quota.monthlyLimit) {
        throw new QuotaExceededError(
          `托管服务 ${opts.serviceKey} 已达月限额（${used}/${quota.monthlyLimit}）`,
          opts.serviceKey,
          month,
          quota.monthlyLimit,
        );
      }
    }
    if (quota.dailyLimit != null) {
      const used = await this.getCount(opts.tenantId, opts.serviceKey, day);
      if (used >= quota.dailyLimit) {
        throw new QuotaExceededError(
          `托管服务 ${opts.serviceKey} 已达日限额（${used}/${quota.dailyLimit}）`,
          opts.serviceKey,
          day,
          quota.dailyLimit,
        );
      }
    }

    await this.bump(opts.tenantId, userId, opts.serviceKey, month, false);
    await this.bump(opts.tenantId, userId, opts.serviceKey, day, false);
  }

  async recordError(opts: {
    tenantId: string;
    userId?: string | null;
    serviceKey: string;
  }): Promise<void> {
    if (!this.config.multiTenant) return;
    const now = new Date();
    const userId = opts.userId?.trim() ?? "";
    await this.bump(opts.tenantId, userId, opts.serviceKey, monthPeriod(now), true);
    await this.bump(opts.tenantId, userId, opts.serviceKey, dayPeriod(now), true);
  }

  async resolveQuota(tenantId: string, serviceKey: string): Promise<ResolvedQuota> {
    const tenantExact = await this.db.query.platformServiceQuotas.findFirst({
      where: and(
        eq(platformServiceQuotas.scopeKey, tenantId),
        eq(platformServiceQuotas.serviceKey, serviceKey),
      ),
    });
    if (tenantExact) {
      return {
        monthlyLimit: tenantExact.monthlyLimit,
        dailyLimit: tenantExact.dailyLimit,
        source: "tenant",
      };
    }
    const tenantStar = await this.db.query.platformServiceQuotas.findFirst({
      where: and(
        eq(platformServiceQuotas.scopeKey, tenantId),
        eq(platformServiceQuotas.serviceKey, "*"),
      ),
    });
    if (tenantStar) {
      return {
        monthlyLimit: tenantStar.monthlyLimit,
        dailyLimit: tenantStar.dailyLimit,
        source: "tenant",
      };
    }
    const platExact = await this.db.query.platformServiceQuotas.findFirst({
      where: and(
        eq(platformServiceQuotas.scopeKey, PLATFORM_QUOTA_SCOPE),
        eq(platformServiceQuotas.serviceKey, serviceKey),
      ),
    });
    if (platExact) {
      return {
        monthlyLimit: platExact.monthlyLimit,
        dailyLimit: platExact.dailyLimit,
        source: "platform",
      };
    }
    const platStar = await this.db.query.platformServiceQuotas.findFirst({
      where: and(
        eq(platformServiceQuotas.scopeKey, PLATFORM_QUOTA_SCOPE),
        eq(platformServiceQuotas.serviceKey, "*"),
      ),
    });
    if (platStar) {
      return {
        monthlyLimit: platStar.monthlyLimit,
        dailyLimit: platStar.dailyLimit,
        source: "platform",
      };
    }
    return { monthlyLimit: null, dailyLimit: null, source: "none" };
  }

  async listQuotas(scopeKey?: string) {
    if (scopeKey) {
      return this.db.query.platformServiceQuotas.findMany({
        where: eq(platformServiceQuotas.scopeKey, scopeKey),
      });
    }
    return this.db.query.platformServiceQuotas.findMany();
  }

  async upsertQuota(input: {
    scopeKey: string;
    serviceKey: string;
    monthlyLimit?: number | null;
    dailyLimit?: number | null;
  }) {
    const existing = await this.db.query.platformServiceQuotas.findFirst({
      where: and(
        eq(platformServiceQuotas.scopeKey, input.scopeKey),
        eq(platformServiceQuotas.serviceKey, input.serviceKey),
      ),
    });
    const now = new Date();
    if (existing) {
      const [row] = await this.db
        .update(platformServiceQuotas)
        .set({
          monthlyLimit:
            input.monthlyLimit === undefined ? existing.monthlyLimit : input.monthlyLimit,
          dailyLimit: input.dailyLimit === undefined ? existing.dailyLimit : input.dailyLimit,
          updatedAt: now,
        })
        .where(eq(platformServiceQuotas.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await this.db
      .insert(platformServiceQuotas)
      .values({
        id: newId(),
        scopeKey: input.scopeKey,
        serviceKey: input.serviceKey,
        monthlyLimit: input.monthlyLimit ?? null,
        dailyLimit: input.dailyLimit ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row;
  }

  async usageSummary(opts: {
    tenantId?: string;
    serviceKey?: string;
    periodPrefix?: string;
  }) {
    const rows = await this.db.query.platformServiceUsage.findMany();
    return rows.filter((r) => {
      if (opts.tenantId && r.tenantId !== opts.tenantId) return false;
      if (opts.serviceKey && r.serviceKey !== opts.serviceKey) return false;
      if (opts.periodPrefix && !r.period.startsWith(opts.periodPrefix)) return false;
      return true;
    });
  }

  private async getCount(
    tenantId: string,
    serviceKey: string,
    period: string,
  ): Promise<number> {
    const rows = await this.db.query.platformServiceUsage.findMany({
      where: and(
        eq(platformServiceUsage.tenantId, tenantId),
        eq(platformServiceUsage.serviceKey, serviceKey),
        eq(platformServiceUsage.period, period),
      ),
    });
    return rows.reduce((sum, r) => sum + (r.requestCount ?? 0), 0);
  }

  private async bump(
    tenantId: string,
    userId: string,
    serviceKey: string,
    period: string,
    asError: boolean,
  ) {
    const existing = await this.db.query.platformServiceUsage.findFirst({
      where: and(
        eq(platformServiceUsage.tenantId, tenantId),
        eq(platformServiceUsage.userId, userId),
        eq(platformServiceUsage.serviceKey, serviceKey),
        eq(platformServiceUsage.period, period),
      ),
    });
    const now = new Date();
    if (existing) {
      await this.db
        .update(platformServiceUsage)
        .set({
          requestCount: asError ? existing.requestCount : existing.requestCount + 1,
          errorCount: asError ? existing.errorCount + 1 : existing.errorCount,
          updatedAt: now,
        })
        .where(eq(platformServiceUsage.id, existing.id));
      return;
    }
    await this.db.insert(platformServiceUsage).values({
      id: newId(),
      tenantId,
      userId,
      serviceKey,
      period,
      requestCount: asError ? 0 : 1,
      errorCount: asError ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    });
  }
}
