import { and, eq, lt } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { RegisterError, registerSaasUser, type RegisterSchema } from "./register-user.js";

/** Supported login OAuth provider ids. */
export const LOGIN_OAUTH_PROVIDERS = ["zerocat", "google", "github", "microsoft"] as const;
export type LoginOauthProviderId = (typeof LOGIN_OAUTH_PROVIDERS)[number];

export const LOGIN_POLICY_SETTINGS_KEY = "auth.login";

export type OauthSchema = RegisterSchema & {
  oauthIdentities: unknown;
  oauthLoginStates: unknown;
  settings: { ownerKey: unknown; key: unknown };
};

export type OauthLoginDeps = {
  db: unknown;
  schema: OauthSchema;
  secret: string;
  webPublicUrl: string;
  encryptJson: (secret: string, value: unknown) => string;
  decryptJson: <T = unknown>(secret: string, payload: string) => T;
  onTenantCreated?: (tenantId: string) => Promise<void>;
};

export type OauthLoginResult = {
  user: { id: string; email: string; name: string | null; isPlatformAdmin?: boolean };
  tenant: { id: string; slug: string; name: string; onboardingCompleted: boolean };
  membership: { role: string };
};

export type ProviderStoredConfig = {
  enabled: boolean;
  clientId: string;
  clientSecretEnc: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  allowRegistration: boolean;
  /**
   * @deprecated Prefer platform `auth.login.disablePasswordLogin`.
   * Kept so existing ZeroCat admin saves still work until migrated.
   */
  disablePasswordLogin?: boolean;
};

export type ProviderPublicConfig = {
  id: LoginOauthProviderId;
  name: string;
  enabled: boolean;
  ready: boolean;
  clientId: string;
  hasClientSecret: boolean;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  allowRegistration: boolean;
  redirectUri: string;
};

export type ProviderPatch = {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  scope?: string;
  allowRegistration?: boolean;
};

/** Which login CTA to emphasize on /login. `auto` = first ready OAuth, else password. */
export type HighlightedLoginMethod = "auto" | "password" | LoginOauthProviderId;

export type LoginPolicy = {
  disablePasswordLogin: boolean;
  highlightedMethod: HighlightedLoginMethod;
};

export function parseHighlightedMethod(value: unknown): HighlightedLoginMethod {
  if (value === "auto" || value === "password") return value;
  if (typeof value === "string" && isLoginOauthProviderId(value)) return value;
  return "auto";
}

/** Fall back to auto when the chosen method is unavailable. */
export function resolveHighlightedMethod(opts: {
  stored: HighlightedLoginMethod;
  passwordLoginEnabled: boolean;
  readyProviderIds: readonly string[];
}): HighlightedLoginMethod {
  const { stored, passwordLoginEnabled, readyProviderIds } = opts;
  if (stored === "auto") return "auto";
  if (stored === "password") return passwordLoginEnabled ? "password" : "auto";
  return readyProviderIds.includes(stored) ? stored : "auto";
}

type NormalizedProfile = {
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  name: string;
  raw: unknown;
};

type ProviderDefinition = {
  id: LoginOauthProviderId;
  name: string;
  defaults: {
    authorizeUrl: string;
    tokenUrl: string;
    userinfoUrl: string;
    scope: string;
  };
  authParams?: Record<string, string>;
  /** GitHub token endpoint prefers Accept: application/json */
  tokenAcceptJson?: boolean;
  parseProfile: (
    raw: unknown,
    accessToken: string,
  ) => Promise<NormalizedProfile> | NormalizedProfile;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function settingsKey(id: LoginOauthProviderId): string {
  return `auth.oauth.${id}`;
}

export function isLoginOauthProviderId(value: string): value is LoginOauthProviderId {
  return (LOGIN_OAUTH_PROVIDERS as readonly string[]).includes(value);
}

export function redirectUriFor(webPublicUrl: string, providerId: LoginOauthProviderId): string {
  return `${webPublicUrl.replace(/\/$/, "")}/console/oauth/${providerId}/callback`;
}

function asEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.includes("@") ? email : null;
}

