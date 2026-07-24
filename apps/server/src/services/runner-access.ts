import { and, eq, sql } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { managedContainers, runtimeNodes, users } from "../db/schema.js";

/** 共享 Runner 滥用防护上限 */
export const SHARED_RUNNER_LIMITS = {
  /** 每个租户在共享 runner 上同时存活的工作区数（Agent 绑定不限） */
  maxActiveWorkspacesPerTenant: 1,
  /** 共享 runner 全局同时存活工作区上限 */
  maxActiveWorkspacesTotal: 40,
  /** 允许 Cloudflare Quick Tunnel 等端口暴露 */
  allowPortExposure: true,
  /** 禁止宿主机级容器分配 */
  allowContainerAllocate: false,
  /** 禁止 archive/extract 等重操作 */
  allowArchive: false,
  /** 单工作区磁盘软上限（字节） */
  maxWorkspaceBytes: 2 * 1024 * 1024 * 1024,
} as const;

export class RunnerAccessError extends Error {
  status: 403 | 400 | 404;
  constructor(message: string, status: 403 | 400 | 404 = 403) {
    super(message);
    this.name = "RunnerAccessError";
    this.status = status;
  }
}

/**
 * 是否允许使用 Local Runner。
 * - 自托管（非 multiTenant）：始终允许
 * - 平台管理员：始终允许
 * - 其余：需 canUseLocalRunner 手动授权
 */
export async function userCanUseLocalRunner(
  db: Db,
  config: Pick<AppConfig, "multiTenant">,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!config.multiTenant) return true;
  if (!userId || userId === "api-key") return false;
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return false;
  if (user.isPlatformAdmin) return true;
  return user.canUseLocalRunner === true;
}

export function assertCanUseLocalRunner(allowed: boolean): void {
  if (!allowed) {
    throw new RunnerAccessError(
      "未授权使用本机 Local Runner。请联系平台管理员在「超级管理」中授权。",
      403,
    );
  }
}

/** 节点是否对调用租户为「外来共享」访问（非本租户拥有） */
export function isForeignSharedAccess(
  node: { tenantId: string; isShared: boolean },
  callerTenantId: string,
): boolean {
  return node.isShared && node.tenantId !== callerTenantId;
}

/** 解析本租户节点，或跨租户共享远程节点 */
export async function resolveAccessibleNode(
  db: Db,
  tenantId: string,
  nodeId: string,
): Promise<(typeof runtimeNodes.$inferSelect) | null> {
  const owned = await db.query.runtimeNodes.findFirst({
    where: and(eq(runtimeNodes.tenantId, tenantId), eq(runtimeNodes.id, nodeId)),
  });
  if (owned) return owned;

  const shared = await db.query.runtimeNodes.findFirst({
    where: and(
      eq(runtimeNodes.id, nodeId),
      eq(runtimeNodes.isShared, true),
      eq(runtimeNodes.kind, "runner"),
    ),
  });
  return shared ?? null;
}

export async function listSharedRunnerNodes(db: Db, excludeTenantId?: string) {
  const rows = await db.query.runtimeNodes.findMany({
    where: and(eq(runtimeNodes.isShared, true), eq(runtimeNodes.kind, "runner")),
  });
  if (!excludeTenantId) return rows;
  return rows.filter((n) => n.tenantId !== excludeTenantId);
}

/**
 * 绑定 / 启动前校验：本地需授权；共享仅限制工作区并发。
 */
export async function assertNodeBindAllowed(
  db: Db,
  config: Pick<AppConfig, "multiTenant">,
  opts: {
    userId: string;
    tenantId: string;
    /** null / local → Local Runner */
    nodeId: string | null;
    /** 启动/重启时排除当前 agent 已有工作区，避免误占配额 */
    excludeAgentId?: string;
  },
): Promise<void> {
  const { userId, tenantId, nodeId, excludeAgentId } = opts;

  if (!nodeId || nodeId === "local") {
    const ok = await userCanUseLocalRunner(db, config, userId);
    assertCanUseLocalRunner(ok);
    return;
  }

  const node = await resolveAccessibleNode(db, tenantId, nodeId);
  if (!node) {
    throw new RunnerAccessError("Runner 节点不存在或不可访问", 404);
  }

  if (node.kind === "local" || node.slug === "local") {
    const ok = await userCanUseLocalRunner(db, config, userId);
    assertCanUseLocalRunner(ok);
    return;
  }

  if (!isForeignSharedAccess(node, tenantId) && node.tenantId === tenantId) {
    // 本租户自有节点（即便也标了 shared）不走外来共享配额
    if (!node.isShared) return;
  }

  if (!node.isShared) {
    throw new RunnerAccessError("无权使用该 Runner", 403);
  }

  await assertSharedRunnerQuota(db, {
    nodeId: node.id,
    tenantId,
    excludeAgentId,
  });
}

