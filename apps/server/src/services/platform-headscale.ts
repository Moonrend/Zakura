/**
 * Platform-managed Headscale config — stored in `settings` (owner=platform).
 * SaaS only. Secrets (apiKey / platformAuthKey) are encrypted with the app secret.
 */
import { and, eq } from "drizzle-orm";
import { encryptJson, decryptJson } from "@zakura/core";
import type { Db } from "../db/client.js";
import { newId, settings } from "../db/schema.js";

export const PLATFORM_HEADSCALE_KEY = "network.headscale";

export type PlatformHeadscaleStored = {
  enabled: boolean;
  url: string;
  /** encrypted `{ secret: string }` */
  apiKeyEnc: string;
  /** encrypted `{ secret: string }` — optional preauth key for tag:platform host */
  platformAuthKeyEnc: string;
};

export type PlatformHeadscaleResolved = {
  enabled: boolean;
  url: string;
  apiKey: string;
  platformAuthKey: string;
};

export type PlatformHeadscalePublic = {
  enabled: boolean;
  url: string;
  hasApiKey: boolean;
  hasPlatformAuthKey: boolean;
  /** Ready to serve tenants (enabled + url + apiKey) */
  ready: boolean;
};

export type PlatformHeadscalePatch = {
  enabled?: boolean;
  url?: string;
  /** empty string clears; undefined = leave unchanged */
  apiKey?: string;
  /** empty string clears; undefined = leave unchanged */
  platformAuthKey?: string;
};