/** Synthetic placeholders must not merge across unrelated accounts. */
function isSyntheticEmail(email: string): boolean {
  return email.endsWith(".oauth");
}

async function githubEmails(
  accessToken: string,
): Promise<{ email: string; verified: boolean } | null> {
  const res = await fetch("https://api.github.com/user/emails", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "zakura-oauth",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const list = (await res.json().catch(() => [])) as Array<{
    email?: string;
    primary?: boolean;
    verified?: boolean;
  }>;
  if (!Array.isArray(list)) return null;
  const pick =
    list.find((e) => e.primary && e.verified && asEmail(e.email)) ||
    list.find((e) => e.verified && asEmail(e.email)) ||
    list.find((e) => asEmail(e.email));
  const email = pick ? asEmail(pick.email) : null;
  if (!email) return null;
  return { email, verified: !!pick?.verified };
}

const PROVIDERS: Record<LoginOauthProviderId, ProviderDefinition> = {
  zerocat: {
    id: "zerocat",
    name: "ZeroCat",
    defaults: {
      authorizeUrl: "https://api.zcservice.houlang.cloud/oauth/authorize",
      tokenUrl: "https://api.zcservice.houlang.cloud/oauth/token",
      userinfoUrl: "https://api.zcservice.houlang.cloud/oauth/userinfo",
      scope: "user:read",
    },
    parseProfile(raw) {
      const profile = raw as {
        openid?: string;
        username?: string;
        nickname?: string;
        email?: string | boolean | null;
        email_verified?: boolean;
      };
      const openid = profile.openid?.trim();
      if (!openid) throw new RegisterError("获取 ZeroCat 用户信息失败", 400);
      let email = asEmail(profile.email);
      if (!email && profile.username?.trim()) {
        email = `${profile.username.trim().toLowerCase()}@zerocat.oauth`;
      }
      if (!email) {
        const safe = openid.toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
        email = `${safe}@zerocat.oauth`;
      }
      return {
        providerUserId: openid,
        email,
        emailVerified: profile.email_verified === true && !isSyntheticEmail(email),
        name:
          profile.nickname?.trim() ||
          profile.username?.trim() ||
          (typeof profile.email === "string" ? profile.email.split("@")[0] : "") ||
          "ZeroCat User",
        raw,
      };
    },
  },
  google: {
    id: "google",
    name: "Google",
    defaults: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      userinfoUrl: "https://openidconnect.googleapis.com/userinfo",
      scope: "openid email profile",
    },
    authParams: { prompt: "select_account" },
    parseProfile(raw) {
      const profile = raw as {
        sub?: string;
        email?: string;
        email_verified?: boolean;
        name?: string;
        given_name?: string;
      };
      const sub = profile.sub?.trim();
      if (!sub) throw new RegisterError("获取 Google 用户信息失败", 400);
      const email = asEmail(profile.email);
      return {
        providerUserId: sub,
        email,
        emailVerified: profile.email_verified === true,
        name: profile.name?.trim() || profile.given_name?.trim() || email?.split("@")[0] || "Google User",
        raw,
      };
    },
  },
  github: {
    id: "github",
    name: "GitHub",
    defaults: {
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      userinfoUrl: "https://api.github.com/user",
      scope: "read:user user:email",
    },
    tokenAcceptJson: true,
    async parseProfile(raw, accessToken) {
      const profile = raw as {
        id?: number | string;
        login?: string;
        name?: string | null;
        email?: string | null;
      };
      if (profile.id == null) throw new RegisterError("获取 GitHub 用户信息失败", 400);
      let email = asEmail(profile.email);
      let emailVerified = false;
      const fromList = await githubEmails(accessToken);
      if (fromList) {
        email = fromList.email;
        emailVerified = fromList.verified;
      }
      return {
        providerUserId: String(profile.id),
        email,
        emailVerified,
        name: profile.name?.trim() || profile.login?.trim() || email?.split("@")[0] || "GitHub User",
        raw,
      };
    },
  },
  microsoft: {
    id: "microsoft",
    name: "Microsoft",
    defaults: {
      authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      userinfoUrl: "https://graph.microsoft.com/v1.0/me",
      scope: "openid profile email User.Read",
    },
    authParams: { prompt: "select_account" },
    parseProfile(raw) {
      const profile = raw as {
        id?: string;
        mail?: string | null;
        userPrincipalName?: string;
        displayName?: string;
      };
      const id = profile.id?.trim();
      if (!id) throw new RegisterError("获取 Microsoft 用户信息失败", 400);
      const email = asEmail(profile.mail) || asEmail(profile.userPrincipalName);
      return {
        providerUserId: id,
        email,
        // Graph /me mail/UPN is issued by Microsoft tenant — treat as verified when present
        emailVerified: !!email,
        name:
          profile.displayName?.trim() ||
          email?.split("@")[0] ||
          "Microsoft User",
        raw,
      };
    },
  },
};

