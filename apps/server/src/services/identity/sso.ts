import { and, eq, lt } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { SAML } from "@node-saml/node-saml";
import { encryptJson, decryptJson } from "@zakura/core";
import type { Db } from "../../db/client.js";
import {
  newId,
  oauthIdentities,
  ssoLoginStates,
  tenantMemberships,
  tenantSsoConfigs,
  tenants,
  users,
  type TenantSsoConfig,
} from "../../db/schema.js";
import { findVerifiedDomainPolicy, maybeAutoJoinTenant } from "./domains.js";
import { verifyRs256Jwt } from "./jwt.js";
import { newSecretToken } from "./util.js";

export type SsoPublicConfig = {
  enabled: boolean;
  protocol: "oidc" | "saml";
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  userinfoUrl: string;
  scopes: string;
  idpEntityId: string;
  idpSsoUrl: string;
  hasIdpCertificate: boolean;
  jitEnabled: boolean;
  enforceSso: boolean;
  defaultRole: "owner" | "admin" | "member";
  spEntityId: string;
  acsUrl: string;
  redirectUri: string;
};

export type SsoPatch = {
  enabled?: boolean;
  protocol?: "oidc" | "saml";
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  jwksUrl?: string;
  userinfoUrl?: string;
  scopes?: string;
  idpEntityId?: string;
  idpSsoUrl?: string;
  idpCertificate?: string;
  jitEnabled?: boolean;
  enforceSso?: boolean;
  defaultRole?: "admin" | "member";
};

function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function ssoUrls(config: { webPublicUrl: string; publicBaseUrl: string }, slug: string) {
  return {
    redirectUri: `${config.webPublicUrl}/console/sso/oidc/callback`,
    acsUrl: `${config.publicBaseUrl}/api/auth/sso/saml/${encodeURIComponent(slug)}/acs`,
    spEntityId: `${config.webPublicUrl}/sso/saml/${slug}`,
    metadataUrl: `${config.publicBaseUrl}/api/auth/sso/saml/${encodeURIComponent(slug)}/metadata`,
  };
}

export function toPublicSso(
  row: TenantSsoConfig | null,
  urls: ReturnType<typeof ssoUrls>,
): SsoPublicConfig {
  return {
    enabled: row?.enabled ?? false,
    protocol: row?.protocol === "saml" ? "saml" : "oidc",
    issuer: row?.issuer ?? "",
    clientId: row?.clientId ?? "",
    hasClientSecret: Boolean(row?.clientSecretEnc),
    authorizeUrl: row?.authorizeUrl ?? "",
    tokenUrl: row?.tokenUrl ?? "",
    jwksUrl: row?.jwksUrl ?? "",
    userinfoUrl: row?.userinfoUrl ?? "",
    scopes: row?.scopes ?? "openid email profile",
    idpEntityId: row?.idpEntityId ?? "",
    idpSsoUrl: row?.idpSsoUrl ?? "",
    hasIdpCertificate: Boolean(row?.idpCertificateEnc),
    jitEnabled: row?.jitEnabled ?? true,
    enforceSso: row?.enforceSso ?? false,
    defaultRole: row?.defaultRole === "admin" ? "admin" : "member",
    ...urls,
  };
}

export async function getTenantSso(db: Db, tenantId: string) {
  return db.query.tenantSsoConfigs.findFirst({ where: eq(tenantSsoConfigs.tenantId, tenantId) });
}

