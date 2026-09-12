import { and, eq, isNotNull } from "drizzle-orm";
import { promises as dns } from "node:dns";
import type { Db } from "../../db/client.js";
import { newId, tenantDomains, tenantMemberships, tenants } from "../../db/schema.js";
import { emailDomain, newSecretToken, normalizeDomain } from "./util.js";

export { normalizeDomain };

export type JoinMode = "invite_only" | "auto_join" | "sso_required";

export type DomainPolicy = {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  domain: string;
  joinMode: JoinMode;
  verified: boolean;
};

export function txtHost(domain: string): string {
  return `_zakura-verify.${normalizeDomain(domain)}`;
}

export function txtRecordsContain(records: string[][], token: string): boolean {
  return records.some((chunks) => chunks.join("").includes(token));
}

export async function listTenantDomains(db: Db, tenantId: string) {
  const rows = await db.query.tenantDomains.findMany({
    where: eq(tenantDomains.tenantId, tenantId),
  });
  return rows.map((row) => ({
    id: row.id,
    domain: row.domain,
    joinMode: row.joinMode as JoinMode,
    verified: Boolean(row.verifiedAt),
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    txtHost: txtHost(row.domain),
    txtToken: row.txtToken,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function addTenantDomain(db: Db, tenantId: string, rawDomain: string, joinMode: JoinMode = "invite_only") {
  const domain = normalizeDomain(rawDomain);
  if (!domain || !domain.includes(".")) throw new Error("请输入有效域名");
  const existing = await db.query.tenantDomains.findFirst({ where: eq(tenantDomains.domain, domain) });
  if (existing && existing.tenantId !== tenantId) {
    throw new Error("该域名已被其他团队占用");
  }
  if (existing) return existing;
  const [row] = await db
    .insert(tenantDomains)
    .values({
      id: newId(),
      tenantId,
      domain,
      txtToken: newSecretToken("dom", 12).replace("dom_", ""),
      joinMode,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  return row;
}

export async function setDomainJoinMode(db: Db, tenantId: string, domainId: string, joinMode: JoinMode) {
  if (!["invite_only", "auto_join", "sso_required"].includes(joinMode)) {
    throw new Error("无效的加入方式");
  }
  const [row] = await db
    .update(tenantDomains)
    .set({ joinMode, updatedAt: new Date() })
    .where(and(eq(tenantDomains.id, domainId), eq(tenantDomains.tenantId, tenantId)))
    .returning();
  if (!row) throw new Error("域名不存在");
  return row;
}

export async function removeTenantDomain(db: Db, tenantId: string, domainId: string) {
  await db.delete(tenantDomains).where(and(eq(tenantDomains.id, domainId), eq(tenantDomains.tenantId, tenantId)));
}

export type TxtLookup = (host: string) => Promise<string[][]>;

export async function verifyTenantDomain(
  db: Db,
  tenantId: string,
  domainId: string,
  lookup: TxtLookup = defaultTxtLookup,
) {
  const row = await db.query.tenantDomains.findFirst({
    where: and(eq(tenantDomains.id, domainId), eq(tenantDomains.tenantId, tenantId)),
  });
  if (!row) throw new Error("域名不存在");
  const records = await lookup(txtHost(row.domain));
  const ok = txtRecordsContain(records, row.txtToken);
  if (!ok) throw new Error(`未找到 TXT 记录 ${txtHost(row.domain)}`);
  const claimed = await db.query.tenantDomains.findFirst({
    where: and(eq(tenantDomains.domain, row.domain), isNotNull(tenantDomains.verifiedAt)),
  });
  if (claimed && claimed.tenantId !== tenantId) {
    throw new Error("该域名已被其他团队验证");
  }
  const [updated] = await db
    .update(tenantDomains)
    .set({ verifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(tenantDomains.id, row.id))
    .returning();
  return updated;
}

async function defaultTxtLookup(host: string): Promise<string[][]> {
  try {
    return await dns.resolveTxt(host);
  } catch {
    return [];
  }
}

export async function findVerifiedDomainPolicy(db: Db, email: string): Promise<DomainPolicy | null> {
  const domain = emailDomain(email);
  if (!domain) return null;
  const row = await db.query.tenantDomains.findFirst({
    where: and(eq(tenantDomains.domain, domain), isNotNull(tenantDomains.verifiedAt)),
  });
  if (!row) return null;
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, row.tenantId) });
  if (!tenant || tenant.suspendedAt) return null;
  return {
    tenantId: tenant.id,
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
    domain,
    joinMode: row.joinMode as JoinMode,
    verified: true,
  };
}

/** 邮箱已验证或来自 IdP 断言时，自动加入对应租户（若尚未是成员）。 */
export async function maybeAutoJoinTenant(
  db: Db,
  input: { userId: string; email: string; emailVerified: boolean; fromSso?: boolean },
): Promise<DomainPolicy | null> {
  const policy = await findVerifiedDomainPolicy(db, input.email);
  if (!policy) return null;
  if (policy.joinMode === "invite_only") return policy;
  if (!input.emailVerified && !input.fromSso) return policy;
  const existing = await db.query.tenantMemberships.findFirst({
    where: and(eq(tenantMemberships.tenantId, policy.tenantId), eq(tenantMemberships.userId, input.userId)),
  });
  if (!existing && policy.joinMode === "auto_join") {
    await db.insert(tenantMemberships).values({
      id: newId(),
      tenantId: policy.tenantId,
      userId: input.userId,
      role: "member",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  if (existing?.status === "suspended" && policy.joinMode === "auto_join") {
    await db
      .update(tenantMemberships)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(tenantMemberships.id, existing.id));
  }
  return policy;
}

export function registrationJoinDecision(policy: DomainPolicy | null): "create_tenant" | "auto_join" | "sso_required" {
  if (!policy) return "create_tenant";
  if (policy.joinMode === "sso_required") return "sso_required";
  if (policy.joinMode === "auto_join") return "auto_join";
  return "create_tenant";
}