function defaultStored(id: LoginOauthProviderId): ProviderStoredConfig {
  const d = PROVIDERS[id].defaults;
  return {
    enabled: false,
    clientId: "",
    clientSecretEnc: "",
    authorizeUrl: d.authorizeUrl,
    tokenUrl: d.tokenUrl,
    userinfoUrl: d.userinfoUrl,
    scope: d.scope,
    allowRegistration: true,
  };
}

export function listProviderDefs(): Array<{ id: LoginOauthProviderId; name: string }> {
  return LOGIN_OAUTH_PROVIDERS.map((id) => ({ id, name: PROVIDERS[id].name }));
}

async function readSettingsJson(
  deps: Pick<OauthLoginDeps, "db" | "schema">,
  key: string,
): Promise<unknown | null> {
  const db = deps.db as AnyDb;
  const settings = deps.schema.settings as AnyDb;
  const rows = await db
    .select()
    .from(settings)
    .where(and(eq(settings.ownerKey, "platform"), eq(settings.key, key)));
  const row = rows[0] as { value?: string } | undefined;
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return null;
  }
}

async function writeSettingsJson(
  deps: OauthLoginDeps,
  key: string,
  value: unknown,
): Promise<void> {
  const db = deps.db as AnyDb;
  const settings = deps.schema.settings as AnyDb;
  await db
    .insert(settings)
    .values({
      id: deps.schema.newId(),
      ownerKey: "platform",
      key,
      value: JSON.stringify(value),
    })
    .onConflictDoUpdate({
      target: [settings.ownerKey, settings.key],
      set: { value: JSON.stringify(value) },
    });
}

export async function loadProviderConfig(
  deps: Pick<OauthLoginDeps, "db" | "schema" | "secret" | "webPublicUrl" | "decryptJson">,
  providerId: LoginOauthProviderId,
): Promise<{
  stored: ProviderStoredConfig;
  public: ProviderPublicConfig;
  clientSecret: string | null;
}> {
  const def = PROVIDERS[providerId];
  let stored = defaultStored(providerId);
  const parsed = await readSettingsJson(deps, settingsKey(providerId));
  if (parsed && typeof parsed === "object") {
    stored = { ...stored, ...(parsed as Partial<ProviderStoredConfig>) };
  }

  let clientSecret: string | null = null;
  if (stored.clientSecretEnc) {
    try {
      clientSecret = deps.decryptJson<string>(deps.secret, stored.clientSecretEnc);
    } catch {
      clientSecret = null;
    }
  }

  const ready = !!(stored.enabled && stored.clientId && clientSecret);
  return {
    stored,
    clientSecret,
    public: {
      id: providerId,
      name: def.name,
      enabled: stored.enabled,
      ready,
      clientId: stored.clientId,
      hasClientSecret: !!clientSecret,
      authorizeUrl: stored.authorizeUrl || def.defaults.authorizeUrl,
      tokenUrl: stored.tokenUrl || def.defaults.tokenUrl,
      userinfoUrl: stored.userinfoUrl || def.defaults.userinfoUrl,
      scope: stored.scope || def.defaults.scope,
      allowRegistration: stored.allowRegistration !== false,
      redirectUri: redirectUriFor(deps.webPublicUrl, providerId),
    },
  };
}