export async function upsertTenantSso(
  db: Db,
  secret: string,
  tenantId: string,
  patch: SsoPatch,
) {
  const current = await getTenantSso(db, tenantId);
  const protocol = patch.protocol ?? current?.protocol ?? "oidc";
  const values = {
    enabled: patch.enabled ?? current?.enabled ?? false,
    protocol,
    issuer: patch.issuer ?? current?.issuer ?? null,
    clientId: patch.clientId ?? current?.clientId ?? null,
    clientSecretEnc:
      patch.clientSecret !== undefined
        ? patch.clientSecret
          ? encryptJson(secret, patch.clientSecret)
          : ""
        : (current?.clientSecretEnc ?? ""),
    authorizeUrl: patch.authorizeUrl ?? current?.authorizeUrl ?? null,
    tokenUrl: patch.tokenUrl ?? current?.tokenUrl ?? null,
    jwksUrl: patch.jwksUrl ?? current?.jwksUrl ?? null,
    userinfoUrl: patch.userinfoUrl ?? current?.userinfoUrl ?? null,
    scopes: patch.scopes ?? current?.scopes ?? "openid email profile",
    idpEntityId: patch.idpEntityId ?? current?.idpEntityId ?? null,
    idpSsoUrl: patch.idpSsoUrl ?? current?.idpSsoUrl ?? null,
    idpCertificateEnc:
      patch.idpCertificate !== undefined
        ? patch.idpCertificate
          ? encryptJson(secret, patch.idpCertificate)
          : ""
        : (current?.idpCertificateEnc ?? ""),
    jitEnabled: patch.jitEnabled ?? current?.jitEnabled ?? true,
    enforceSso: patch.enforceSso ?? current?.enforceSso ?? false,
    defaultRole: patch.defaultRole ?? current?.defaultRole ?? "member",
    updatedAt: new Date(),
  };
  if (current) {
    const [row] = await db
      .update(tenantSsoConfigs)
      .set(values)
      .where(eq(tenantSsoConfigs.id, current.id))
      .returning();
    return row;
  }
  const [row] = await db
    .insert(tenantSsoConfigs)
    .values({ id: newId(), tenantId, ...values, createdAt: new Date() })
    .returning();
  return row;
}

export async function discoverSso(db: Db, email: string) {
  const policy = await findVerifiedDomainPolicy(db, email);
  if (!policy) return null;
  const sso = await getTenantSso(db, policy.tenantId);
  if (!sso?.enabled) {
    if (policy.joinMode === "sso_required") {
      return { tenantSlug: policy.tenantSlug, protocol: "oidc" as const, required: true, configured: false };
    }
    return null;
  }
  return {
    tenantSlug: policy.tenantSlug,
    protocol: (sso.protocol === "saml" ? "saml" : "oidc") as "oidc" | "saml",
    required: sso.enforceSso || policy.joinMode === "sso_required",
    configured: true,
  };
}

export async function passwordLoginBlockedBySso(db: Db, email: string): Promise<boolean> {
  const found = await discoverSso(db, email);
  return Boolean(found?.required);
}

async function loadTenantBySlug(db: Db, slug: string) {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!tenant) throw new Error("团队不存在");
  const sso = await getTenantSso(db, tenant.id);
  if (!sso?.enabled) throw new Error("该团队未启用 SSO");
  return { tenant, sso };
}

export async function startOidcSso(
  db: Db,
  urls: { webPublicUrl: string; publicBaseUrl: string },
  slug: string,
) {
  const { tenant, sso } = await loadTenantBySlug(db, slug);
  if (sso.protocol !== "oidc") throw new Error("该团队 SSO 不是 OIDC");
  const authorizeUrl = sso.authorizeUrl || (sso.issuer ? `${sso.issuer.replace(/\/$/, "")}/authorize` : "");
  if (!sso.clientId || !authorizeUrl) throw new Error("OIDC 配置不完整");
  await discoverOidcIfNeeded(sso);
  const verifier = pkceVerifier();
  const nonce = randomBytes(16).toString("hex");
  const state = newSecretToken("sso", 16);
  await db.insert(ssoLoginStates).values({
    id: state,
    tenantId: tenant.id,
    protocol: "oidc",
    codeVerifier: verifier,
    nonce,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    createdAt: new Date(),
  });
  const redirect = ssoUrls(urls, tenant.slug).redirectUri;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: sso.clientId,
    redirect_uri: redirect,
    scope: sso.scopes || "openid email profile",
    state,
    nonce,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  });
  const endpoint = sso.authorizeUrl || authorizeUrl;
  return { authorizeUrl: `${endpoint}?${params.toString()}` };
}

