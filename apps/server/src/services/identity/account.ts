import bcrypt from "bcryptjs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { tenantMemberships, users } from "../../db/schema.js";
import { consumeAuthToken, issueAuthToken } from "./tokens.js";
import { sendResetPasswordEmail, sendVerifyEmail } from "./mail.js";
import { revokeAllUserSessions } from "./sessions.js";

export const TITLE_MAX = 80;
export const BIO_MAX = 280;

export type ProfilePatch = {
  name?: string;
  title?: string;
  bio?: string;
};

export function normalizeProfilePatch(input: ProfilePatch): {
  name?: string | null;
  title?: string | null;
  bio?: string | null;
} {
  const patch: { name?: string | null; title?: string | null; bio?: string | null } = {};
  if (typeof input.name === "string") patch.name = input.name.trim() || null;
  if (typeof input.title === "string") {
    const title = input.title.trim();
    if (title.length > TITLE_MAX) throw new Error(`头衔最多 ${TITLE_MAX} 字`);
    patch.title = title || null;
  }
  if (typeof input.bio === "string") {
    const bio = input.bio.trim();
    if (bio.length > BIO_MAX) throw new Error(`简介最多 ${BIO_MAX} 字`);
    patch.bio = bio || null;
  }
  return patch;
}

export function publicPerson(row: {
  id: string;
  email: string;
  name: string | null;
  title: string | null;
  bio: string | null;
  avatarUpdatedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  role: string;
  joinedAt: Date;
}) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    title: row.title,
    bio: row.bio,
    avatarRev: row.avatarUpdatedAt ? row.avatarUpdatedAt.getTime() : 0,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    role: row.role,
    joinedAt: row.joinedAt.toISOString(),
  };
}

export async function requestEmailVerification(
  db: Db,
  webPublicUrl: string,
  user: { id: string; email: string; emailVerifiedAt: Date | null },
): Promise<boolean> {
  if (user.emailVerifiedAt) return true;
  const token = await issueAuthToken(db, { kind: "email_verify", userId: user.id });
  const verifyUrl = `${webPublicUrl}/verify-email?token=${encodeURIComponent(token)}`;
  return sendVerifyEmail(user.email, verifyUrl);
}

export async function confirmEmailVerification(db: Db, token: string): Promise<boolean> {
  const consumed = await consumeAuthToken(db, "email_verify", token);
  if (!consumed?.userId) return false;
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, consumed.userId));
  return true;
}

export async function requestPasswordReset(db: Db, webPublicUrl: string, email: string): Promise<void> {
  const user = await db.query.users.findFirst({
    where: eq(users.email, email.trim().toLowerCase()),
  });
  if (!user?.passwordHash) return;
  const token = await issueAuthToken(db, { kind: "password_reset", userId: user.id });
  const resetUrl = `${webPublicUrl}/reset-password?token=${encodeURIComponent(token)}`;
  await sendResetPasswordEmail(user.email, resetUrl).catch(() => false);
}

export async function completePasswordReset(db: Db, token: string, password: string): Promise<boolean> {
  if (!password || password.length < 8) throw new Error("密码至少 8 位");
  const consumed = await consumeAuthToken(db, "password_reset", token);
  if (!consumed?.userId) return false;
  const passwordHash = await bcrypt.hash(password, 12);
  const now = new Date();
  await db
    .update(users)
    .set({ passwordHash, passwordUpdatedAt: now, updatedAt: now })
    .where(eq(users.id, consumed.userId));
  await revokeAllUserSessions(db, consumed.userId);
  return true;
}

export async function changePassword(
  db: Db,
  userId: string,
  currentPassword: string,
  nextPassword: string,
): Promise<void> {
  if (!nextPassword || nextPassword.length < 8) throw new Error("密码至少 8 位");
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user?.passwordHash) throw new Error("该账号未设置密码");
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) throw new Error("当前密码不正确");
  const passwordHash = await bcrypt.hash(nextPassword, 12);
  const now = new Date();
  await db
    .update(users)
    .set({ passwordHash, passwordUpdatedAt: now, updatedAt: now })
    .where(eq(users.id, userId));
  await revokeAllUserSessions(db, userId);
}

export async function changeName(db: Db, userId: string, name: string): Promise<void> {
  await updateProfile(db, userId, { name });
}

export async function updateProfile(db: Db, userId: string, input: ProfilePatch): Promise<void> {
  const patch = normalizeProfilePatch(input);
  if (Object.keys(patch).length === 0) return;
  await db.update(users).set({ ...patch, updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function listTenantPeople(db: Db, tenantId: string) {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      title: users.title,
      bio: users.bio,
      avatarUpdatedAt: users.avatarUpdatedAt,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
      role: tenantMemberships.role,
      joinedAt: tenantMemberships.createdAt,
    })
    .from(tenantMemberships)
    .innerJoin(users, eq(users.id, tenantMemberships.userId))
    .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.status, "active")))
    .orderBy(asc(tenantMemberships.createdAt));
  return rows.map(publicPerson);
}

export async function getTenantPerson(db: Db, tenantId: string, userId: string) {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      title: users.title,
      bio: users.bio,
      avatarUpdatedAt: users.avatarUpdatedAt,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
      role: tenantMemberships.role,
      joinedAt: tenantMemberships.createdAt,
    })
    .from(tenantMemberships)
    .innerJoin(users, eq(users.id, tenantMemberships.userId))
    .where(
      and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.userId, userId),
        eq(tenantMemberships.status, "active"),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? publicPerson(row) : null;
}

const AVATAR_ID = /^[\w-]{1,64}$/;
const AVATAR_MAX_BYTES = 256 * 1024;

export function avatarFilePath(dataDir: string, userId: string): string {
  if (!AVATAR_ID.test(userId)) throw new Error("无效用户");
  return join(dataDir, "avatars", userId);
}

function isJpeg(buf: Uint8Array): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

export async function saveUserAvatar(
  db: Db,
  dataDir: string,
  userId: string,
  bytes: Uint8Array,
): Promise<number> {
  if (bytes.byteLength === 0 || bytes.byteLength > AVATAR_MAX_BYTES) {
    throw new Error("图片须小于 256KB");
  }
  if (!isJpeg(bytes)) throw new Error("请上传 JPEG 图片");
  const dir = join(dataDir, "avatars");
  await mkdir(dir, { recursive: true });
  await writeFile(avatarFilePath(dataDir, userId), bytes);
  const now = new Date();
  await db.update(users).set({ avatarUpdatedAt: now, updatedAt: now }).where(eq(users.id, userId));
  return now.getTime();
}

export async function clearUserAvatar(db: Db, dataDir: string, userId: string): Promise<void> {
  await unlink(avatarFilePath(dataDir, userId)).catch(() => {});
  await db.update(users).set({ avatarUpdatedAt: null, updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function readUserAvatar(dataDir: string, userId: string): Promise<Buffer | null> {
  if (!AVATAR_ID.test(userId)) return null;
  try {
    return await readFile(avatarFilePath(dataDir, userId));
  } catch {
    return null;
  }
}

export { AVATAR_ID, AVATAR_MAX_BYTES };
