import { and, eq } from "drizzle-orm";
import {
  DEFAULT_DENIED_PORTS,
  type NetworkSecurityPolicyDto,
} from "@zakura/shared";
import type { Db } from "../db/client.js";
import {
  networkSecurityPolicies,
  newId,
  type NetworkSecurityPolicy,
} from "../db/schema.js";
import type { NetworkAuditService } from "./network-audit.js";

function parseDeniedPorts(raw: string): number[] {
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [...DEFAULT_DENIED_PORTS];
    return arr
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  } catch {
    return [...DEFAULT_DENIED_PORTS];
  }
}

export function serializeSecurityPolicy(row: NetworkSecurityPolicy): NetworkSecurityPolicyDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    scope: row.scope as "platform" | "tenant",
    enabled: row.enabled,
    exposureEnabled: row.exposureEnabled,
    defaultTtlMinutes: row.defaultTtlMinutes,
    maxTtlMinutes: row.maxTtlMinutes,
    maxActivePerAgent: row.maxActivePerAgent,
    maxActivePerTenant: row.maxActivePerTenant,
    deniedPorts: parseDeniedPorts(row.deniedPortsJson),
    allowDesktopExposure: row.allowDesktopExposure,
    allowPublicExposure: row.allowPublicExposure,
    allowTcpExposure: row.allowTcpExposure,
    agentsCanExpose: row.agentsCanExpose,
    requireUserApproval: row.requireUserApproval,
    requireTailscaleForRemoteRunners: row.requireTailscaleForRemoteRunners,
    auditRetentionDays: row.auditRetentionDays,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type SecurityPolicyPatch = Partial<{
  enabled: boolean;
  exposureEnabled: boolean;
  defaultTtlMinutes: number;
  maxTtlMinutes: number;
  maxActivePerAgent: number;
  maxActivePerTenant: number;
  deniedPorts: number[];
  allowDesktopExposure: boolean;
  allowPublicExposure: boolean;
  allowTcpExposure: boolean;
  agentsCanExpose: boolean;
  requireUserApproval: boolean;
  requireTailscaleForRemoteRunners: boolean;
  auditRetentionDays: number;
}>;

export class SecurityPolicyService {
  constructor(
    private readonly db: Db,
    private readonly audit?: NetworkAuditService,
  ) {}

