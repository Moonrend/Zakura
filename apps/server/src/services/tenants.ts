import { and, asc, eq, isNull } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/client.js";
import {
  newId,
  tenantInvites,
  tenantMemberships,
  tenants,
  users,
  type Tenant,
  type TenantInvite,
  type TenantMembership,
  type User,
} from "../db/schema.js";

export type TenantRole = "owner" | "admin" | "member";
export type MembershipStatus = "active" | "suspended";

export type TenantOnboardingSteps = {
  /** 用户已填写称呼并写入记忆 */
  profileNamed?: boolean;
  /** SaaS：已配置 AI 上游（可跳过） */
  aiProviderConfigured?: boolean;
  /** 已接入至少一个上游 MCP（可跳过） */
  mcpConnected?: boolean;
  /** 已查看 Agent MCP 接入说明 */
  connectReady?: boolean;
  /** 已引导试用内置对话 Agent（有 AI 上游时） */
  agentTried?: boolean;

  /** @deprecated 自动准备不再写入；保留兼容旧数据 */
  agentCreated?: boolean;
  /** @deprecated */
  computerEnabled?: boolean;
  /** @deprecated */
  memoryConfigured?: boolean;
};

const ADMIN_ROLES: TenantRole[] = ["owner", "admin"];

export function parseOnboardingSteps(raw: string | null | undefined): TenantOnboardingSteps {
  try {
    return JSON.parse(raw || "{}") as TenantOnboardingSteps;
  } catch {
    return {};
  }
}

export function isTenantAdmin(role: string): boolean {
  return ADMIN_ROLES.includes(role as TenantRole);
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || `tenant-${Date.now().toString(36)}`
  );
}

function hashInviteToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export class TenantService {
  constructor(private readonly db: Db) {}

  async listForUser(userId: string) {
    const rows = await this.db
      .select({
        membershipId: tenantMemberships.id,
        role: tenantMemberships.role,
        status: tenantMemberships.status,
        tenantId: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        isDefault: tenants.isDefault,
        onboardingCompleted: tenants.onboardingCompleted,
        onboardingSteps: tenants.onboardingSteps,
      })
      .from(tenantMemberships)
      .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
      .where(
        and(eq(tenantMemberships.userId, userId), eq(tenantMemberships.status, "active")),
      )
      .orderBy(asc(tenants.createdAt));

    return rows.map((r) => ({
      membershipId: r.membershipId,
      role: r.role as TenantRole,
      status: r.status as MembershipStatus,
      tenant: {
        id: r.tenantId,
        slug: r.slug,
        name: r.name,
        isDefault: r.isDefault,
        onboardingCompleted: r.onboardingCompleted,
        onboardingSteps: parseOnboardingSteps(r.onboardingSteps),
      },
    }));
  }

  async getMembership(
    tenantId: string,
    userId: string,
  ): Promise<TenantMembership | null> {
    return (
      (await this.db.query.tenantMemberships.findFirst({
        where: and(
          eq(tenantMemberships.tenantId, tenantId),
          eq(tenantMemberships.userId, userId),
          eq(tenantMemberships.status, "active"),
        ),
      })) ?? null
    );
  }

  async requireMembership(
    tenantId: string,
    userId: string,
    minRole: "member" | "admin" | "owner" = "member",
  ): Promise<TenantMembership> {
    const m = await this.getMembership(tenantId, userId);
    if (!m) throw new TenantAccessError("Not a member of this tenant", 403);
    if (minRole === "admin" && !isTenantAdmin(m.role)) {
      throw new TenantAccessError("Admin only", 403);
    }
    if (minRole === "owner" && m.role !== "owner") {
      throw new TenantAccessError("Owner only", 403);
    }
    return m;
  }

  async createTenant(input: {
    name: string;
    slug?: string;
    ownerUserId: string;
    isDefault?: boolean;
  }): Promise<{ tenant: Tenant; membership: TenantMembership }> {
    const name = input.name.trim();
    if (!name) throw new TenantAccessError("Tenant name required", 400);

    let slug = slugify(input.slug?.trim() || name);
    for (let i = 0; i < 8; i++) {
      const clash = await this.db.query.tenants.findFirst({
        where: eq(tenants.slug, slug),
      });
      if (!clash) break;
      slug = `${slugify(name)}-${randomBytes(2).toString("hex")}`;
    }

    const now = new Date();
    const [tenant] = await this.db
      .insert(tenants)
      .values({
        id: newId(),
        slug,
        name,
        isDefault: input.isDefault === true,
        onboardingCompleted: false,
        onboardingSteps: "{}",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const [membership] = await this.db
      .insert(tenantMemberships)
      .values({
        id: newId(),
        tenantId: tenant.id,
        userId: input.ownerUserId,
        role: "owner",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return { tenant, membership };
  }

  async updateTenant(
    tenantId: string,
    patch: { name?: string },
  ): Promise<Tenant> {
    const [row] = await this.db
      .update(tenants)
      .set({
        ...(patch.name?.trim() ? { name: patch.name.trim() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenantId))
      .returning();
    if (!row) throw new TenantAccessError("Tenant not found", 404);
    return row;
  }

  async deleteTenant(tenantId: string, actorUserId: string) {
    await this.requireMembership(tenantId, actorUserId, "owner");
    const tenant = await this.db.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
    });
    if (!tenant) throw new TenantAccessError("Team not found", 404);
    if (tenant.isDefault) {
      throw new TenantAccessError("The default team cannot be deleted", 400);
    }
    await this.db.delete(tenants).where(eq(tenants.id, tenantId));
    return { ok: true as const };
  }

  async listMembers(tenantId: string) {
    const rows = await this.db
      .select({
        id: tenantMemberships.id,
        role: tenantMemberships.role,
        status: tenantMemberships.status,
        createdAt: tenantMemberships.createdAt,
        userId: users.id,
        email: users.email,
        name: users.name,
      })
      .from(tenantMemberships)
      .innerJoin(users, eq(users.id, tenantMemberships.userId))
      .where(eq(tenantMemberships.tenantId, tenantId))
      .orderBy(asc(tenantMemberships.createdAt));

    return rows.map((r) => ({
      id: r.id,
      role: r.role as TenantRole,
      status: r.status as MembershipStatus,
      createdAt: r.createdAt,
      user: { id: r.userId, email: r.email, name: r.name },
    }));
  }

  async updateMemberRole(
    tenantId: string,
    membershipId: string,
    role: TenantRole,
    actorUserId: string,
  ) {
    if (role === "owner") {
      throw new TenantAccessError("Cannot assign owner via role update", 400);
    }
    await this.requireMembership(tenantId, actorUserId, "admin");
    const target = await this.db.query.tenantMemberships.findFirst({
      where: and(
        eq(tenantMemberships.id, membershipId),
        eq(tenantMemberships.tenantId, tenantId),
      ),
    });
    if (!target) throw new TenantAccessError("Member not found", 404);
    if (target.role === "owner") {
      throw new TenantAccessError("Cannot change owner role", 400);
    }
    const [row] = await this.db
      .update(tenantMemberships)
      .set({ role, updatedAt: new Date() })
      .where(eq(tenantMemberships.id, membershipId))
      .returning();
    return row;
  }

  async removeMember(tenantId: string, membershipId: string, actorUserId: string) {
    await this.requireMembership(tenantId, actorUserId, "admin");
    const target = await this.db.query.tenantMemberships.findFirst({
      where: and(
        eq(tenantMemberships.id, membershipId),
        eq(tenantMemberships.tenantId, tenantId),
      ),
    });
    if (!target) throw new TenantAccessError("Member not found", 404);
    if (target.role === "owner") {
      throw new TenantAccessError("Cannot remove owner", 400);
    }
    if (target.userId === actorUserId) {
      throw new TenantAccessError("Cannot remove yourself; leave the tenant instead", 400);
    }
    await this.db
      .delete(tenantMemberships)
      .where(eq(tenantMemberships.id, membershipId));
    return { ok: true as const };
  }

  async leaveTenant(tenantId: string, userId: string) {
    const m = await this.getMembership(tenantId, userId);
    if (!m) throw new TenantAccessError("Not a member", 404);
    if (m.role === "owner") {
      throw new TenantAccessError("Owner cannot leave; transfer ownership first", 400);
    }
    await this.db.delete(tenantMemberships).where(eq(tenantMemberships.id, m.id));
    return { ok: true as const };
  }

  async createInvite(input: {
    tenantId: string;
    email: string;
    role: "admin" | "member";
    invitedByUserId: string;
    ttlHours?: number;
  }): Promise<{ invite: TenantInvite; token: string }> {
    await this.requireMembership(input.tenantId, input.invitedByUserId, "admin");
    const email = input.email.trim().toLowerCase();
    if (!email) throw new TenantAccessError("Email required", 400);

    const existingUser = await this.db.query.users.findFirst({
      where: eq(users.email, email),
    });
    if (existingUser) {
      const already = await this.getMembership(input.tenantId, existingUser.id);
      if (already) throw new TenantAccessError("User is already a member", 400);
    }

    const token = `inv_${randomBytes(24).toString("base64url")}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (input.ttlHours ?? 72) * 3600 * 1000);

    // Replace pending invite for same email
    await this.db
      .delete(tenantInvites)
      .where(
        and(
          eq(tenantInvites.tenantId, input.tenantId),
          eq(tenantInvites.email, email),
          isNull(tenantInvites.acceptedAt),
        ),
      );

    const [invite] = await this.db
      .insert(tenantInvites)
      .values({
        id: newId(),
        tenantId: input.tenantId,
        email,
        role: input.role,
        tokenHash: hashInviteToken(token),
        invitedByUserId: input.invitedByUserId,
        expiresAt,
        createdAt: now,
      })
      .returning();

    return { invite, token };
  }

  async listInvites(tenantId: string) {
    return this.db
      .select()
      .from(tenantInvites)
      .where(and(eq(tenantInvites.tenantId, tenantId), isNull(tenantInvites.acceptedAt)))
      .orderBy(asc(tenantInvites.createdAt));
  }

  async getInviteByToken(rawToken: string) {
    const hash = hashInviteToken(rawToken);
    const invite = await this.db.query.tenantInvites.findFirst({
      where: eq(tenantInvites.tokenHash, hash),
    });
    if (!invite) return null;
    const tenant = await this.db.query.tenants.findFirst({
      where: eq(tenants.id, invite.tenantId),
    });
    return { invite, tenant };
  }

  async acceptInvite(input: {
    token: string;
    userId?: string;
    email?: string;
    password?: string;
    name?: string;
  }): Promise<{ user: User; tenant: Tenant; membership: TenantMembership }> {
    const found = await this.getInviteByToken(input.token);
    if (!found?.invite || !found.tenant) {
      throw new TenantAccessError("Invalid invite", 404);
    }
    const { invite, tenant } = found;
    if (invite.acceptedAt) throw new TenantAccessError("Invite already used", 400);
    if (invite.expiresAt < new Date()) throw new TenantAccessError("Invite expired", 400);
    if (tenant.suspendedAt) throw new TenantAccessError("该团队已被封禁", 403);

    let user: User | undefined;
    if (input.userId) {
      user = await this.db.query.users.findFirst({ where: eq(users.id, input.userId) });
      if (!user) throw new TenantAccessError("User not found", 404);
      if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
        throw new TenantAccessError("Invite email does not match signed-in user", 403);
      }
    } else {
      const email = (input.email ?? invite.email).trim().toLowerCase();
      if (email !== invite.email.toLowerCase()) {
        throw new TenantAccessError("Email must match invite", 400);
      }
      user = await this.db.query.users.findFirst({ where: eq(users.email, email) });
      if (!user) {
        if (!input.password || input.password.length < 8) {
          throw new TenantAccessError("Password required (min 8 chars) to create account", 400);
        }        const now = new Date();
        const [created] = await this.db
          .insert(users)
          .values({
            id: newId(),
            email,
            name: input.name?.trim() || email.split("@")[0],
            passwordHash: await bcrypt.hash(input.password, 10),
            isPlatformAdmin: false,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        user = created;
      } else if (input.password) {
        if (!user.passwordHash) {
          throw new TenantAccessError("Invalid credentials", 401);
        }
        const ok = await bcrypt.compare(input.password, user.passwordHash);
        if (!ok) throw new TenantAccessError("Invalid credentials", 401);
      }
    }

    if (user.suspendedAt) throw new TenantAccessError("账号已被封禁", 403);

    const existing = await this.getMembership(tenant.id, user.id);
    if (existing) {
      await this.db
        .update(tenantInvites)
        .set({ acceptedAt: new Date() })
        .where(eq(tenantInvites.id, invite.id));
      return { user, tenant, membership: existing };
    }

    const now = new Date();
    const [membership] = await this.db
      .insert(tenantMemberships)
      .values({
        id: newId(),
        tenantId: tenant.id,
        userId: user.id,
        role: invite.role === "admin" ? "admin" : "member",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await this.db
      .update(tenantInvites)
      .set({ acceptedAt: now })
      .where(eq(tenantInvites.id, invite.id));

    return { user, tenant, membership };
  }

  async revokeInvite(tenantId: string, inviteId: string, actorUserId: string) {
    await this.requireMembership(tenantId, actorUserId, "admin");
    await this.db
      .delete(tenantInvites)
      .where(and(eq(tenantInvites.id, inviteId), eq(tenantInvites.tenantId, tenantId)));
    return { ok: true as const };
  }

  async getOnboarding(tenantId: string) {
    const tenant = await this.db.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
    });
    if (!tenant) throw new TenantAccessError("Tenant not found", 404);
    return {
      completed: tenant.onboardingCompleted,
      steps: parseOnboardingSteps(tenant.onboardingSteps),
    };
  }

  async patchOnboarding(
    tenantId: string,
    patch: { steps?: TenantOnboardingSteps; complete?: boolean },
  ) {
    const tenant = await this.db.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
    });
    if (!tenant) throw new TenantAccessError("Tenant not found", 404);
    const current = parseOnboardingSteps(tenant.onboardingSteps);
    const next = { ...current, ...(patch.steps ?? {}) };
    const completed =
      patch.complete === true
        ? true
        : patch.complete === false
          ? false
          : tenant.onboardingCompleted;
    const [row] = await this.db
      .update(tenants)
      .set({
        onboardingSteps: JSON.stringify(next),
        onboardingCompleted: completed,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenantId))
      .returning();
    return {
      completed: row.onboardingCompleted,
      steps: parseOnboardingSteps(row.onboardingSteps),
    };
  }

  /** Platform admin: list all tenants */
  async listAll() {
    return this.db.select().from(tenants).orderBy(asc(tenants.createdAt));
  }
}

export class TenantAccessError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "TenantAccessError";
  }
}
