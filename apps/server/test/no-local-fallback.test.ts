/**
 * Regression: remote-bound agents must NEVER fall back to Server local Docker / local FS
 * when the Runner is offline or unreachable.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateRunnerToken, hashRunnerToken } from "@zakura/core";
import { eq } from "drizzle-orm";

describe("no silent local fallback when Runner offline", () => {
  let dataDir: string;
  let db: import("../src/db/client.js").Db;
  let config: import("../src/config.js").AppConfig;
  let close: () => Promise<void>;
  let tenantId: string;
  let agentId: string;
  let nodeId: string;
  let provider: import("../src/services/workspace-fs-provider.js").ServerWorkspaceFsProvider;
  let workspace: import("../src/services/agent-workspace.js").AgentWorkspaceService;
  let agentService: import("../src/services/agents.js").AgentService;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "zakura-nofallback-"));
    const pgliteDir = join(dataDir, "pglite");
    process.env.ZAKURA_DATA_DIR = dataDir;
    process.env.DATABASE_URL = `pglite:${pgliteDir}`;

    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(`pglite:${pgliteDir}`);

    const { createDb } = await import("../src/db/client.js");
    const { loadConfig } = await import("../src/config.js");
    config = loadConfig();
    (config as { dataDir: string }).dataDir = dataDir;

    const created = await createDb({
      databaseUrl: `pglite:${pgliteDir}`,
      dataDir,
    });
    db = created.db;
    close = created.close;

    const { tenants, agents, runtimeNodes, newId } = await import("../src/db/schema.js");
    const now = new Date();
    tenantId = newId();
    await db.insert(tenants).values({
      id: tenantId,
      slug: "t-nofallback",
      name: "T",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });

    const { raw } = generateRunnerToken();
    nodeId = newId();
    // Offline remote node with no endpoint (never registered / went offline)
    await db.insert(runtimeNodes).values({
      id: nodeId,
      tenantId,
      name: "Offline Runner",
      slug: "offline-r",
      kind: "runner",
      status: "offline",
      endpoint: null,
      capabilitiesJson: "{}",
      hostInfoJson: "{}",
      storageRoot: "/var/lib/zakura",
      tokenHash: hashRunnerToken(raw),
      labelsJson: "{}",
      lastSeenAt: null,
      createdAt: now,
      updatedAt: now,
    });

    agentId = newId();
    await db.insert(agents).values({
      id: agentId,
      tenantId,
      name: "Remote Bound",
      slug: "remote-bound",
      description: "",
      status: "ready",
      enableFs: true,
      enableShell: true,
      enableComputer: true,
      enableBrowser: true,
      enableMemory: false,
      runtimeNodeId: nodeId,
      workspaceStatus: "ready",
      configJson: "{}",
      createdAt: now,
      updatedAt: now,
    });

    const { RuntimeNodeService } = await import("../src/services/runtime-nodes.js");
    const { ServerWorkspaceFsProvider } = await import(
      "../src/services/workspace-fs-provider.js"
    );
    const { DockerRuntime } = await import("../src/runtime/docker.js");
    const { AgentService } = await import("../src/services/agents.js");

    const nodes = new RuntimeNodeService(db, config);
    provider = new ServerWorkspaceFsProvider(db, config, nodes);
    agentService = new AgentService(db, new DockerRuntime(), config, nodes);
    workspace = agentService.workspace;
  });

  after(async () => {
    try {
      await close?.();
    } catch {
      /* ignore */
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("WorkspaceFsProvider throws for offline remote (no local root)", async () => {
    const localPath = join(dataDir, "agents", agentId, "workspace");
    await assert.rejects(
      () => provider.forAgent(agentId, tenantId),
      /离线|注册|不存在|鉴权|无法连接/i,
    );
    assert.equal(
      existsSync(localPath),
      false,
      "must not create local workspace dir for remote-bound agent",
    );
  });

  it("workspace.start throws and does not start local docker for offline remote", async () => {
    const agent = await agentService.get(tenantId, agentId);
    assert.ok(agent);
    assert.equal(agent!.runtimeNodeId, nodeId);

    await assert.rejects(() => workspace.start(agent!), /离线|注册|不存在|鉴权|无法连接/i);

    const localPath = join(dataDir, "agents", agentId, "workspace");
    // ensureLocal must not have been used as a successful fallback path
    // (dir might exist from partial work — but managed container on local must not run)
    const { managedContainers } = await import("../src/db/schema.js");
    const rows = await db
      .select()
      .from(managedContainers)
      .where(eq(managedContainers.agentId, agentId));
    const active = rows.filter((r) => r.status !== "removed" && r.dockerId);
    assert.equal(active.length, 0, "no local managed container after failed remote start");
    void localPath;
  });

  it("startAsync rejects binding to offline runner", async () => {
    await assert.rejects(
      () =>
        agentService.startAsync(tenantId, agentId, {
          runtimeNodeId: nodeId,
        }),
      /离线/,
    );
  });
});
