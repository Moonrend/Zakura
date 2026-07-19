/**
 * Criterion 2: ServerWorkspaceFsProvider routes by agents.runtime_node_id.
 * Drives the real forAgent() + callAgentNativeTool shipped paths against a live Runner.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateRunnerToken, hashRunnerToken } from "@zakura/core";
import { eq } from "drizzle-orm";

const SCRATCH =
  process.env.GROK_SCRATCH ||
  join(tmpdir(), "grok-goal-workspace-fs-routing");

describe("ServerWorkspaceFsProvider routing by runtime_node_id", () => {
  let cleanup: (() => Promise<void>)[] = [];
  let dataDir: string;
  let remoteStorage: string;
  let runnerPort: number;
  let token: string;
  let agentId: string;
  let nodeId: string;
  let tenantId: string;
  let provider: import("../src/services/workspace-fs-provider.js").ServerWorkspaceFsProvider;
  let agentService: import("../src/services/agents.js").AgentService;
  let db: import("../src/db/client.js").Db;
  let config: import("../src/config.js").AppConfig;

  before(async () => {
    mkdirSync(SCRATCH, { recursive: true });
    dataDir = mkdtempSync(join(SCRATCH, "data-"));
    remoteStorage = mkdtempSync(join(SCRATCH, "remote-"));
    const pgliteDir = join(dataDir, "pglite");

    process.env.ZAKURA_DATA_DIR = dataDir;
    process.env.DATABASE_URL = `pglite:${pgliteDir}`;

    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(`pglite:${pgliteDir}`);

    const { createDb } = await import("../src/db/client.js");
    const { loadConfig } = await import("../src/config.js");
    config = loadConfig();
    // Force dataDir used by config resolution
    (config as { dataDir: string }).dataDir = dataDir;
    (config as { migrationDir: string }).migrationDir = join(dataDir, "migrations");

    const created = await createDb({
      databaseUrl: `pglite:${pgliteDir}`,
      dataDir,
    });
    db = created.db;

    const { tenants, users, agents, runtimeNodes, newId } = await import("../src/db/schema.js");
    const now = new Date();
    tenantId = newId();
    await db.insert(tenants).values({
      id: tenantId,
      slug: "test-tenant",
      name: "Test",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(users).values({
      id: newId(),
      email: "test@example.com",
      name: "Test",
      passwordHash: "x",
      isPlatformAdmin: false,
      createdAt: now,
      updatedAt: now,
    });

    const { raw } = generateRunnerToken();
    token = raw;
    nodeId = newId();
    await db.insert(runtimeNodes).values({
      id: nodeId,
      tenantId,
      name: "Remote Runner",
      slug: "remote-a",
      kind: "runner",
      status: "online",
      endpoint: null, // set after start
      capabilitiesJson: JSON.stringify({ docker: true }),
      hostInfoJson: "{}",
      storageRoot: remoteStorage,
      tokenHash: hashRunnerToken(token),
      labelsJson: "{}",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });

    agentId = newId();
    await db.insert(agents).values({
      id: agentId,
      tenantId,
      name: "Remote Agent",
      slug: "remote-agent",
      description: "",
      status: "ready",
      workspaceProfile: "computer",
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

    // Launch real Runner process
    const { startRunner } = await import("../../runner/src/index.js");
    runnerPort = 19000 + Math.floor(Math.random() * 500);
    const handle = await startRunner({
      port: runnerPort,
      host: "127.0.0.1",
      storageRoot: remoteStorage,
      token,
    });
    cleanup.push(() => handle.close());

    // Point node endpoint + cache token (same as register path)
    await db
      .update(runtimeNodes)
      .set({
        endpoint: `http://127.0.0.1:${runnerPort}`,
        status: "online",
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(runtimeNodes.id, nodeId));

    const { cacheRunnerToken } = await import("../src/services/runtime-nodes.js");
    cacheRunnerToken(nodeId, token);

    const { RuntimeNodeService } = await import("../src/services/runtime-nodes.js");
    const { ServerWorkspaceFsProvider } = await import(
      "../src/services/workspace-fs-provider.js"
    );
    const { DockerRuntime } = await import("../src/runtime/docker.js");
    const { AgentService } = await import("../src/services/agents.js");

    const nodes = new RuntimeNodeService(db, config);
    provider = new ServerWorkspaceFsProvider(db, config, nodes);
    agentService = new AgentService(db, new DockerRuntime(), config);
  });

  after(async () => {
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(remoteStorage, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("forAgent routes writes to remote runner storage, not local ensureLocal path", async () => {
    const localWouldBe = join(dataDir, "agents", agentId, "workspace", "routed.txt");
    const remotePath = join(remoteStorage, "agents", agentId, "workspace", "routed.txt");

    // Ensure local path does not already hold the file
    if (existsSync(localWouldBe)) {
      rmSync(localWouldBe, { force: true });
    }

    const fs = await provider.forAgent(agentId, tenantId);
    await fs.writeText("/routed.txt", "via-provider-remote");

    assert.equal(
      existsSync(remotePath),
      true,
      `expected file on remote storage: ${remotePath}`,
    );
    assert.equal(readFileSync(remotePath, "utf8"), "via-provider-remote");
    assert.equal(
      existsSync(localWouldBe),
      false,
      `must NOT write to local ensureLocal path: ${localWouldBe}`,
    );

    const readBack = await fs.readText("/routed.txt");
    assert.equal(readBack.content, "via-provider-remote");
  });

  it("callAgentNativeTool fs_write uses provider (remote), not local disk", async () => {
    const { callAgentNativeTool } = await import("../src/services/agent-tools.js");
    const agent = await agentService.get(tenantId, agentId);
    assert.ok(agent);
    assert.equal(agent!.runtimeNodeId, nodeId);

    const localWouldBe = join(dataDir, "agents", agentId, "workspace", "tool-write.txt");
    const remotePath = join(remoteStorage, "agents", agentId, "workspace", "tool-write.txt");

    const result = await callAgentNativeTool(
      agent!,
      agentService.workspace,
      "fs_write",
      { path: "tool-write.txt", content: "from-mcp-tool" },
      null,
      null,
      null,
      provider,
    );
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    assert.ok(
      text.includes("tool-write") || text.includes("bytes") || text.includes("path"),
      `unexpected tool result: ${text}`,
    );

    assert.equal(existsSync(remotePath), true, `remote tool write missing: ${remotePath}`);
    assert.equal(readFileSync(remotePath, "utf8"), "from-mcp-tool");
    assert.equal(existsSync(localWouldBe), false, `local path must stay empty: ${localWouldBe}`);
  });

  it("null runtime_node_id still uses local dataDir (today path)", async () => {
    const { agents, newId } = await import("../src/db/schema.js");
    const localAgentId = newId();
    const now = new Date();
    await db.insert(agents).values({
      id: localAgentId,
      tenantId,
      name: "Local Agent",
      slug: "local-agent",
      description: "",
      status: "ready",
      enableFs: true,
      enableShell: false,
      enableComputer: false,
      enableBrowser: false,
      enableMemory: false,
      runtimeNodeId: null,
      workspaceStatus: "ready",
      configJson: "{}",
      createdAt: now,
      updatedAt: now,
    });

    const fs = await provider.forAgent(localAgentId, tenantId);
    await fs.writeText("/local-only.txt", "local-path");
    const localPath = join(dataDir, "agents", localAgentId, "workspace", "local-only.txt");
    assert.equal(existsSync(localPath), true);
    assert.equal(readFileSync(localPath, "utf8"), "local-path");
    // Must not appear under remote runner storage
    assert.equal(
      existsSync(join(remoteStorage, "agents", localAgentId, "workspace", "local-only.txt")),
      false,
    );
  });
});
