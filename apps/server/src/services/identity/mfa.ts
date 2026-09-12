import { eq, and } from "drizzle-orm";
import { Secret, TOTP } from "otpauth";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Db } from "../../db/client.js";
import {
  newId,
  userRecoveryCodes,
  userTotp,
  userWebauthnCredentials,
  users,
} from "../../db/schema.js";
import { encryptJson, decryptJson } from "@zakura/core";
import { hashToken, newSecretToken, rpFromWebUrl } from "./util.js";

const pendingChallenge = new Map<string, { challenge: string; expiresAt: number }>();

function setChallenge(key: string, challenge: string) {
  pendingChallenge.set(key, { challenge, expiresAt: Date.now() + 5 * 60 * 1000 });
}

function takeChallenge(key: string): string | null {
  const row = pendingChallenge.get(key);
  pendingChallenge.delete(key);
  if (!row || row.expiresAt < Date.now()) return null;
  return row.challenge;
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export async function mfaStatus(db: Db, userId: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const creds = await db.query.userWebauthnCredentials.findMany({
    where: eq(userWebauthnCredentials.userId, userId),
  });
  return {
    totp: Boolean(user?.totpEnabledAt),
    webauthn: creds.length > 0,
    methods: [
      ...(user?.totpEnabledAt ? (["totp"] as const) : []),
      ...(creds.length ? (["webauthn"] as const) : []),
    ] as Array<"totp" | "webauthn">,
    credentials: creds.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export function mfaRequired(status: { totp: boolean; webauthn: boolean }): boolean {
  return status.totp || status.webauthn;
}

export async function startTotpSetup(db: Db, secret: string, user: { id: string; email: string }) {
  const totpSecret = new Secret({ size: 20 });
  const totp = new TOTP({
    issuer: "Zakura",
    label: user.email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: totpSecret,
  });
  const secretEnc = encryptJson(secret, totpSecret.base32);
  const existing = await db.query.userTotp.findFirst({ where: eq(userTotp.userId, user.id) });
  if (existing) {
    await db.update(userTotp).set({ secretEnc, enabledAt: null }).where(eq(userTotp.userId, user.id));
  } else {
    await db.insert(userTotp).values({
      userId: user.id,
      secretEnc,
      enabledAt: null,
      createdAt: new Date(),
    });
  }
  return { secret: totpSecret.base32, otpauthUrl: totp.toString() };
}

export async function enableTotp(db: Db, appSecret: string, userId: string, code: string) {
  const row = await db.query.userTotp.findFirst({ where: eq(userTotp.userId, userId) });
  if (!row) throw new Error("请先开始绑定验证器");
  const base32 = decryptJson<string>(appSecret, row.secretEnc);
  if (!verifyTotpCode(base32, code)) throw new Error("验证码不正确");
  const now = new Date();
  await db.update(userTotp).set({ enabledAt: now }).where(eq(userTotp.userId, userId));
  await db.update(users).set({ totpEnabledAt: now, updatedAt: now }).where(eq(users.id, userId));
  return issueRecoveryCodes(db, userId);
}

export async function disableTotp(db: Db, userId: string, code: string, appSecret: string) {
  if (!(await verifyUserTotp(db, appSecret, userId, code))) {
    throw new Error("验证码不正确");
  }
  await db.delete(userTotp).where(eq(userTotp.userId, userId));
  await db.update(users).set({ totpEnabledAt: null, updatedAt: new Date() }).where(eq(users.id, userId));
}

export function verifyTotpCode(base32: string, code: string): boolean {
  const totp = new TOTP({
    issuer: "Zakura",
    label: "user",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(base32.replace(/\s+/g, "")),
  });
  return totp.validate({ token: code.replace(/\s+/g, ""), window: 1 }) !== null;
}

export async function verifyUserTotp(db: Db, appSecret: string, userId: string, code: string): Promise<boolean> {
  const row = await db.query.userTotp.findFirst({ where: eq(userTotp.userId, userId) });
  if (!row?.enabledAt) return false;
  const base32 = decryptJson<string>(appSecret, row.secretEnc);
  return verifyTotpCode(base32, code);
}

async function issueRecoveryCodes(db: Db, userId: string): Promise<string[]> {
  await db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
  const codes: string[] = [];
  for (let i = 0; i < 8; i++) {
    const code = newSecretToken("rc", 5).replace("rc_", "").slice(0, 10);
    codes.push(code);
    await db.insert(userRecoveryCodes).values({
      id: newId(),
      userId,
      codeHash: hashToken(code.toLowerCase()),
      createdAt: new Date(),
    });
  }
  return codes;
}

export async function consumeRecoveryCode(db: Db, userId: string, code: string): Promise<boolean> {
  const hash = hashToken(code.trim().toLowerCase());
  const rows = await db.query.userRecoveryCodes.findMany({
    where: eq(userRecoveryCodes.userId, userId),
  });
  const match = rows.find((row) => !row.usedAt && row.codeHash === hash);
  if (!match) return false;
  await db.update(userRecoveryCodes).set({ usedAt: new Date() }).where(eq(userRecoveryCodes.id, match.id));
  return true;
}

export async function beginWebauthnRegistration(
  db: Db,
  webPublicUrl: string,
  user: { id: string; email: string; name?: string | null },
) {
  const rp = rpFromWebUrl(webPublicUrl);
  const existing = await db.query.userWebauthnCredentials.findMany({
    where: eq(userWebauthnCredentials.userId, user.id),
  });
  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.rpID,
    userName: user.email,
    userDisplayName: user.name || user.email,
    userID: new TextEncoder().encode(user.id),
    excludeCredentials: existing.map((row) => ({ id: row.credentialId })),
    authenticatorSelection: { userVerification: "preferred", residentKey: "preferred" },
  });
  setChallenge(`reg:${user.id}`, options.challenge);
  return options;
}

export async function finishWebauthnRegistration(
  db: Db,
  webPublicUrl: string,
  userId: string,
  response: RegistrationResponseJSON,
  name?: string,
) {
  const challenge = takeChallenge(`reg:${userId}`);
  if (!challenge) throw new Error("通行密钥挑战已过期，请重试");
  const rp = rpFromWebUrl(webPublicUrl);
  const verified = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
  });
  if (!verified.verified || !verified.registrationInfo) throw new Error("通行密钥注册失败");
  const cred = verified.registrationInfo.credential;
  await db.insert(userWebauthnCredentials).values({
    id: newId(),
    userId,
    credentialId: cred.id,
    publicKey: toBase64Url(cred.publicKey),
    counter: cred.counter,
    name: name?.trim() || "Passkey",
    transportsJson: JSON.stringify(cred.transports ?? []),
    createdAt: new Date(),
  });
}

