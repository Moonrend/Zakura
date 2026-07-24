import { and, eq, inArray, or, desc, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  componentInstances,
  managedContainers,
  newId,
  platformMeta,
  providerCatalog,
  settings,
  tenantMemberships,
  tenants,
  users,
  type Tenant,
  type User,
} from "../db/schema.js";
import { globalRegistry } from "@zakura/core";
import bcrypt from "bcryptjs";
import type { SetupPayload } from "@zakura/shared";

export async function syncProviderCatalog(db: Db): Promise<void> {
  const now = new Date();
  for (const plugin of globalRegistry.list()) {
    await db
      .insert(providerCatalog)
      .values({
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        version: plugin.version,
        category: plugin.category,
        capabilities: JSON.stringify(plugin.capabilities),
        configSchema: JSON.stringify(plugin.configSchema),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: providerCatalog.id,
        set: {
          name: plugin.name,
          description: plugin.description,
          version: plugin.version,
          category: plugin.category,
          capabilities: JSON.stringify(plugin.capabilities),
          configSchema: JSON.stringify(plugin.configSchema),
          updatedAt: now,
        },
      });
  }
}

export async function ensurePlatformMeta(db: Db, opts?: { multiTenant?: boolean }) {
  const existing = await db.query.platformMeta.findFirst({
    where: eq(platformMeta.id, "platform"),
  });
  const desiredMode = opts?.multiTenant ? "multi-tenant" : "single-tenant";

  if (existing) {
    // Env is source of truth for deployment mode — keep DB row in sync
    if (existing.mode !== desiredMode) {
      const [updated] = await db
        .update(platformMeta)
        .set({ mode: desiredMode, updatedAt: new Date() })
        .where(eq(platformMeta.id, "platform"))
        .returning();
      return updated ?? existing;
    }
    return existing;
  }

  const now = new Date();
  const [row] = await db
    .insert(platformMeta)
    .values({
      id: "platform",
      setupCompleted: false,
      mode: desiredMode,
      version: "0.1.0",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();

  return (
    row ??
    (await db.query.platformMeta.findFirst({
      where: eq(platformMeta.id, "platform"),
    }))!
  );
}

/**
 * When switching an existing single-tenant install to SaaS, the original
 * setup user was created with isPlatformAdmin=false. Promote the default
 * tenant owner so超管 / multi-tenant console works without a DB reset.
 */
export async function ensureSaasPlatformAdmin(db: Db) {
  const existingAdmin = await db.query.users.findFirst({
    where: eq(users.isPlatformAdmin, true),
  });
  if (existingAdmin) return existingAdmin;

  const defaultTenant = await db.query.tenants.findFirst({
    where: eq(tenants.isDefault, true),
  });
  if (!defaultTenant) return null;

  const ownerMembership = await db.query.tenantMemberships.findFirst({
    where: and(
      eq(tenantMemberships.tenantId, defaultTenant.id),
      eq(tenantMemberships.role, "owner"),
      eq(tenantMemberships.status, "active"),
    ),
  });
  if (!ownerMembership) return null;

  const [updated] = await db
    .update(users)
    .set({ isPlatformAdmin: true, canUseLocalRunner: true, updatedAt: new Date() })
    .where(eq(users.id, ownerMembership.userId))
    .returning();

  if (updated) {
    console.log(
      `[saas] promoted ${updated.email} to platform admin (was single-tenant setup)`,
    );
  }
  return updated ?? null;
}

/**
 * System (platform) setup — self-hosted first install.
 * Always creates the default tenant; admin form only needs account fields.
 * Tenant onboarding (Agent/MCP wizard) remains incomplete.
 */
export async function runSetup(db: Db, payload: SetupPayload) {
  const meta = await db.query.platformMeta.findFirst({
    where: eq(platformMeta.id, "platform"),
  });
  if (!meta) {
    throw new Error("Platform meta missing — call ensurePlatformMeta first");
  }
  if (meta.setupCompleted) {
    throw new Error("Platform already initialized");
  }

  // Single-tenant (default): force Default; multi-tenant may customize name via payload
  const isSingle = meta.mode !== "multi-tenant";
  const tenantName = isSingle
    ? "Default"
    : (payload.tenantName?.trim() || "Default");
  const passwordHash = await bcrypt.hash(payload.adminPassword, 12);
  const now = new Date();

  return db.transaction(async (tx) => {
    const [tenant] = await tx
      .insert(tenants)
      .values({
        id: newId(),
        slug: "default",
        name: tenantName,
        isDefault: true,
        onboardingCompleted: false,
        onboardingSteps: "{}",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const [user] = await tx
      .insert(users)
      .values({
        id: newId(),
        email: payload.adminEmail.toLowerCase(),
        name: payload.adminName?.trim() || "Admin",
        passwordHash,
        // Platform admin flag only meaningful when multi-tenant is enabled
        isPlatformAdmin: !isSingle,
        // 自托管始终可用 Local；SaaS 管理员默认授权
        canUseLocalRunner: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await tx.insert(tenantMemberships).values({
      id: newId(),
      tenantId: tenant.id,
      userId: user.id,
      role: "owner",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    await tx
      .update(platformMeta)
      .set({ setupCompleted: true, updatedAt: now })
      .where(eq(platformMeta.id, "platform"));

    await tx.insert(settings).values({
      id: newId(),
      ownerKey: "platform",
      key: "ui.theme",
      value: JSON.stringify({ mode: "system" }),
    });

    return { tenant, user };
  });
}

export async function getDefaultTenant(db: Db) {
  return db.query.tenants.findFirst({
    where: eq(tenants.isDefault, true),
  });
}

export async function markTenantOnboardingComplete(db: Db, tenantId: string) {
  const now = new Date();
  const [row] = await db
    .update(tenants)
    .set({ onboardingCompleted: true, updatedAt: now })
    .where(eq(tenants.id, tenantId))
    .returning();
  return row ?? null;
}

export async function setPlatformMode(
  db: Db,
  mode: "single-tenant" | "multi-tenant",
) {
  const [row] = await db
    .update(platformMeta)
    .set({ mode, updatedAt: new Date() })
    .where(eq(platformMeta.id, "platform"))
    .returning();
  return row;
}

export type { Tenant, User, Db };
export {
  and,
  eq,
  inArray,
  or,
  desc,
  isNull,
  componentInstances,
  managedContainers,
};
