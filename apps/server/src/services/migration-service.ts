import { and, desc, eq } from "drizzle-orm";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  exportWorkspace,
  importWorkspace,
  mergeExcludePatterns,
} from "@zakura/core";
import { LOCAL_RUNTIME_NODE_ID } from "@zakura/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  agents,
  newId,
  runtimeNodes,
  workspaceMigrations,
  type WorkspaceMigration,
} from "../db/schema.js";
import { agentWorkspaceHostPath } from "./agent-workspace.js";
import { type RuntimeNodeService } from "./runtime-nodes.js";

export function mapMigration(row: WorkspaceMigration) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    agentId: row.agentId,
    sourceNodeId: row.sourceNodeId,
    targetNodeId: row.targetNodeId,
    status: row.status,
    phase: row.phase,
    progressPct: row.progressPct,
    message: row.message,
    archivePath: row.archivePath,
    archiveSize: row.archiveSize ? Number(row.archiveSize) : null,
    archiveSha256: row.archiveSha256,
    excludePatterns: JSON.parse(row.excludePatternsJson || "[]") as string[],
    sourceRetained: row.sourceRetained,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class MigrationService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly nodes: RuntimeNodeService,
  ) {
    mkdirSync(this.migrationDir(), { recursive: true });
  }

  migrationDir(): string {
    return this.config.migrationDir;
  }

  async listForAgent(tenantId: string, agentId: string): Promise<WorkspaceMigration[]> {
    return this.db.query.workspaceMigrations.findMany({
      where: and(
        eq(workspaceMigrations.tenantId, tenantId),
        eq(workspaceMigrations.agentId, agentId),
      ),
      orderBy: [desc(workspaceMigrations.createdAt)],
    });
  }

  async get(tenantId: string, jobId: string): Promise<WorkspaceMigration | null> {
    return (
      (await this.db.query.workspaceMigrations.findFirst({
        where: and(
          eq(workspaceMigrations.tenantId, tenantId),
          eq(workspaceMigrations.id, jobId),
        ),
      })) ?? null
    );
  }

  async start(
    tenantId: string,
    agentId: string,
    input: { targetNodeId: string; excludePatterns?: string[] },
  ): Promise<WorkspaceMigration> {
    const agent = await this.db.query.agents.findFirst({
      where: and(eq(agents.tenantId, tenantId), eq(agents.id, agentId)),
    });
    if (!agent) throw new Error("Agent not found");
    if (agent.workspaceStatus === "migrating" || agent.workspaceStatus === "locked") {
      throw new Error("Agent workspace is locked or already migrating");
    }

    const local = await this.nodes.ensureLocalNode(tenantId);
    const sourceNodeId = agent.runtimeNodeId ?? local.id;
    const targetNodeId = input.targetNodeId;

    if (sourceNodeId === targetNodeId) {
      throw new Error("Source and target runners are the same");
    }

    const target = await this.nodes.get(tenantId, targetNodeId);
    if (!target) throw new Error("Target node not found");

    const excludePatterns = mergeExcludePatterns(input.excludePatterns);
    const now = new Date();
    const id = newId();

    const [job] = await this.db
      .insert(workspaceMigrations)
      .values({
        id,
        tenantId,
        agentId,
        sourceNodeId,
        targetNodeId,
        status: "pending",
        phase: "pending",
        progressPct: 0,
        message: "Queued",
        excludePatternsJson: JSON.stringify(excludePatterns),
        sourceRetained: false,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await this.db
      .update(agents)
      .set({ workspaceStatus: "migrating", lastMigrationId: id, updatedAt: now })
      .where(eq(agents.id, agentId));

    // Run async without blocking (catch failures into job row)
    void this.runJob(job!).catch(async (err) => {
      console.error("[migration] job failed", id, err);
    });

    return job!;
  }

  private async updateJob(
    id: string,
    patch: Partial<{
      status: string;
      phase: string;
      progressPct: number;
      message: string;
      manifestJson: string;
      archivePath: string;
      archiveSize: string;
      archiveSha256: string;
      sourceRetained: boolean;
      error: string | null;
      completedAt: Date;
    }>,
  ) {
    await this.db
      .update(workspaceMigrations)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(workspaceMigrations.id, id));
  }

  private isLocalNode(nodeId: string, kind?: string | null): boolean {
    return nodeId === LOCAL_RUNTIME_NODE_ID || kind === "local";
  }

  private async exportFromNode(
    node: { id: string; kind: string; endpoint: string | null; tenantId?: string },
    agentId: string,
    excludePatterns: string[],
    tenantId: string,
  ): Promise<{ archive: Buffer; manifest: unknown; archiveSha256: string }> {
    if (this.isLocalNode(node.id, node.kind)) {
      const root = agentWorkspaceHostPath(this.config, agentId);
      return exportWorkspace({
        agentId,
        sourceNodeId: node.id,
        workspaceRoot: root,
        excludePatterns,
      });
    }
    // Remote source: require online runner — never invent local path
    const { client } = await this.nodes.requireRunnerClient(tenantId, node.id);
    return client.exportMigration(agentId, {
      sourceNodeId: node.id,
      excludePatterns,
    });
  }

  private async importToNode(
    node: { id: string; kind: string; endpoint: string | null },
    agentId: string,
    archive: Buffer,
    archiveSha256: string,
    tenantId: string,
  ): Promise<void> {
    if (this.isLocalNode(node.id, node.kind)) {
      const root = agentWorkspaceHostPath(this.config, agentId);
      await importWorkspace({
        archive,
        targetWorkspaceRoot: root,
        atomic: true,
        expectedSha256: archiveSha256,
      });
      return;
    }
    const { client } = await this.nodes.requireRunnerClient(tenantId, node.id);
    await client.importMigration(agentId, archive, {
      expectedSha256: archiveSha256,
      atomic: true,
    });
  }

  async runJob(job: WorkspaceMigration): Promise<void> {
    const agent = await this.db.query.agents.findFirst({
      where: eq(agents.id, job.agentId),
    });
    if (!agent) {
      await this.updateJob(job.id, { status: "failed", error: "Agent missing", completedAt: new Date() });
      return;
    }

    const source = await this.db.query.runtimeNodes.findFirst({
      where: eq(runtimeNodes.id, job.sourceNodeId),
    });
    const target = await this.db.query.runtimeNodes.findFirst({
      where: eq(runtimeNodes.id, job.targetNodeId),
    });
    if (!source || !target) {
      await this.fail(job, agent.id, "Source or target node missing");
      return;
    }

    const excludePatterns = JSON.parse(job.excludePatternsJson || "[]") as string[];

    try {
      await this.updateJob(job.id, {
        status: "exporting",
        phase: "exporting",
        progressPct: 10,
        message: "Exporting workspace",
      });

      const { archive, manifest, archiveSha256 } = await this.exportFromNode(
        source,
        agent.id,
        excludePatterns,
        job.tenantId,
      );

      const archivePath = join(this.migrationDir(), `${job.id}.tar.zst`);
      writeFileSync(archivePath, archive);

      await this.updateJob(job.id, {
        status: "transferring",
        phase: "transferring",
        progressPct: 40,
        message: "Archive stored on server",
        archivePath,
        archiveSize: String(archive.length),
        archiveSha256,
        manifestJson: JSON.stringify(manifest),
      });

      await this.updateJob(job.id, {
        status: "importing",
        phase: "importing",
        progressPct: 60,
        message: "Importing on target",
      });

      await this.importToNode(target, agent.id, archive, archiveSha256, job.tenantId);

      await this.updateJob(job.id, {
        status: "verifying",
        phase: "verifying",
        progressPct: 85,
        message: "Updating binding",
      });

      const now = new Date();
      await this.db
        .update(agents)
        .set({
          runtimeNodeId: target.kind === "local" ? null : target.id,
          workspaceStatus: "ready",
          workspaceRevision: archiveSha256,
          lastMigrationId: job.id,
          updatedAt: now,
        })
        .where(eq(agents.id, agent.id));

      // Source retained — do not delete source workspace
      await this.updateJob(job.id, {
        status: "completed",
        phase: "completed",
        progressPct: 100,
        message: "Migration completed; source workspace retained",
        sourceRetained: true,
        completedAt: now,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.fail(job, agent.id, message);
    }
  }

  private async fail(job: WorkspaceMigration, agentId: string, message: string) {
    const now = new Date();
    await this.updateJob(job.id, {
      status: "failed",
      phase: "failed",
      message: "Failed",
      error: message,
      completedAt: now,
    });
    await this.db
      .update(agents)
      .set({ workspaceStatus: "ready", updatedAt: now })
      .where(eq(agents.id, agentId));
  }

  /**
   * Direct local-to-local (or path-to-path) migration used by tests —
   * drives the same exportWorkspace / importWorkspace shipped functions.
   */
  async runLocalPathMigration(opts: {
    agentId: string;
    sourceRoot: string;
    targetRoot: string;
    sourceNodeId: string;
    targetNodeId: string;
    excludePatterns?: string[];
  }): Promise<{
    archiveSha256: string;
    archivePath: string;
    fileCount: number;
    sourceRetained: boolean;
  }> {
    const excludePatterns = mergeExcludePatterns(opts.excludePatterns);
    const { archive, manifest, archiveSha256 } = await exportWorkspace({
      agentId: opts.agentId,
      sourceNodeId: opts.sourceNodeId,
      workspaceRoot: opts.sourceRoot,
      excludePatterns,
    });
    const archivePath = join(this.migrationDir(), `test-${Date.now()}.tar.zst`);
    mkdirSync(this.migrationDir(), { recursive: true });
    writeFileSync(archivePath, archive);

    // Source must still exist after export
    if (!existsSync(opts.sourceRoot)) {
      throw new Error("Source root missing after export");
    }

    await importWorkspace({
      archive,
      targetWorkspaceRoot: opts.targetRoot,
      atomic: true,
      expectedSha256: archiveSha256,
    });

    return {
      archiveSha256,
      archivePath,
      fileCount: manifest.fileCount,
      sourceRetained: true,
    };
  }
}
