/**
 * 平台系统发信（Amail）配置 — 存 `settings`（owner=platform）。
 * API Token 用 app secret 加密；管理页读写，不走环境变量。
 */
import { and, eq } from "drizzle-orm";
import { encryptJson, decryptJson } from "@zakura/core";
import type { Db } from "../db/client.js";
import { newId, settings } from "../db/schema.js";

export const PLATFORM_TRANSACTIONAL_EMAIL_KEY = "email.transactional";

export type PlatformTransactionalEmailStored = {
  enabled: boolean;
  fromEmail: string;
  baseUrl: string;
  providerId: string;
  /** encrypted `{ secret: string }` */
  apiTokenEnc: string;
};

export type PlatformTransactionalEmailResolved = {
  enabled: boolean;
  fromEmail: string;
  baseUrl: string;
  providerId: string;
  apiToken: string;
};

export type PlatformTransactionalEmailPublic = {
  enabled: boolean;
  fromEmail: string;
  baseUrl: string;
  providerId: string;
  hasApiToken: boolean;
  /** enabled + fromEmail + apiToken 齐全 */
  ready: boolean;
};

export type PlatformTransactionalEmailPatch = {
  enabled?: boolean;
  fromEmail?: string;
  baseUrl?: string;
  providerId?: string;
  /** 空串清除；undefined 保持原值 */
  apiToken?: string;
};

function emptyStored(): PlatformTransactionalEmailStored {
  return {
    enabled: false,
    fromEmail: "",
    baseUrl: "",
    providerId: "",
    apiTokenEnc: "",
  };
}

function decryptSecret(appSecret: string, enc: string): string {
  if (!enc) return "";
  try {
    const dec = decryptJson<{ secret?: string }>(appSecret, enc);
    return dec.secret?.trim() ?? "";
  } catch {
    return "";
  }
}

function encryptSecret(appSecret: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return encryptJson(appSecret, { secret: trimmed });
}

export async function loadPlatformTransactionalEmailStored(
  db: Db,
): Promise<PlatformTransactionalEmailStored> {
  const row = await db.query.settings.findFirst({
    where: and(
      eq(settings.ownerKey, "platform"),
      eq(settings.key, PLATFORM_TRANSACTIONAL_EMAIL_KEY),
    ),
  });
  if (!row?.value) return emptyStored();
  try {
    const parsed = JSON.parse(row.value) as Partial<PlatformTransactionalEmailStored>;
    return {
      enabled: Boolean(parsed.enabled),
      fromEmail: typeof parsed.fromEmail === "string" ? parsed.fromEmail : "",
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
      providerId: typeof parsed.providerId === "string" ? parsed.providerId : "",
      apiTokenEnc: typeof parsed.apiTokenEnc === "string" ? parsed.apiTokenEnc : "",
    };
  } catch {
    return emptyStored();
  }
}

export async function savePlatformTransactionalEmailStored(
  db: Db,
  stored: PlatformTransactionalEmailStored,
): Promise<void> {
  await db
    .insert(settings)
    .values({
      id: newId(),
      ownerKey: "platform",
      key: PLATFORM_TRANSACTIONAL_EMAIL_KEY,
      value: JSON.stringify(stored),
    })
    .onConflictDoUpdate({
      target: [settings.ownerKey, settings.key],
      set: { value: JSON.stringify(stored) },
    });
}

export function resolvePlatformTransactionalEmail(
  stored: PlatformTransactionalEmailStored,
  appSecret: string,
): PlatformTransactionalEmailResolved {
  const fromEmail = stored.fromEmail.trim();
  const apiToken = decryptSecret(appSecret, stored.apiTokenEnc);
  const enabled = stored.enabled && Boolean(fromEmail && apiToken);
  return {
    enabled,
    fromEmail,
    baseUrl: stored.baseUrl.trim(),
    providerId: stored.providerId.trim(),
    apiToken,
  };
}

export function toPlatformTransactionalEmailPublic(
  stored: PlatformTransactionalEmailStored,
  appSecret: string,
): PlatformTransactionalEmailPublic {
  const resolved = resolvePlatformTransactionalEmail(stored, appSecret);
  return {
    enabled: stored.enabled,
    fromEmail: stored.fromEmail.trim(),
    baseUrl: stored.baseUrl.trim(),
    providerId: stored.providerId.trim(),
    hasApiToken: Boolean(stored.apiTokenEnc) || Boolean(resolved.apiToken),
    ready: resolved.enabled,
  };
}

export async function getPlatformTransactionalEmailPublic(
  db: Db,
  appSecret: string,
): Promise<PlatformTransactionalEmailPublic> {
  const stored = await loadPlatformTransactionalEmailStored(db);
  return toPlatformTransactionalEmailPublic(stored, appSecret);
}

export async function loadPlatformTransactionalEmailResolved(
  db: Db,
  appSecret: string,
): Promise<PlatformTransactionalEmailResolved> {
  const stored = await loadPlatformTransactionalEmailStored(db);
  return resolvePlatformTransactionalEmail(stored, appSecret);
}

export async function patchPlatformTransactionalEmail(
  db: Db,
  appSecret: string,
  patch: PlatformTransactionalEmailPatch,
): Promise<PlatformTransactionalEmailPublic> {
  const prev = await loadPlatformTransactionalEmailStored(db);
  let apiTokenEnc = prev.apiTokenEnc;
  if (patch.apiToken !== undefined) {
    apiTokenEnc = patch.apiToken.trim() ? encryptSecret(appSecret, patch.apiToken) : "";
  }
  const next: PlatformTransactionalEmailStored = {
    enabled: patch.enabled ?? prev.enabled,
    fromEmail:
      patch.fromEmail !== undefined ? patch.fromEmail.trim() : prev.fromEmail.trim(),
    baseUrl: patch.baseUrl !== undefined ? patch.baseUrl.trim() : prev.baseUrl.trim(),
    providerId:
      patch.providerId !== undefined ? patch.providerId.trim() : prev.providerId.trim(),
    apiTokenEnc,
  };
  await savePlatformTransactionalEmailStored(db, next);
  return toPlatformTransactionalEmailPublic(next, appSecret);
}