export async function saveProviderConfig(
  deps: OauthLoginDeps,
  providerId: LoginOauthProviderId,
  patch: ProviderPatch,
): Promise<ProviderPublicConfig> {
  const def = PROVIDERS[providerId];
  const { stored } = await loadProviderConfig(deps, providerId);

  const next: ProviderStoredConfig = {
    enabled: patch.enabled ?? stored.enabled,
    clientId: patch.clientId !== undefined ? patch.clientId.trim() : stored.clientId,
    clientSecretEnc: stored.clientSecretEnc,
    authorizeUrl:
      patch.authorizeUrl !== undefined
        ? patch.authorizeUrl.trim() || def.defaults.authorizeUrl
        : stored.authorizeUrl,
    tokenUrl:
      patch.tokenUrl !== undefined
        ? patch.tokenUrl.trim() || def.defaults.tokenUrl
        : stored.tokenUrl,
    userinfoUrl:
      patch.userinfoUrl !== undefined
        ? patch.userinfoUrl.trim() || def.defaults.userinfoUrl
        : stored.userinfoUrl,
    scope: patch.scope !== undefined ? patch.scope.trim() || def.defaults.scope : stored.scope,
    allowRegistration: patch.allowRegistration ?? stored.allowRegistration,
  };

  if (patch.clientSecret !== undefined && patch.clientSecret.trim()) {
    next.clientSecretEnc = deps.encryptJson(deps.secret, patch.clientSecret.trim());
  }

  await writeSettingsJson(deps, settingsKey(providerId), next);
  return (await loadProviderConfig(deps, providerId)).public;
}

export async function loadLoginPolicy(
  deps: Pick<OauthLoginDeps, "db" | "schema" | "secret" | "webPublicUrl" | "decryptJson">,
): Promise<{
  stored: LoginPolicy;
  effective: LoginPolicy & { highlightedMethod: HighlightedLoginMethod };
  anyOauthReady: boolean;
  readyProviderIds: LoginOauthProviderId[];
}> {
  let stored: LoginPolicy = { disablePasswordLogin: false, highlightedMethod: "auto" };
  const parsed = await readSettingsJson(deps, LOGIN_POLICY_SETTINGS_KEY);
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Partial<LoginPolicy>;
    stored = {
      disablePasswordLogin: !!obj.disablePasswordLogin,
      highlightedMethod: parseHighlightedMethod(obj.highlightedMethod),
    };
  } else {
    // Migrate legacy ZeroCat flag into effective policy (without writing yet)
    const zc = await loadProviderConfig(deps, "zerocat");
    if (zc.stored.disablePasswordLogin) {
      stored = { disablePasswordLogin: true, highlightedMethod: "auto" };
    }
  }

  const readyProviderIds: LoginOauthProviderId[] = [];
  for (const id of LOGIN_OAUTH_PROVIDERS) {
    const { public: pub } = await loadProviderConfig(deps, id);
    if (pub.ready) readyProviderIds.push(id);
  }
  const anyOauthReady = readyProviderIds.length > 0;
  const disablePasswordLogin = !!(stored.disablePasswordLogin && anyOauthReady);

  return {
    stored,
    anyOauthReady,
    readyProviderIds,
    effective: {
      disablePasswordLogin,
      highlightedMethod: resolveHighlightedMethod({
        stored: stored.highlightedMethod,
        passwordLoginEnabled: !disablePasswordLogin,
        readyProviderIds,
      }),
    },
  };
}