  async ensureDefault(tenantId: string): Promise<NetworkSecurityPolicy> {
    const existing = await this.db.query.networkSecurityPolicies.findFirst({
      where: and(
        eq(networkSecurityPolicies.tenantId, tenantId),
        eq(networkSecurityPolicies.scope, "tenant"),
      ),
    });
    if (existing) return existing;

    const now = new Date();
    const [row] = await this.db
      .insert(networkSecurityPolicies)
      .values({
        id: newId(),
        tenantId,
        scope: "tenant",
        enabled: true,
        exposureEnabled: true,
        defaultTtlMinutes: 60,
        maxTtlMinutes: 1440,
        maxActivePerAgent: 3,
        maxActivePerTenant: 50,
        deniedPortsJson: JSON.stringify([...DEFAULT_DENIED_PORTS]),
        allowDesktopExposure: false,
        allowPublicExposure: true,
        allowTcpExposure: false,
        agentsCanExpose: true,
        requireUserApproval: false,
        requireTailscaleForRemoteRunners: false,
        auditRetentionDays: 90,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (row) return row;
    return (
      (await this.db.query.networkSecurityPolicies.findFirst({
        where: and(
          eq(networkSecurityPolicies.tenantId, tenantId),
          eq(networkSecurityPolicies.scope, "tenant"),
        ),
      })) ??
      (() => {
        throw new Error("Failed to seed network security policy");
      })()
    );
  }

  async get(tenantId: string): Promise<NetworkSecurityPolicyDto> {
    const row = await this.ensureDefault(tenantId);
    return serializeSecurityPolicy(row);
  }

  async getRow(tenantId: string): Promise<NetworkSecurityPolicy> {
    return this.ensureDefault(tenantId);
  }

  async update(
    tenantId: string,
    patch: SecurityPolicyPatch,
    opts?: { updatedBy?: string; actorId?: string; ip?: string },
  ): Promise<NetworkSecurityPolicyDto> {
    const current = await this.ensureDefault(tenantId);
    const now = new Date();

    const set: Partial<NetworkSecurityPolicy> & { updatedAt: Date } = {
      updatedAt: now,
      updatedBy: opts?.updatedBy ?? null,
    };

    if (typeof patch.enabled === "boolean") set.enabled = patch.enabled;
    if (typeof patch.exposureEnabled === "boolean") set.exposureEnabled = patch.exposureEnabled;
    if (typeof patch.defaultTtlMinutes === "number") {
      set.defaultTtlMinutes = Math.max(1, Math.min(patch.defaultTtlMinutes, 10080));
    }
    if (typeof patch.maxTtlMinutes === "number") {
      set.maxTtlMinutes = Math.max(1, Math.min(patch.maxTtlMinutes, 10080));
    }
    if (typeof patch.maxActivePerAgent === "number") {
      set.maxActivePerAgent = Math.max(0, Math.min(patch.maxActivePerAgent, 100));
    }
    if (typeof patch.maxActivePerTenant === "number") {
      set.maxActivePerTenant = Math.max(0, Math.min(patch.maxActivePerTenant, 1000));
    }
    if (Array.isArray(patch.deniedPorts)) {
      set.deniedPortsJson = JSON.stringify(
        [...new Set(patch.deniedPorts.filter((n) => Number.isInteger(n) && n > 0 && n < 65536))],
      );
    }
    if (typeof patch.allowDesktopExposure === "boolean") {
      set.allowDesktopExposure = patch.allowDesktopExposure;
    }
    if (typeof patch.allowPublicExposure === "boolean") {
      set.allowPublicExposure = patch.allowPublicExposure;
    }
    if (typeof patch.allowTcpExposure === "boolean") set.allowTcpExposure = patch.allowTcpExposure;
    if (typeof patch.agentsCanExpose === "boolean") set.agentsCanExpose = patch.agentsCanExpose;
    if (typeof patch.requireUserApproval === "boolean") {
      set.requireUserApproval = patch.requireUserApproval;
    }
    if (typeof patch.requireTailscaleForRemoteRunners === "boolean") {
      set.requireTailscaleForRemoteRunners = patch.requireTailscaleForRemoteRunners;
    }
    if (typeof patch.auditRetentionDays === "number") {
      set.auditRetentionDays = Math.max(1, Math.min(patch.auditRetentionDays, 3650));
    }

    // Keep default TTL within max
    const nextDefault = set.defaultTtlMinutes ?? current.defaultTtlMinutes;
    const nextMax = set.maxTtlMinutes ?? current.maxTtlMinutes;
    if (nextDefault > nextMax) set.defaultTtlMinutes = nextMax;

    const [row] = await this.db
      .update(networkSecurityPolicies)
      .set(set)
      .where(eq(networkSecurityPolicies.id, current.id))
      .returning();

    await this.audit?.append(tenantId, "security.policy.update", {
      actor: { type: "user", id: opts?.actorId, ip: opts?.ip },
      targetType: "network_security_policy",
      targetId: current.id,
      detail: patch as Record<string, unknown>,
    });

    return serializeSecurityPolicy(row);
  }

  /** Validate a port against the policy; throws Error with message on deny. */
  assertPortAllowed(policy: NetworkSecurityPolicy | NetworkSecurityPolicyDto, port: number): void {
    const denied =
      "deniedPorts" in policy
        ? policy.deniedPorts
        : parseDeniedPorts(policy.deniedPortsJson);
    if (denied.includes(port)) {
      throw new Error(`Port ${port} is denied by security policy`);
    }
    // Desktop / CDP / noVNC common ports
    if (!("allowDesktopExposure" in policy ? policy.allowDesktopExposure : false)) {
      if ([5900, 6080, 9222].includes(port)) {
        throw new Error(`Desktop/CDP port ${port} exposure is disabled`);
      }
    }
  }
}
