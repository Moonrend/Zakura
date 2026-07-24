import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

/**
 * Public self-registration (SaaS only).
 * Creates a global user + a new tenant with the user as owner.
 */
export type RegisterSchema = {
  users: unknown;
  tenants: unknown;
  tenantMemberships: unknown;
  newId: () => string;
};

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || `tenant-${Date.now().toString(36)}`
  );
}

export class RegisterError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "RegisterError";
  }
}

export async function registerSaasUser(
  dbUnknown: unknown,
  schema: RegisterSchema,
  input: {
    email: string;
    password: string;
    name?: string;
    tenantName?: string;
  },
) {
  // Host drizzle client + table objects
  const db = dbUnknown as {
    query: {
      users: { findFirst: (args: unknown) => Promise<{ id: string } | null | undefined> };
      tenants: { findFirst: (args: unknown) => Promise<unknown> };
    };
    transaction: <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T>;
    insert: (table: unknown) => {
      values: (v: unknown) => { returning: () => Promise<[Record<string, unknown>]> };
    };
  };
  const users = schema.users as { email: unknown };
  const tenants = schema.tenants as { slug: unknown };
  const tenantMemberships = schema.tenantMemberships;

  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new RegisterError("Valid email required", 400);
  }
  if (!input.password || input.password.length < 8) {
    throw new RegisterError("Password required (min 8 chars)", 400);
  }

  const existing = await db.query.users.findFirst({
    where: eq(users.email as never, email),
  });
  if (existing) {
    throw new RegisterError("Email already registered", 409);
  }

  const tenantName = input.tenantName?.trim() || `${email.split("@")[0]}'s workspace`;
  let slug = slugify(tenantName);
  for (let i = 0; i < 8; i++) {
    const clash = await db.query.tenants.findFirst({
      where: eq(tenants.slug as never, slug),
    });
    if (!clash) break;
    slug = `${slugify(tenantName)}-${randomBytes(2).toString("hex")}`;
  }

  const now = new Date();
  const passwordHash = await bcrypt.hash(input.password, 12);

  return db.transaction(async (tx) => {
    const [tenant] = await tx
      .insert(schema.tenants)
      .values({
        id: schema.newId(),
        slug,
        name: tenantName,
        isDefault: false,
        onboardingCompleted: false,
        onboardingSteps: "{}",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const [user] = await tx
      .insert(schema.users)
      .values({
        id: schema.newId(),
        email,
        name: input.name?.trim() || email.split("@")[0],
        passwordHash,
        isPlatformAdmin: false,
        canUseLocalRunner: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const [membership] = await tx
      .insert(tenantMemberships)
      .values({
        id: schema.newId(),
        tenantId: (tenant as { id: string }).id,
        userId: (user as { id: string }).id,
        role: "owner",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return {
      user: user as {
        id: string;
        email: string;
        name: string | null;
        isPlatformAdmin?: boolean;
      },
      tenant: tenant as {
        id: string;
        slug: string;
        name: string;
        onboardingCompleted: boolean;
      },
      membership: membership as { role: string },
    };
  });
}