export async function beginWebauthnLogin(
  db: Db,
  webPublicUrl: string,
  userId: string,
  challengeKey: string,
) {
  const rp = rpFromWebUrl(webPublicUrl);
  const existing = await db.query.userWebauthnCredentials.findMany({
    where: eq(userWebauthnCredentials.userId, userId),
  });
  if (!existing.length) throw new Error("未绑定通行密钥");
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    allowCredentials: existing.map((row) => ({ id: row.credentialId })),
    userVerification: "preferred",
  });
  setChallenge(challengeKey, options.challenge);
  return options;
}

export async function finishWebauthnLogin(
  db: Db,
  webPublicUrl: string,
  userId: string,
  challengeKey: string,
  response: AuthenticationResponseJSON,
): Promise<boolean> {
  const challenge = takeChallenge(challengeKey);
  if (!challenge) return false;
  const credId = response.id;
  const row = await db.query.userWebauthnCredentials.findFirst({
    where: eq(userWebauthnCredentials.credentialId, credId),
  });
  if (!row || row.userId !== userId) return false;
  const rp = rpFromWebUrl(webPublicUrl);
  const verified = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    credential: {
      id: row.credentialId,
      publicKey: fromBase64Url(row.publicKey) as Uint8Array<ArrayBuffer>,
      counter: row.counter,
    },
  });
  if (!verified.verified) return false;
  await db
    .update(userWebauthnCredentials)
    .set({ counter: verified.authenticationInfo.newCounter })
    .where(eq(userWebauthnCredentials.id, row.id));
  return true;
}

export async function deleteWebauthnCredential(db: Db, userId: string, credentialRowId: string): Promise<boolean> {
  const rows = await db
    .delete(userWebauthnCredentials)
    .where(and(eq(userWebauthnCredentials.id, credentialRowId), eq(userWebauthnCredentials.userId, userId)))
    .returning();
  return rows.length > 0;
}