export async function saveLoginPolicy(
  deps: OauthLoginDeps,
  patch: {
    disablePasswordLogin?: boolean;
    highlightedMethod?: string;
  },
): Promise<{
  stored: LoginPolicy;
  effective: LoginPolicy;
  anyOauthReady: boolean;
  readyProviderIds: LoginOauthProviderId[];
}> {
  const current = await loadLoginPolicy(deps);
  const next: LoginPolicy = {
    disablePasswordLogin: patch.disablePasswordLogin ?? current.stored.disablePasswordLogin,
    highlightedMethod:
      patch.highlightedMethod !== undefined
        ? parseHighlightedMethod(patch.highlightedMethod)
        : current.stored.highlightedMethod,
  };

  if (next.disablePasswordLogin && !current.anyOauthReady) {
    throw new Error("禁止邮箱登录前请先启用至少一个可用的 OAuth 提供商（Client ID / Secret）");
  }
  if (next.disablePasswordLogin && next.highlightedMethod === "password") {
    next.highlightedMethod = "auto";
  }

  await writeSettingsJson(deps, LOGIN_POLICY_SETTINGS_KEY, next);
  return loadLoginPolicy(deps);
}

export async function listPublicOauthProviders(
  deps: Pick<OauthLoginDeps, "db" | "schema" | "secret" | "webPublicUrl" | "decryptJson">,
): Promise<Array<{ id: LoginOauthProviderId; name: string; enabled: boolean }>> {
  const out: Array<{ id: LoginOauthProviderId; name: string; enabled: boolean }> = [];
  for (const id of LOGIN_OAUTH_PROVIDERS) {
    const { public: pub } = await loadProviderConfig(deps, id);
    if (pub.ready) out.push({ id, name: pub.name, enabled: true });
  }
  return out;
}

export async function listAdminOauthProviders(
  deps: Pick<OauthLoginDeps, "db" | "schema" | "secret" | "webPublicUrl" | "decryptJson">,
): Promise<ProviderPublicConfig[]> {
  const out: ProviderPublicConfig[] = [];
  for (const id of LOGIN_OAUTH_PROVIDERS) {
    out.push((await loadProviderConfig(deps, id)).public);
  }
  return out;
}

export async function startOauthLogin(
  deps: OauthLoginDeps,
  providerId: LoginOauthProviderId,
): Promise<{ authorizeUrl: string }> {
  const def = PROVIDERS[providerId];
  const { public: pub, clientSecret, stored } = await loadProviderConfig(deps, providerId);
  if (!stored.enabled || !stored.clientId || !clientSecret) {
    throw new RegisterError(`${def.name} OAuth 尚未配置或未启用`, 400);
  }

  const state = randomBytes(24).toString("base64url");
  const verifier = pkceVerifier();
  const challenge = pkceChallenge(verifier);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const db = deps.db as AnyDb;
  const statesTable = deps.schema.oauthLoginStates as AnyDb;

  await db.delete(statesTable).where(lt(statesTable.expiresAt, new Date())).catch(() => undefined);
  await db.insert(statesTable).values({
    id: state,
    provider: providerId,
    codeVerifier: verifier,
    expiresAt,
  });

  const url = new URL(pub.authorizeUrl);
  url.searchParams.set("client_id", stored.clientId);
  url.searchParams.set("redirect_uri", pub.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", pub.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [k, v] of Object.entries(def.authParams ?? {})) {
    url.searchParams.set(k, v);
  }

  return { authorizeUrl: url.toString() };
}

