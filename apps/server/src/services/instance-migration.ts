/**
 * MCP/component 实例跨 Runner 迁移：stop → export 数据卷 → import → 更新 runtime_node_id → start
 */
import { and, eq } from "drizzle-orm";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportWorkspace, importWorkspace } from "@zakura/core";
import { LOCAL_RUNTIME_NODE_ID } from "@zakura/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { componentInstances, runtimeNodes } from "../db/schema.js";
import type { Orchestrator } from "./orchestrator.js";
import type { RuntimeNodeService } from "./runtime-nodes.js";

function isLocalNodeId(id: string | null | undefined): boolean {
  return !id || id === LOCAL_RUNTIME_NODE_ID || id === "local";
}

export class InstanceMigrationService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly nodes: RuntimeNodeService,
    private readonly orchestrator: Orchestrator,
  ) {
    mkdirSync(this.stagingDir(), { recursive: true });
  }

  private stagingDir(): string {
    return join(this.config.migrationDir, "instances");
  }

  private localDataDir(instanceId: string, providerId: string): string {
    return join(this.config.dataDir, providerId, instanceId);
  }

  async migrate(
    tenantId: string,
    instanceId: string,
    targetNodeId: string,
  ): Promise<{ ok: true; runtimeNodeId: string | null }> {
    const instance = await this.db.query.componentInstances.findFirst({
      where: and(
        eq(componentInstances.id, instanceId),
        eq(componentInstances.tenantId, tenantId),
      ),
    });
    if (!instance) throw new Error("实例不存在");
    if (instance.providerId !== "stdio-mcp") {
      throw new Error("仅容器 MCP（stdio）支持 Runner 迁移");
    }

    const local = await this.nodes.ensureLocalNode(tenantId);
    const sourceId = instance.runtimeNodeId ?? local.id;
    const targetId = targetNodeId === "local" ? local.id : targetNodeId;
    if (sourceId === targetId) {
      return { ok: true, runtimeNodeId: instance.runtimeNodeId };
    }

    const target =
      (await this.db.query.runtimeNodes.findFirst({
        where: eq(runtimeNodes.id, targetId),
      })) ?? null;
    if (!target) throw new Error("目标 Runner 不存在");

    const wasRunning = instance.status === "running" || instance.status === "starting";
    if (wasRunning) {
      await this.orchestrator.stopInstance(tenantId, instanceId);
    }

    const archivePath = join(this.stagingDir(), `${instanceId}-${Date.now()}.tar.gz`);
    mkdirSync(this.stagingDir(), { recursive: true });

    // Export
    if (isLocalNodeId(sourceId) || sourceId === local.id) {
      const dataDir = this.localDataDir(instanceId, instance.providerId);
      mkdirSync(dataDir, { recursive: true });
      const { archive } = await exportWorkspace({
        workspaceRoot: dataDir,
        agentId: instanceId,
        sourceNodeId: sourceId,
      });
      writeFileSync(archivePath, archive);
    } else {
      const { client } = await this.nodes.requireRunnerClient(tenantId, sourceId);
      const { archive } = await client.exportInstanceMigration(instanceId, {
        sourceNodeId: sourceId,
      });
      writeFileSync(archivePath, archive);
    }

    const archive = readFileSync(archivePath);

    // Import
    if (isLocalNodeId(targetId) || target.kind === "local") {
      const dataDir = this.localDataDir(instanceId, instance.providerId);
      mkdirSync(dataDir, { recursive: true });
      await importWorkspace({
        targetWorkspaceRoot: dataDir,
        archive,
      });
    } else {
      const { client } = await this.nodes.requireRunnerClient(tenantId, targetId);
      await client.importInstanceMigration(instanceId, archive);
    }

    const nextNodeId = target.kind === "local" ? null : target.id;
    await this.db
      .update(componentInstances)
      .set({ runtimeNodeId: nextNodeId, updatedAt: new Date() })
      .where(
        and(eq(componentInstances.id, instanceId), eq(componentInstances.tenantId, tenantId)),
      );

    if (wasRunning) {
      await this.orchestrator.startInstance(tenantId, instanceId);
    }

    return { ok: true, runtimeNodeId: nextNodeId };
  }
}
