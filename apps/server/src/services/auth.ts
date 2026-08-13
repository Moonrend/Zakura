import { and, asc, eq } from "drizzle-orm";
import { hashApiKey } from "@zakura/core";
import bcrypt from "bcryptjs";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/client.js";
import {
  apiKeys,
  tenantMemberships,
  tenants,
  users,
  type ApiKey,
  type Tenant,
  type TenantMembership,
  type User,
} from "../db/schema.js";
import { REDIS_KEYS } from "./redis.js";
import { redisGetJson, redisSetJson, REDIS_TTL } from "./redis-store.js";
import { recordUserUsage } from "./user-usage.js";

export interface SessionPayload {
  userId: string;
  tenantId: string;
  email: string;
  /** Tenant membership role: owner | admin | member | api_key */
  role: string;
  isPlatformAdmin?: boolean;
  exp: number;
}

export function signSession(
  secret: string,
  payload: Omit<SessionPayload, "exp">,
  ttlSec = 60 * 60 * 24 * 7,
) {
  const body: SessionPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const data = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifySession(secret: string, token: string): SessionPayload | null {
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = createHmac("sha256", secret).update(data).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as SessionPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export type LoginResult = {
  user: User;
  tenant: Tenant;
  membership: TenantMembership;
};

/** 密码正确但账号/团队被封时抛出；路由层映射为 403 + code。 */
export class LoginBlockedError extends Error {
  readonly status = 403 as const;
  readonly code = "account_suspended" as const;
  constructor(message: string) {
    super(message);
    this.name = "LoginBlockedError";
  }
}

/**
 * Authenticate by global email + password, then resolve a tenant membership.
 * - With tenantSlug/tenantId: use that tenant
 * - Without: first active membership (earliest joined); prefer isDefault tenant if any
 *
 * 封号文案只在密码校验通过后返回，避免被用来枚举账号。
 */
export async function loginUser(
  db: Db,
  email: string,
  password: string,
  opts?: { tenantSlug?: string; tenantId?: string },
): Promise<LoginResult | null> {
  const normalized = email.toLowerCase();
  const user = await db.query.users.findFirst({
    where: eq(users.email, normalized),
  });
  if (!user) return null;
  if (!user.passwordHash) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;

  if (user.suspendedAt) {
    const base = "账号已被封禁";
    throw new LoginBlockedError(user.suspendedReason ? `${base}：${user.suspendedReason}` : base);
  }

  const memberships = await db
    .select({
      membership: tenantMemberships,
      tenant: tenants,
    })
    .from(tenantMemberships)
    .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
    .where(
      and(eq(tenantMemberships.userId, user.id), eq(tenantMemberships.status, "active")),
    )
    .orderBy(asc(tenantMemberships.createdAt));

  if (memberships.length === 0) return null;

  // 被封禁的团队不参与自动挑选
  const selectable = memberships.filter((m) => !m.tenant.suspendedAt);
  if (selectable.length === 0) {
    throw new LoginBlockedError("所在团队已被封禁");
  }

  let picked = selectable.find((m) => m.tenant.isDefault) ?? selectable[0];
  if (opts?.tenantId) {
    const match = selectable.find((m) => m.tenant.id === opts.tenantId);
    if (!match) return null;
    picked = match;
  } else if (opts?.tenantSlug) {
    const match = selectable.find((m) => m.tenant.slug === opts.tenantSlug);
    if (!match) return null;
    picked = match;
  }

  recordUserUsage({
    tenantId: picked.tenant.id,
    userId: user.id,
    category: "auth",
    action: "login",
    summary: "password",
  });

  return {
    user,
    tenant: picked.tenant,
    membership: picked.membership,
  };
}

export function sessionFromLogin(
  secret: string,
  result: LoginResult,
): string {
  recordUserUsage({
    tenantId: result.tenant.id,
    userId: result.user.id,
    category: "auth",
    action: "login",
    summary: "session",
  });
  return signSession(secret, {
    userId: result.user.id,
    tenantId: result.tenant.id,
    email: result.user.email,
    role: result.membership.role,
    isPlatformAdmin: result.user.isPlatformAdmin,
  });
}

export async function switchTenantSession(
  db: Db,
  secret: string,
  userId: string,
  tenantId: string,
): Promise<string | null> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return null;
  if (user.suspendedAt) return null;
  const membership = await db.query.tenantMemberships.findFirst({
    where: and(
      eq(tenantMemberships.userId, userId),
      eq(tenantMemberships.tenantId, tenantId),
      eq(tenantMemberships.status, "active"),
    ),
  });
  if (!membership) return null;
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
  });
  if (!tenant) return null;
  if (tenant.suspendedAt) return null;
  return signSession(secret, {
    userId: user.id,
    tenantId: tenant.id,
    email: user.email,
    role: membership.role,
    isPlatformAdmin: user.isPlatformAdmin,
  });
}

export async function authenticateApiKey(
  db: Db,
  rawKey: string,
): Promise<{ apiKey: ApiKey; tenant: Tenant } | null> {
  const keyHash = hashApiKey(rawKey);

  // Redis 短缓存（跨实例）；进程内再挡一层
  const mem = apiKeyAuthCache.get(keyHash);
  if (mem && mem.expiresAt > Date.now()) {
    touchApiKeyLastUsed(db, mem.apiKey.id);
    return { apiKey: mem.apiKey, tenant: mem.tenant };
  }

  const fromRedis = await redisGetJson<{ apiKey: ApiKey; tenant: Tenant }>(
    REDIS_KEYS.auth(keyHash),
  );
  if (fromRedis?.apiKey?.id && fromRedis?.tenant?.id) {
    apiKeyAuthCache.set(keyHash, {
      apiKey: fromRedis.apiKey,
      tenant: fromRedis.tenant,
      expiresAt: Date.now() + API_KEY_AUTH_TTL_MS,
    });
    touchApiKeyLastUsed(db, fromRedis.apiKey.id);
    return { apiKey: fromRedis.apiKey, tenant: fromRedis.tenant };
  }

  const apiKey = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.keyHash, keyHash),
  });
  if (!apiKey) return null;
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null;

  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, apiKey.tenantId),
  });
  if (!tenant) return null;

  apiKeyAuthCache.set(keyHash, {
    apiKey,
    tenant,
    expiresAt: Date.now() + API_KEY_AUTH_TTL_MS,
  });
  void redisSetJson(REDIS_KEYS.auth(keyHash), { apiKey, tenant }, REDIS_TTL.auth);
  touchApiKeyLastUsed(db, apiKey.id);
  return { apiKey, tenant };
}

const API_KEY_AUTH_TTL_MS = 30_000;
const apiKeyAuthCache = new Map<
  string,
  { apiKey: ApiKey; tenant: Tenant; expiresAt: number }
>();
const lastUsedThrottle = new Map<string, number>();

function touchApiKeyLastUsed(db: Db, apiKeyId: string): void {
  const now = Date.now();
  const prev = lastUsedThrottle.get(apiKeyId) ?? 0;
  if (now - prev < 60_000) return;
  lastUsedThrottle.set(apiKeyId, now);
  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, apiKeyId))
    .catch(() => {});
}

export function hasApiKeyScope(apiKey: { scopes: string }, required: string): boolean {
  try {
    const scopes = JSON.parse(apiKey.scopes);
    return Array.isArray(scopes) && scopes.some((scope) => scope === "*" || scope === required);
  } catch {
    return false;
  }
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

export function isSessionAdmin(session: { role: string; userId: string }): boolean {
  return (
    session.userId !== "api-key" &&
    (session.role === "admin" || session.role === "owner")
  );
}