async function linkOrCreateUserFromOauth(
  deps: OauthLoginDeps,
  providerId: LoginOauthProviderId,
  profile: NormalizedProfile,
  allowRegistration: boolean,
): Promise<OauthLoginResult> {
  const def = PROVIDERS[providerId];
  const db = deps.db as AnyDb;
  const oauthIdentities = deps.schema.oauthIdentities as AnyDb;
  const users = deps.schema.users as AnyDb;
  const tenants = deps.schema.tenants as AnyDb;
  const tenantMemberships = deps.schema.tenantMemberships as AnyDb;
  const now = new Date();
  const profileJson = JSON.stringify(profile.raw);

  const identityRows = await db
    .select()
    .from(oauthIdentities)
    .where(
      and(
        eq(oauthIdentities.provider, providerId),
        eq(oauthIdentities.providerUserId, profile.providerUserId),
      ),
    );
  const existingIdentity = identityRows[0] as { id: string; userId: string } | undefined;

  let userId: string;
  if (existingIdentity) {
    userId = existingIdentity.userId;
    await db
      .update(oauthIdentities)
      .set({ profileJson, updatedAt: now })
      .where(eq(oauthIdentities.id, existingIdentity.id));
  } else {
    const email = profile.email;
    if (!email) {
      throw new RegisterError(`${def.name} 未返回可用邮箱，无法登录`, 400);
    }

    // Auto email merge: same verified/real email → link identity to existing user
    const canMerge = !isSyntheticEmail(email);
    const existingUser = canMerge
      ? await db.query.users.findFirst({ where: eq(users.email, email) })
      : null;

    if (existingUser) {
      userId = existingUser.id;
      await db.insert(oauthIdentities).values({
        id: deps.schema.newId(),
        provider: providerId,
        providerUserId: profile.providerUserId,
        userId,
        profileJson,
        createdAt: now,
        updatedAt: now,
      });
      if (!existingUser.name && profile.name) {
        await db
          .update(users)
          .set({ name: profile.name, updatedAt: now })
          .where(eq(users.id, userId));
      }
    } else if (!allowRegistration) {
      throw new RegisterError(
        `该 ${def.name} 账号尚未关联 Zakura 用户，请先注册或联系管理员`,
        403,
      );
    } else {
      const result = await registerSaasUser(db, deps.schema, {
        email,
        password: randomBytes(32).toString("base64url"),
        name: profile.name,
      });
      await db
        .update(users)
        .set({ passwordHash: null, updatedAt: now })
        .where(eq(users.id, result.user.id));
      await db.insert(oauthIdentities).values({
        id: deps.schema.newId(),
        provider: providerId,
        providerUserId: profile.providerUserId,
        userId: result.user.id,
        profileJson,
        createdAt: now,
        updatedAt: now,
      });
      await deps.onTenantCreated?.(result.tenant.id).catch(() => undefined);
      return {
        user: result.user,
        tenant: result.tenant,
        membership: result.membership,
      };
    }
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new RegisterError("OAuth 关联后未找到用户", 500);
  if (user.suspendedAt) throw new RegisterError("账号已被封禁", 403);

  const memberships = await db
    .select({
      membership: tenantMemberships,
      tenant: tenants,
    })
    .from(tenantMemberships)
    .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
    .where(and(eq(tenantMemberships.userId, userId), eq(tenantMemberships.status, "active")));

  if (memberships.length === 0) {
    throw new RegisterError("账号尚未加入任何租户", 403);
  }

  const selectable = (
    memberships as Array<{
      membership: { role: string };
      tenant: {
        id: string;
        slug: string;
        name: string;
        onboardingCompleted: boolean;
        suspendedAt?: Date | null;
      };
    }>
  ).filter((m) => !m.tenant.suspendedAt);
  if (selectable.length === 0) {
    throw new RegisterError("所在团队已被封禁", 403);
  }

  const picked = selectable[0];
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      isPlatformAdmin: user.isPlatformAdmin,
    },
    tenant: picked.tenant,
    membership: picked.membership,
  };
}