function emptyStored(): PlatformHeadscaleStored {
  return { enabled: false, url: "", apiKeyEnc: "", platformAuthKeyEnc: "" };
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

export async function loadPlatformHeadscaleStored(
  db: Db,
): Promise<PlatformHeadscaleStored> {
  const row = await db.query.settings.findFirst({
    where: and(
      eq(settings.ownerKey, "platform"),
      eq(settings.key, PLATFORM_HEADSCALE_KEY),
    ),
  });
  if (!row?.value) return emptyStored();
  try {
    const parsed = JSON.parse(row.value) as Partial<PlatformHeadscaleStored>;
    return {
      enabled: Boolean(parsed.enabled),
      url: typeof parsed.url === "string" ? parsed.url : "",
      apiKeyEnc: typeof parsed.apiKeyEnc === "string" ? parsed.apiKeyEnc : "",
      platformAuthKeyEnc:
        typeof parsed.platformAuthKeyEnc === "string" ? parsed.platformAuthKeyEnc : "",
    };
  } catch {
    return emptyStored();
  }
}

export async function savePlatformHeadscaleStored(
  db: Db,
  stored: PlatformHeadscaleStored,
): Promise<void> {
  await db
    .insert(settings)
    .values({
      id: newId(),
      ownerKey: "platform",
      key: PLATFORM_HEADSCALE_KEY,
      value: JSON.stringify(stored),
    })
    .onConflictDoUpdate({
      target: [settings.ownerKey, settings.key],
      set: { value: JSON.stringify(stored) },
    });
}

export function resolvePlatformHeadscale(
  stored: PlatformHeadscaleStored,
  appSecret: string,
): PlatformHeadscaleResolved {
  const url = stored.url.trim().replace(/\/+$/, "");
  const apiKey = decryptSecret(appSecret, stored.apiKeyEnc);
  const platformAuthKey = decryptSecret(appSecret, stored.platformAuthKeyEnc);
  const enabled = stored.enabled && Boolean(url && apiKey);
  return { enabled, url, apiKey, platformAuthKey };
}

export async function loadPlatformHeadscaleResolved(
  db: Db,
  appSecret: string,
): Promise<PlatformHeadscaleResolved> {
  const stored = await loadPlatformHeadscaleStored(db);
  return resolvePlatformHeadscale(stored, appSecret);
}

export function toPlatformHeadscalePublic(
  stored: PlatformHeadscaleStored,
  appSecret: string,
): PlatformHeadscalePublic {
  const resolved = resolvePlatformHeadscale(stored, appSecret);
  return {
    enabled: stored.enabled,
    url: stored.url.trim().replace(/\/+$/, ""),
    hasApiKey: Boolean(stored.apiKeyEnc) || Boolean(resolved.apiKey),
    hasPlatformAuthKey:
      Boolean(stored.platformAuthKeyEnc) || Boolean(resolved.platformAuthKey),
    ready: resolved.enabled,
  };
}

export async function getPlatformHeadscalePublic(
  db: Db,
  appSecret: string,
): Promise<PlatformHeadscalePublic> {
  const stored = await loadPlatformHeadscaleStored(db);
  return toPlatformHeadscalePublic(stored, appSecret);
}

export async function patchPlatformHeadscale(
  db: Db,
  appSecret: string,
  patch: PlatformHeadscalePatch,
): Promise<PlatformHeadscalePublic> {
  const prev = await loadPlatformHeadscaleStored(db);
  let apiKeyEnc = prev.apiKeyEnc;
  if (patch.apiKey !== undefined) {
    apiKeyEnc = patch.apiKey.trim() ? encryptSecret(appSecret, patch.apiKey) : "";
  }
  let platformAuthKeyEnc = prev.platformAuthKeyEnc;
  if (patch.platformAuthKey !== undefined) {
    platformAuthKeyEnc = patch.platformAuthKey.trim()
      ? encryptSecret(appSecret, patch.platformAuthKey)
      : "";
  }
  const next: PlatformHeadscaleStored = {
    enabled: patch.enabled ?? prev.enabled,
    url:
      patch.url !== undefined
        ? patch.url.trim().replace(/\/+$/, "")
        : prev.url.trim().replace(/\/+$/, ""),
    apiKeyEnc,
    platformAuthKeyEnc,
  };
  await savePlatformHeadscaleStored(db, next);
  return toPlatformHeadscalePublic(next, appSecret);
}

/** Persist a minted platform preauth key without clearing other fields. */
export async function persistPlatformAuthKey(
  db: Db,
  appSecret: string,
  platformAuthKey: string,
): Promise<void> {
  const prev = await loadPlatformHeadscaleStored(db);
  const next: PlatformHeadscaleStored = {
    ...prev,
    platformAuthKeyEnc: encryptSecret(appSecret, platformAuthKey),
  };
  await savePlatformHeadscaleStored(db, next);
}

/**
 * One-time migrate from legacy ZAKURA_HEADSCALE_* env into DB when DB is empty.
 * Returns true if a row was written.
 */
export async function migratePlatformHeadscaleFromEnv(
  db: Db,
  appSecret: string,
): Promise<boolean> {
  const existing = await loadPlatformHeadscaleStored(db);
  if (existing.url || existing.apiKeyEnc || existing.enabled) {
    return false;
  }

  const url = (process.env.ZAKURA_HEADSCALE_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = (process.env.ZAKURA_HEADSCALE_API_KEY ?? "").trim();
  const platformAuthKey = (process.env.ZAKURA_HEADSCALE_PLATFORM_AUTHKEY ?? "").trim();
  const enabledFlag =
    process.env.ZAKURA_HEADSCALE_ENABLED === "1" ||
    process.env.ZAKURA_HEADSCALE_ENABLED === "true";

  if (!url && !apiKey && !platformAuthKey && !enabledFlag) {
    return false;
  }

  const stored: PlatformHeadscaleStored = {
    enabled: enabledFlag && Boolean(url && apiKey),
    url,
    apiKeyEnc: apiKey ? encryptSecret(appSecret, apiKey) : "",
    platformAuthKeyEnc: platformAuthKey
      ? encryptSecret(appSecret, platformAuthKey)
      : "",
  };
  await savePlatformHeadscaleStored(db, stored);
  console.info(
    "[headscale] migrated ZAKURA_HEADSCALE_* env into settings (platform / network.headscale)",
  );
  return true;
}
