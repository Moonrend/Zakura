/**
 * 工作区文件必须走 Agent 所选 zakura-agent，不能回落到 Server 本机目录。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateRunnerToken, hashRunnerToken } from "@zakura/core";

describe("ServerWorkspaceFsProvider routing by runtime_node_id", () => {
  let dataDir: string;
  let agentId: string;
  let localAgentId: string;
  let nodeId: string;
  let tenantId: string;
  let provider: import("../src/services/workspace-fs-provider.js").ServerWorkspaceFsProvider;
  let db: import("../src/db/client.js").Db;
  let close: () => Promise<void>;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "zakura-fs-route-"));
    const pgliteDir = join(dataDir, "pglite");
    process.env.ZAKURA_DATA_DIR = dataDir;
    process.env.DATABASE_URL = `pglite:${pgliteDir}`;

    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(`pglite:${pgliteDir}`);

    const { createDb } = await import("../src/db/client.js");
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    (config as { dataDir: string }).dataDir = dataDir;

    const created = await createDb({
      databaseUrl: `pglite:${pgliteDir}`,
      dataDir,
    });
    db = created.db;
    close = created.close;

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
    nodeId = newId();
    await db.insert(runtimeNodes).values({
      id: nodeId,
      tenantId,
      name: "Remote Runner",
      slug: "remote-a",
      kind: "computer",
      status: "offline",
      endpoint: null,
      capabilitiesJson: JSON.stringify({ host: true, docker: true }),
      hostInfoJson: "{}",
      storageRoot: "/tmp/remote",
      tokenHash: hashRunnerToken(raw),
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
      enableComputer: true,
      enableMemory: false,
      runtimeNodeId: nodeId,
      workspaceStatus: "ready",
      configJson: "{}",
      createdAt: now,
      updatedAt: now,
    });

    localAgentId = newId();
    await db.insert(agents).values({
      id: localAgentId,
      tenantId,
      name: "Unbound Agent",
      slug: "unbound-agent",
      description: "",
      status: "ready",
      enableFs: true,
      enableComputer: false,
      enableMemory: false,
      runtimeNodeId: null,
      workspaceStatus: "ready",
      configJson: "{}",
      createdAt: now,
      updatedAt: now,
    });

    const { RuntimeNodeService } = await import("../src/services/runtime-nodes.js");
    const { ServerWorkspaceFsProvider } = await import("../src/services/workspace-fs-provider.js");
    const nodes = new RuntimeNodeService(db, config);
    provider = new ServerWorkspaceFsProvider(db, config, nodes);
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

  it("绑定节点离线时不写 Server 本机目录", async () => {
    const localWouldBe = join(dataDir, "agents", agentId, "workspace", "routed.txt");
    await assert.rejects(
      () => provider.forAgent(agentId, tenantId),
      /未在线|安装脚本|不存在/,
    );
    assert.equal(existsSync(localWouldBe), false);
  });

  it("未绑定节点不能回落到本机 dataDir", async () => {
    const localPath = join(dataDir, "agents", localAgentId, "workspace", "local-only.txt");
    await assert.rejects(() => provider.forAgent(localAgentId, tenantId), /未绑定|运行节点/);
    assert.equal(existsSync(localPath), false);
  });
});
