import { and, desc, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { userSessions, users } from "../../db/schema.js";
import type { SessionPayload } from "../auth.js";

export function sessionInvalidatedByPassword(
  iat: number | undefined,
  passwordUpdatedAt: Date | null | undefined,
): boolean {
  if (!passwordUpdatedAt) return false;
  const cutoff = Math.floor(passwordUpdatedAt.getTime() / 1000);
  if (iat == null) return true;
  return iat < cutoff;
}

export async function assertSessionAlive(
  db: Db,
  payload: SessionPayload,
): Promise<SessionPayload | null> {
  if (payload.userId === "api-key") return payload;
  const user = await db.query.users.findFirst({ where: eq(users.id, payload.userId) });
  if (!user) return null;
  if (sessionInvalidatedByPassword(payload.iat, user.passwordUpdatedAt)) return null;

  if (!payload.sid) {
    // 旧令牌：改密后一律失效，否则继续放行直到自然过期。
    return payload;
  }
  const row = await db.query.userSessions.findFirst({
    where: eq(userSessions.id, payload.sid),
  });
  if (!row) return null;
  if (row.userId !== payload.userId) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return payload;
}

export async function listUserSessions(db: Db, userId: string, currentSid?: string) {
  const rows = await db
    .select()
    .from(userSessions)
    .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)))
    .orderBy(desc(userSessions.createdAt))
    .limit(50);
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenantId,
    userAgent: row.userAgent,
    ip: row.ip,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    current: currentSid === row.id,
  }));
}

export async function revokeUserSession(db: Db, userId: string, sid: string): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(userSessions)
    .set({ revokedAt: now })
    .where(and(eq(userSessions.id, sid), eq(userSessions.userId, userId), isNull(userSessions.revokedAt)))
    .returning();
  return rows.length > 0;
}

export async function revokeAllUserSessions(db: Db, userId: string, exceptSid?: string): Promise<number> {
  const now = new Date();
  const rows = await db.query.userSessions.findMany({
    where: and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)),
  });
  let count = 0;
  for (const row of rows) {
    if (exceptSid && row.id === exceptSid) continue;
    await db.update(userSessions).set({ revokedAt: now }).where(eq(userSessions.id, row.id));
    count += 1;
  }
  return count;
}

export async function touchLastLogin(db: Db, userId: string): Promise<void> {
  await db.update(users).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function purgeExpiredUserSessions(db: Db): Promise<void> {
  await db.delete(userSessions).where(lt(userSessions.expiresAt, new Date()));
}