async function discoverOidcIfNeeded(sso: TenantSsoConfig): Promise<void> {
  if (sso.authorizeUrl && sso.tokenUrl && sso.jwksUrl) return;
  if (!sso.issuer) return;
  const wellKnown = `${sso.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(wellKnown);
  if (!res.ok) return;
  const doc = (await res.json()) as {
    authorization_endpoint?: string;
    token_endpoint?: string;
    jwks_uri?: string;
    userinfo_endpoint?: string;
  };
  sso.authorizeUrl = sso.authorizeUrl || doc.authorization_endpoint || null;
  sso.tokenUrl = sso.tokenUrl || doc.token_endpoint || null;
  sso.jwksUrl = sso.jwksUrl || doc.jwks_uri || null;
  sso.userinfoUrl = sso.userinfoUrl || doc.userinfo_endpoint || null;
}

export async function completeOidcSso(
  db: Db,
  secret: string,
  urls: { webPublicUrl: string; publicBaseUrl: string },
  input: { code: string; state: string },
) {
  const state = await db.query.ssoLoginStates.findFirst({ where: eq(ssoLoginStates.id, input.state) });
  if (!state || state.expiresAt.getTime() < Date.now()) throw new Error("SSO 状态已过期");
  await db.delete(ssoLoginStates).where(eq(ssoLoginStates.id, state.id));
  const sso = await getTenantSso(db, state.tenantId);
  if (!sso?.enabled || sso.protocol !== "oidc") throw new Error("SSO 未启用");
  await discoverOidcIfNeeded(sso);
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, state.tenantId) });
  if (!tenant) throw new Error("团队不存在");
  const tokenUrl = sso.tokenUrl;
  if (!tokenUrl || !sso.clientId) throw new Error("OIDC 配置不完整");
  const clientSecret = sso.clientSecretEnc ? decryptJson<string>(secret, sso.clientSecretEnc) : "";
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: ssoUrls(urls, tenant.slug).redirectUri,
    client_id: sso.clientId,
    code_verifier: state.codeVerifier || "",
  });
  if (clientSecret) body.set("client_secret", clientSecret);
  const tokenRes = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (!tokenRes.ok) throw new Error("换取 IdP token 失败");
  const tokens = (await tokenRes.json()) as { id_token?: string; access_token?: string };
  if (!tokens.id_token) throw new Error("IdP 未返回 id_token");
  const issuer = sso.issuer || "";
  const jwksUrl = sso.jwksUrl || `${issuer.replace(/\/$/, "")}/jwks`;
  const claims = await verifyRs256Jwt(tokens.id_token, jwksUrl, {
    issuer,
    audience: sso.clientId,
    nonce: state.nonce ?? undefined,
  });
  let email = String(claims.email ?? "").toLowerCase();
  let name = typeof claims.name === "string" ? claims.name : null;
  const sub = String(claims.sub ?? "");
  if (!email && tokens.access_token && sso.userinfoUrl) {
    const infoRes = await fetch(sso.userinfoUrl, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (infoRes.ok) {
      const info = (await infoRes.json()) as { email?: string; name?: string };
      email = (info.email ?? "").toLowerCase();
      name = info.name ?? name;
    }
  }
  if (!email) throw new Error("IdP 未提供邮箱");
  return provisionSsoUser(db, {
    tenant,
    sso,
    email,
    name,
    subject: sub || email,
    provider: `sso:${tenant.id}`,
  });
}

function samlClient(sso: TenantSsoConfig, secret: string, urls: ReturnType<typeof ssoUrls>) {
  const cert = sso.idpCertificateEnc ? decryptJson<string>(secret, sso.idpCertificateEnc) : "";
  if (!cert || !sso.idpSsoUrl) throw new Error("SAML 配置不完整");
  return new SAML({
    callbackUrl: urls.acsUrl,
    issuer: urls.spEntityId,
    entryPoint: sso.idpSsoUrl,
    idpCert: cert,
    wantAssertionsSigned: true,
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  });
}

export async function startSamlSso(
  db: Db,
  secret: string,
  urls: { webPublicUrl: string; publicBaseUrl: string },
  slug: string,
) {
  const { tenant, sso } = await loadTenantBySlug(db, slug);
  if (sso.protocol !== "saml") throw new Error("该团队 SSO 不是 SAML");
  const state = newSecretToken("sso", 16);
  await db.insert(ssoLoginStates).values({
    id: state,
    tenantId: tenant.id,
    protocol: "saml",
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    createdAt: new Date(),
  });
  const client = samlClient(sso, secret, ssoUrls(urls, tenant.slug));
  const context = await client.getAuthorizeUrlAsync(state, undefined, {});
  return { authorizeUrl: context };
}

export async function completeSamlSso(
  db: Db,
  secret: string,
  urls: { webPublicUrl: string; publicBaseUrl: string },
  slug: string,
  body: { SAMLResponse?: string; RelayState?: string },
) {
  const { tenant, sso } = await loadTenantBySlug(db, slug);
  if (sso.protocol !== "saml") throw new Error("该团队 SSO 不是 SAML");
  if (body.RelayState) {
    const state = await db.query.ssoLoginStates.findFirst({ where: eq(ssoLoginStates.id, body.RelayState) });
    if (state) await db.delete(ssoLoginStates).where(eq(ssoLoginStates.id, state.id));
  }
  const client = samlClient(sso, secret, ssoUrls(urls, tenant.slug));
  const result = await client.validatePostResponseAsync({
    SAMLResponse: body.SAMLResponse ?? "",
    RelayState: body.RelayState ?? "",
  });
  const profile = result.profile as { nameID?: string; email?: string; name?: string } | null;
  const email = String(profile?.email || profile?.nameID || "").toLowerCase();
  if (!email || !email.includes("@")) throw new Error("SAML 断言未提供邮箱");
  return provisionSsoUser(db, {
    tenant,
    sso,
    email,
    name: profile?.name ?? null,
    subject: String(profile?.nameID || email),
    provider: `sso:${tenant.id}`,
  });
}

export async function samlMetadata(
  db: Db,
  secret: string,
  urls: { webPublicUrl: string; publicBaseUrl: string },
  slug: string,
) {
  const { tenant, sso } = await loadTenantBySlug(db, slug);
  const client = samlClient(sso, secret, ssoUrls(urls, tenant.slug));
  const generate = client as unknown as {
    generateServiceProviderMetadataAsync?: (
      decryptionCert: string | null,
      signingCert: string | null,
    ) => Promise<string>;
    generateServiceProviderMetadata?: (decryptionCert: string | null, signingCert: string | null) => string;
  };
  if (generate.generateServiceProviderMetadataAsync) {
    return generate.generateServiceProviderMetadataAsync(null, null);
  }
  return generate.generateServiceProviderMetadata?.(null, null) ?? "";
}

async function provisionSsoUser(
  db: Db,
  input: {
    tenant: { id: string; slug: string; name: string; onboardingCompleted: boolean; suspendedAt: Date | null };
    sso: TenantSsoConfig;
    email: string;
    name: string | null;
    subject: string;
    provider: string;
  },
) {
  if (input.tenant.suspendedAt) throw new Error("所在团队已被封禁");
  let user = await db.query.users.findFirst({ where: eq(users.email, input.email) });
  if (!user) {
    if (!input.sso.jitEnabled) throw new Error("账号不存在，且未开启自动开通");
    const now = new Date();
    const [created] = await db
      .insert(users)
      .values({
        id: newId(),
        email: input.email,
        name: input.name || input.email.split("@")[0],
        passwordHash: null,
        emailVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    user = created;
  } else if (!user.emailVerifiedAt) {
    await db.update(users).set({ emailVerifiedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id));
  }
  if (user.suspendedAt) throw new Error("账号已被封禁");

  const existingId = await db.query.oauthIdentities.findFirst({
    where: and(eq(oauthIdentities.provider, input.provider), eq(oauthIdentities.providerUserId, input.subject)),
  });
  if (!existingId) {
    await db.insert(oauthIdentities).values({
      id: newId(),
      provider: input.provider,
      providerUserId: input.subject,
      userId: user.id,
      profileJson: JSON.stringify({ email: input.email, name: input.name }),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  let membership = await db.query.tenantMemberships.findFirst({
    where: and(eq(tenantMemberships.tenantId, input.tenant.id), eq(tenantMemberships.userId, user.id)),
  });
  if (!membership) {
    const role = input.sso.defaultRole === "admin" ? "admin" : "member";
    const [created] = await db
      .insert(tenantMemberships)
      .values({
        id: newId(),
        tenantId: input.tenant.id,
        userId: user.id,
        role,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    membership = created;
  }
  if (membership.status !== "active") throw new Error("成员资格已被停用");
  await maybeAutoJoinTenant(db, {
    userId: user.id,
    email: input.email,
    emailVerified: true,
    fromSso: true,
  });
  return {
    user,
    tenant: input.tenant,
    membership,
  };
}

export async function purgeExpiredSsoStates(db: Db) {
  await db.delete(ssoLoginStates).where(lt(ssoLoginStates.expiresAt, new Date()));
}
