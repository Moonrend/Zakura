import type { Hono } from "hono";

/** Minimal session shape expected by SaaS routes. */
export type SaasSession = {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
  isPlatformAdmin?: boolean;
};

export type SaasTenantRole = "owner" | "admin" | "member";

/** Host-injected dependencies — keeps @zakura/saas free of a hard dep on @zakura/server. */
export type SaasHostDeps = {
  db: unknown;
  config: {
    secret: string;
    webPublicUrl: string;
    multiTenant: boolean;
    edition: "saas";
  };
  encryptJson: (secret: string, value: unknown) => string;
  decryptJson: <T = unknown>(secret: string, payload: string) => T;
  /** TenantService from apps/server — duck-typed to avoid circular package deps. */
  tenants: {
    createTenant: (input: {
      name: string;
      slug?: string;
      ownerUserId: string;
    }) => Promise<{
      tenant: {
        id: string;
        slug: string;
        name: string;
        onboardingCompleted: boolean;
      };
      membership: { role: string };
    }>;
    listMembers: (tenantId: string) => Promise<unknown[]>;
    updateMemberRole: (
      tenantId: string,
      membershipId: string,
      role: SaasTenantRole,
      actorUserId: string,
    ) => Promise<unknown>;
    removeMember: (
      tenantId: string,
      membershipId: string,
      actorUserId: string,
    ) => Promise<unknown>;
    leaveTenant: (tenantId: string, userId: string) => Promise<unknown>;
    listInvites: (tenantId: string) => Promise<
      Array<{
        id: string;
        email: string;
        role: string;
        expiresAt: Date;
        createdAt: Date;
      }>
    >;
    createInvite: (input: {
      tenantId: string;
      email: string;
      role: "admin" | "member";
      invitedByUserId: string;
    }) => Promise<{
      invite: { id: string; email: string; role: string; expiresAt: Date };
      token: string;
    }>;
    revokeInvite: (
      tenantId: string,
      inviteId: string,
      actorUserId: string,
    ) => Promise<unknown>;
    getInviteByToken: (token: string) => Promise<{
      invite: {
        email: string;
        role: string;
        expiresAt: Date;
        acceptedAt: Date | null;
      };
      tenant: { name: string; slug: string };
    } | null>;
    acceptInvite: (input: {
      token: string;
      userId?: string;
      email?: string;
      password?: string;
      name?: string;
    }) => Promise<{
      user: { id: string; email: string; name: string | null; isPlatformAdmin?: boolean };
      tenant: {
        id: string;
        slug: string;
        name: string;
        onboardingCompleted: boolean;
      };
      membership: { role: string };
    }>;
    listAll: () => Promise<
      Array<{
        id: string;
        slug: string;
        name: string;
        isDefault: boolean;
        onboardingCompleted: boolean;
        createdAt: Date;
      }>
    >;
  };
  signSession: (
    secret: string,
    payload: {
      userId: string;
      tenantId: string;
      email: string;
      role: string;
      isPlatformAdmin?: boolean;
    },
  ) => string;
  sessionFromLogin: (
    secret: string,
    result: {
      user: { id: string; email: string; isPlatformAdmin?: boolean };
      tenant: { id: string };
      membership: { role: string };
    },
  ) => string;
  switchTenantSession: (
    db: unknown,
    secret: string,
    userId: string,
    tenantId: string,
  ) => Promise<string | null>;
  isSessionAdmin: (session: SaasSession) => boolean;
  ensurePlatformMeta: (
    db: unknown,
    opts?: { multiTenant?: boolean },
  ) => Promise<{ setupCompleted: boolean; mode: string; version: string }>;
  /** Optional: seed local runner / network defaults for newly created tenants */
  onTenantCreated?: (tenantId: string) => Promise<void>;
  /**
   * Optional: platform admin runner management (shared runners).
   * Injected by host to avoid circular package deps.
   */
  runtimeNodes?: {
    listAllRemote: () => Promise<
      Array<{
        id: string;
        tenantId: string;
        name: string;
        slug: string;
        kind: string;
        status: string;
        isShared: boolean;
        createdByUserId: string | null;
        lastSeenAt: Date | null;
        createdAt: Date;
      }>
    >;
    setShared: (
      nodeId: string,
      isShared: boolean,
      actor: { userId: string; isPlatformAdmin: boolean },
    ) => Promise<{
      id: string;
      tenantId: string;
      name: string;
      isShared: boolean;
      createdByUserId: string | null;
    }>;
    mapPublic?: (node: unknown) => unknown;
  };
};

export type SaasApp = Hono<{ Variables: { session?: SaasSession } }>;
