/** 超管后台共享类型与调用封装（SaaS only）。 */
import { api } from "@/lib/api";

export type AdminSuspension = {
  suspended: boolean;
  suspendedAt: string | null;
  suspendedReason: string | null;
  suspendedByUserId: string | null;
};

export type AdminUserRow = AdminSuspension & {
  id: string;
  email: string;
  name: string | null;
  isPlatformAdmin: boolean;
  canUseLocalRunner: boolean;
  hasPassword: boolean;
  tenants: Array<{ tenantId: string; slug: string; name: string; role: string }>;
  createdAt: string;
};

export type AdminUserDetail = {
  user: AdminSuspension & {
    id: string;
    email: string;
    name: string | null;
    isPlatformAdmin: boolean;
    canUseLocalRunner: boolean;
    hasPassword: boolean;
    createdAt: string;
    updatedAt: string;
    suspendedBy: { id: string; email: string } | null;
  };
  memberships: Array<{
    membershipId: string;
    role: string;
    status: string;
    joinedAt: string;
    tenantId: string;
    slug: string;
    name: string;
    tenantSuspended: boolean;
  }>;
  identities: Array<{ provider: string; createdAt: string }>;
  runners: Array<{ id: string; name: string; status: string; isShared: boolean }>;
};

export type AdminTenantRow = AdminSuspension & {
  id: string;
  slug: string;
  name: string;
  isDefault: boolean;
  onboardingCompleted: boolean;
  memberCount: number;
  createdAt: string;
};

export type AdminTenantDetail = {
  tenant: AdminSuspension & {
    id: string;
    slug: string;
    name: string;
    isDefault: boolean;
    onboardingCompleted: boolean;
    createdAt: string;
    suspendedBy: { id: string; email: string } | null;
  };
  members: Array<{
    membershipId: string;
    role: string;
    status: string;
    joinedAt: string;
    user: {
      id: string;
      email: string;
      name: string | null;
      suspended: boolean;
      isPlatformAdmin: boolean;
    };
  }>;
  runners: Array<{ id: string; name: string; status: string; isShared: boolean }>;
};

export type AdminRunnerRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  isShared: boolean;
  tenantId: string;
  tenantSlug: string | null;
  tenantName: string | null;
  createdByUserId: string | null;
  createdByEmail: string | null;
  ownerIsPlatformAdmin: boolean;
  lastSeenAt: string | null;
  createdAt: string;
};

export type AdminStats = {
  users: { total: number; suspended: number; admins: number; newLast7d: number };
  tenants: { total: number; suspended: number; newLast7d: number };
  runners: { total: number; shared: number; online: number };
};

export function suspendUser(userId: string, reason?: string) {
  return api<{ user: AdminSuspension & { id: string } }>(
    `/api/admin/users/${userId}/suspend`,
    { method: "POST", json: { reason } },
  );
}

export function unsuspendUser(userId: string) {
  return api<{ user: AdminSuspension & { id: string } }>(
    `/api/admin/users/${userId}/unsuspend`,
    { method: "POST" },
  );
}

export function suspendTenant(tenantId: string, reason?: string) {
  return api<{ tenant: AdminSuspension & { id: string } }>(
    `/api/admin/tenants/${tenantId}/suspend`,
    { method: "POST", json: { reason } },
  );
}

export function unsuspendTenant(tenantId: string) {
  return api<{ tenant: AdminSuspension & { id: string } }>(
    `/api/admin/tenants/${tenantId}/unsuspend`,
    { method: "POST" },
  );
}

export const ROLE_LABEL: Record<string, string> = {
  owner: "所有者",
  admin: "管理员",
  member: "成员",
};
