/**
 * MCP/component 实例跨 Runner 迁移：stop → export 数据卷 → import → 更新 runtime_node_id → start
 */
import { and, eq } from "drizzle-orm";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

    if (!instance.runtimeNodeId) {
      throw new Error("该实例未绑定运行节点，请先选择一台在线的 zakura-agent");
    }
    if (targetNodeId === "local" || !targetNodeId) {
      throw new Error("目标必须是在线的电脑或服务器，不再支持隐式本机节点");
    }
    const sourceId = instance.runtimeNodeId;
    const targetId = targetNodeId;
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

    if (isLocalNodeId(sourceId) || target.kind === "local" || isLocalNodeId(targetId)) {
      throw new Error("旧本机节点已停用。请在两端都安装 zakura-agent 后再迁移。");
    }
    const { client: src } = await this.nodes.requireRunnerClient(tenantId, sourceId);
    const { archive } = await src.exportInstanceMigration(instanceId, {
      sourceNodeId: sourceId,
    });
    writeFileSync(archivePath, archive);

    const { client: dst } = await this.nodes.requireRunnerClient(tenantId, targetId);
    await dst.importInstanceMigration(instanceId, archive);

    const nextNodeId = target.id;
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
