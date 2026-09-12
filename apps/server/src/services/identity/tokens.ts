import { and, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { authTokens, newId } from "../../db/schema.js";
import { hashToken, newSecretToken, parseJsonObject } from "./util.js";

export type AuthTokenKind = "email_verify" | "password_reset" | "mfa_login" | "sso_exchange";

const TTL_MS: Record<AuthTokenKind, number> = {
  email_verify: 48 * 60 * 60 * 1000,
  password_reset: 60 * 60 * 1000,
  mfa_login: 5 * 60 * 1000,
  sso_exchange: 5 * 60 * 1000,
};

export async function issueAuthToken(
  db: Db,
  input: {
    kind: AuthTokenKind;
    userId?: string | null;
    meta?: Record<string, unknown>;
    ttlMs?: number;
  },
): Promise<string> {
  const raw = newSecretToken("atk");
  const now = Date.now();
  await db.insert(authTokens).values({
    id: newId(),
    userId: input.userId ?? null,
    kind: input.kind,
    tokenHash: hashToken(raw),
    expiresAt: new Date(now + (input.ttlMs ?? TTL_MS[input.kind])),
    metaJson: JSON.stringify(input.meta ?? {}),
    createdAt: new Date(now),
  });
  return raw;
}

export async function consumeAuthToken(
  db: Db,
  kind: AuthTokenKind,
  raw: string,
): Promise<{ userId: string | null; meta: Record<string, unknown> } | null> {
  const tokenHash = hashToken(raw);
  const row = await db.query.authTokens.findFirst({
    where: and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.kind, kind)),
  });
  if (!row) return null;
  if (row.consumedAt) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  await db
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(eq(authTokens.id, row.id));
  return { userId: row.userId, meta: parseJsonObject(row.metaJson) };
}

export async function peekAuthToken(
  db: Db,
  kind: AuthTokenKind,
  raw: string,
): Promise<{ userId: string | null; meta: Record<string, unknown>; id: string } | null> {
  const tokenHash = hashToken(raw);
  const row = await db.query.authTokens.findFirst({
    where: and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.kind, kind), isNull(authTokens.consumedAt)),
  });
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  return { userId: row.userId, meta: parseJsonObject(row.metaJson), id: row.id };
}

export async function purgeExpiredAuthTokens(db: Db): Promise<void> {
  await db.delete(authTokens).where(lt(authTokens.expiresAt, new Date()));
}
