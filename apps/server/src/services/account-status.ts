import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { tenants, users } from "../db/schema.js";

/**
 * 平台封号（suspend）判定。
 *
 * 会话 token 是无状态签名的，封号后旧 token 仍能通过签名校验，
 * 所以每个请求都要回查一次账号状态。为了不给每个请求加一次 DB 往返，
 * 这里沿用 services/auth.ts 里 apiKeyAuthCache 的做法：进程内 TTL 缓存 +
 * 写操作后显式失效。多实例部署下最坏情况是封号延迟一个 TTL 生效。
 */

export type SuspensionInfo = {
  /** 被封的是账号还是所在团队 */
  scope: "user" | "tenant";
  reason: string | null;
  suspendedAt: Date;
};

const TTL_MS = 15_000;

type UserEntry = { suspendedAt: Date | null; reason: string | null; expiresAt: number };
type TenantEntry = { suspendedAt: Date | null; reason: string | null; expiresAt: number };

const userCache = new Map<string, UserEntry>();
const tenantCache = new Map<string, TenantEntry>();

/** 封号/解封写操作后调用，让缓存立即失效 */
export function invalidateUserSuspension(userId: string): void {
  userCache.delete(userId);
}

/** 团队封禁/解封写操作后调用 */
export function invalidateTenantSuspension(tenantId: string): void {
  tenantCache.delete(tenantId);
}

export function invalidateAllSuspensions(): void {
  userCache.clear();
  tenantCache.clear();
}

async function readUser(db: Db, userId: string): Promise<UserEntry> {
  const cached = userCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const row = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const entry: UserEntry = {
    suspendedAt: row?.suspendedAt ?? null,
    reason: row?.suspendedReason ?? null,
    expiresAt: Date.now() + TTL_MS,
  };
  userCache.set(userId, entry);
  return entry;
}

async function readTenant(db: Db, tenantId: string): Promise<TenantEntry> {
  const cached = tenantCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const row = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  const entry: TenantEntry = {
    suspendedAt: row?.suspendedAt ?? null,
    reason: row?.suspendedReason ?? null,
    expiresAt: Date.now() + TTL_MS,
  };
  tenantCache.set(tenantId, entry);
  return entry;
}

/**
 * 会话是否因封号被拒。API key 会话（userId === "api-key"）只查团队。
 * 返回 null 表示放行。
 */
export async function checkSessionSuspended(
  db: Db,
  session: { userId: string; tenantId: string },
): Promise<SuspensionInfo | null> {
  if (session.userId && session.userId !== "api-key") {
    const user = await readUser(db, session.userId);
    if (user.suspendedAt) {
      return { scope: "user", reason: user.reason, suspendedAt: user.suspendedAt };
    }
  }
  if (session.tenantId) {
    const tenant = await readTenant(db, session.tenantId);
    if (tenant.suspendedAt) {
      return { scope: "tenant", reason: tenant.reason, suspendedAt: tenant.suspendedAt };
    }
  }
  return null;
}

/** 登录/换团队路径用：绕过缓存直接读，避免刚解封还登不上 */
export async function isUserSuspended(db: Db, userId: string): Promise<boolean> {
  const row = await db.query.users.findFirst({ where: eq(users.id, userId) });
  return !!row?.suspendedAt;
}

export async function isTenantSuspended(db: Db, tenantId: string): Promise<boolean> {
  const row = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  return !!row?.suspendedAt;
}

/** 统一的对外文案：不透露是账号还是团队被封之外的细节 */
export function suspensionMessage(info: SuspensionInfo): string {
  const base = info.scope === "user" ? "账号已被封禁" : "所在团队已被封禁";
  return info.reason ? `${base}：${info.reason}` : base;
}