export async function completeOauthLogin(
  deps: OauthLoginDeps,
  providerId: LoginOauthProviderId,
  input: { code: string; state: string },
): Promise<OauthLoginResult> {
  const def = PROVIDERS[providerId];
  const { public: pub, clientSecret, stored } = await loadProviderConfig(deps, providerId);
  if (!stored.enabled || !stored.clientId || !clientSecret) {
    throw new RegisterError(`${def.name} OAuth 尚未配置或未启用`, 400);
  }
  if (!input.code?.trim() || !input.state?.trim()) {
    throw new RegisterError("code and state required", 400);
  }

  const db = deps.db as AnyDb;
  const oauthLoginStates = deps.schema.oauthLoginStates as AnyDb;

  const stateRows = await db
    .select()
    .from(oauthLoginStates)
    .where(eq(oauthLoginStates.id, input.state));
  const stateRow = stateRows[0] as
    | { id: string; provider: string; codeVerifier: string; expiresAt: Date }
    | undefined;

  if (!stateRow) throw new RegisterError("无效或已过期的 OAuth state", 400);
  if (stateRow.provider !== providerId) {
    throw new RegisterError("OAuth state 与提供商不匹配", 400);
  }
  if (new Date(stateRow.expiresAt) < new Date()) {
    await db.delete(oauthLoginStates).where(eq(oauthLoginStates.id, input.state));
    throw new RegisterError("OAuth state 已过期", 400);
  }
  await db.delete(oauthLoginStates).where(eq(oauthLoginStates.id, input.state));

  const tokenHeaders: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (def.tokenAcceptJson) {
    tokenHeaders.Accept = "application/json";
  }

  const tokenRes = await fetch(pub.tokenUrl, {
    method: "POST",
    headers: tokenHeaders,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code.trim(),
      client_id: stored.clientId,
      client_secret: clientSecret,
      redirect_uri: pub.redirectUri,
      code_verifier: stateRow.codeVerifier,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const tokenJson = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new RegisterError(
      tokenJson.error_description || tokenJson.error || `令牌交换失败 (${tokenRes.status})`,
      400,
    );
  }

  const infoHeaders: Record<string, string> = {
    Authorization: `Bearer ${tokenJson.access_token}`,
    Accept: "application/json",
  };
  if (providerId === "github") {
    infoHeaders.Accept = "application/vnd.github+json";
    infoHeaders["User-Agent"] = "zakura-oauth";
  }

  const infoRes = await fetch(pub.userinfoUrl, {
    headers: infoHeaders,
    signal: AbortSignal.timeout(15000),
  });
  const rawProfile = await infoRes.json().catch(() => ({}));
  if (!infoRes.ok) {
    throw new RegisterError(`获取 ${def.name} 用户信息失败`, 400);
  }

  const profile = await def.parseProfile(rawProfile, tokenJson.access_token);
  return linkOrCreateUserFromOauth(deps, providerId, profile, stored.allowRegistration !== false);
}

/** @internal self-check — synthetic email must not merge */
export function __oauthLoginSelfCheck(): void {
  if (!isSyntheticEmail("alice@zerocat.oauth")) throw new Error("synthetic detect failed");
  if (isSyntheticEmail("alice@gmail.com")) throw new Error("real email flagged synthetic");
  if (!isLoginOauthProviderId("google")) throw new Error("google id rejected");
  if (isLoginOauthProviderId("twitter")) throw new Error("unknown id accepted");
  if (asEmail("  Foo@Bar.COM ") !== "foo@bar.com") throw new Error("email normalize failed");
  if (parseHighlightedMethod("github") !== "github") throw new Error("highlight parse failed");
  if (
    resolveHighlightedMethod({
      stored: "google",
      passwordLoginEnabled: true,
      readyProviderIds: ["github"],
    }) !== "auto"
  ) {
    throw new Error("highlight resolve should fall back");
  }
}