export async function assertSharedRunnerQuota(
  db: Db,
  opts: { nodeId: string; tenantId: string; excludeAgentId?: string },
): Promise<void> {
  const { nodeId, tenantId, excludeAgentId } = opts;

  const tenantConds = [
    eq(managedContainers.tenantId, tenantId),
    eq(managedContainers.runtimeNodeId, nodeId),
    sql`${managedContainers.status} in ('running','starting','created')`,
  ];
  if (excludeAgentId) {
    // allocatedTo / agentId 任一指向当前 agent 则不计（重启工作区）
    tenantConds.push(
      sql`coalesce(${managedContainers.allocatedTo}, ${managedContainers.agentId}, '') <> ${excludeAgentId}`,
    );
  }

  const tenantActive = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(managedContainers)
    .where(and(...tenantConds));
  if ((tenantActive[0]?.c ?? 0) >= SHARED_RUNNER_LIMITS.maxActiveWorkspacesPerTenant) {
    throw new RunnerAccessError(
      `共享 Runner 每租户同时最多 ${SHARED_RUNNER_LIMITS.maxActiveWorkspacesPerTenant} 个活跃工作区`,
      400,
    );
  }

  const totalConds = [
    eq(managedContainers.runtimeNodeId, nodeId),
    sql`${managedContainers.status} in ('running','starting','created')`,
  ];
  if (excludeAgentId) {
    totalConds.push(
      sql`coalesce(${managedContainers.allocatedTo}, ${managedContainers.agentId}, '') <> ${excludeAgentId}`,
    );
  }

  const totalActive = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(managedContainers)
    .where(and(...totalConds));
  if ((totalActive[0]?.c ?? 0) >= SHARED_RUNNER_LIMITS.maxActiveWorkspacesTotal) {
    throw new RunnerAccessError(
      `共享 Runner 已达全局并发上限（${SHARED_RUNNER_LIMITS.maxActiveWorkspacesTotal}），请稍后重试`,
      400,
    );
  }
}

export function assertSharedRunnerOperationAllowed(
  node: { tenantId: string; isShared: boolean } | null | undefined,
  callerTenantId: string,
  op: "portExposure" | "containerAllocate" | "archive" | "manage",
): void {
  if (!node) return;
  const foreign = isForeignSharedAccess(node, callerTenantId);
  const shared = node.isShared;

  if (op === "manage" && foreign) {
    throw new RunnerAccessError("共享 Runner 仅拥有方可管理（删除/改名/安装）", 403);
  }
  if (!shared) return;
  if (op === "portExposure" && !SHARED_RUNNER_LIMITS.allowPortExposure) {
    throw new RunnerAccessError("共享 Runner 禁止端口暴露与隧道", 403);
  }
  if (op === "containerAllocate" && !SHARED_RUNNER_LIMITS.allowContainerAllocate) {
    throw new RunnerAccessError("共享 Runner 禁止宿主机容器分配", 403);
  }
  if (op === "archive" && !SHARED_RUNNER_LIMITS.allowArchive) {
    throw new RunnerAccessError("共享 Runner 禁止归档/解压操作", 403);
  }
}

/** 将用户设为平台管理员时同步授权 Local Runner */
export async function setPlatformAdminFlag(
  db: Db,
  userId: string,
  isPlatformAdmin: boolean,
): Promise<typeof users.$inferSelect | null> {
  const [updated] = await db
    .update(users)
    .set({
      isPlatformAdmin,
      ...(isPlatformAdmin ? { canUseLocalRunner: true } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning();
  return updated ?? null;
}
