/**
 * FileShareService: create temporary public URLs for workspace files.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRATCH =
  process.env.GROK_SCRATCH || join(tmpdir(), "grok-file-shares");

describe("FileShareService", () => {
  let dataDir: string;
  let db: import("../src/db/client.js").Db;
  let close: () => Promise<void>;
  let config: import("../src/config.js").AppConfig;
  let fileShares: import("../src/services/file-shares.js").FileShareService;
  let tenantId: string;
  let agentId: string;
  let workspaceRoot: string;
  let fs: import("@zakura/core").WorkspaceFs;

  before(async () => {
    mkdirSync(SCRATCH, { recursive: true });
    dataDir = mkdtempSync(join(SCRATCH, "data-"));
    const pgliteDir = join(dataDir, "pglite");
    process.env.ZAKURA_DATA_DIR = dataDir;
    process.env.DATABASE_URL = `pglite:${pgliteDir}`;
    process.env.ZAKURA_PUBLIC_URL = "http://share.test:8787";

    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(`pglite:${pgliteDir}`);

    const { createDb } = await import("../src/db/client.js");
    const { loadConfig } = await import("../src/config.js");
    config = loadConfig();
    (config as { dataDir: string }).dataDir = dataDir;
    (config as { publicBaseUrl: string }).publicBaseUrl = "http://share.test:8787";

    const created = await createDb({ databaseUrl: `pglite:${pgliteDir}`, dataDir });
    db = created.db;
    close = created.close;

    const { tenants, agents, newId } = await import("../src/db/schema.js");
    const now = new Date();
    tenantId = newId();
    agentId = newId();
    await db.insert(tenants).values({
      id: tenantId,
      slug: "fs-tenant",
      name: "FS",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agents).values({
      id: agentId,
      tenantId,
      name: "Share Agent",
      slug: "share-agent",
      description: "",
      status: "ready",
      enableFs: true,
      enableComputer: true,
      enableMemory: false,
      runtimeNodeId: null,
      workspaceStatus: "ready",
      configJson: "{}",
      createdAt: now,
      updatedAt: now,
    });

    workspaceRoot = join(dataDir, "agents", agentId, "workspace");
    mkdirSync(join(workspaceRoot, "uploads"), { recursive: true });
    writeFileSync(join(workspaceRoot, "uploads", "hello.txt"), "hello cloud url");

    const { LocalWorkspaceFs } = await import("@zakura/core");
    fs = new LocalWorkspaceFs(workspaceRoot);

    const { FileShareService } = await import("../src/services/file-shares.js");
    fileShares = new FileShareService(db, config);
  });

  after(async () => {
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("get_file_url creates a public download URL", async () => {
    const share = await fileShares.create(tenantId, agentId, fs, {
      path: "/uploads/hello.txt",
      ttlMinutes: 30,
    });
    assert.ok(share.url.startsWith("http://share.test:8787/api/files/shared/fsh_"));
    assert.equal(share.fileName, "hello.txt");
    assert.equal(share.status, "active");
    assert.ok(share.sizeBytes && share.sizeBytes > 0);

    const token = share.url.split("/").pop()!;
    const resolved = await fileShares.resolveByToken(token);
    assert.ok(resolved);
    assert.equal(resolved!.path, "/uploads/hello.txt");
  });

  it("callAgentNativeTool get_file_url returns url JSON", async () => {
    const { callAgentNativeTool } = await import("../src/services/agent-tools.js");
    const { AgentWorkspaceService } = await import("../src/services/agent-workspace.js");
    const { DockerRuntime } = await import("../src/runtime/docker.js");
    const { eq } = await import("drizzle-orm");
    const { agents } = await import("../src/db/schema.js");
    const workspace = new AgentWorkspaceService(db, new DockerRuntime(), config);
    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, agentId),
    });
    assert.ok(agent);

    const { LocalWorkspaceFs } = await import("@zakura/core");
    const provider = {
      forAgent: async () => new LocalWorkspaceFs(workspaceRoot),
      forAgentBinding: async () => new LocalWorkspaceFs(workspaceRoot),
    };

    const result = await callAgentNativeTool(
      agent!,
      workspace,
      "get_file_url",
      { path: "/uploads/hello.txt", ttl_minutes: 15, disposition: "inline" },
      null,
      null,
      null,
      provider,
      null,
      fileShares,
    );
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    const parsed = JSON.parse(text) as { url: string; share_id: string; disposition: string };
    assert.ok(parsed.url.includes("/api/files/shared/fsh_"));
    assert.ok(parsed.share_id);
    assert.equal(parsed.disposition, "inline");

    const revoked = await callAgentNativeTool(
      agent!,
      workspace,
      "revoke_file_url",
      { share_id: parsed.share_id },
      null,
      null,
      null,
      provider,
      null,
      fileShares,
    );
    assert.notEqual(revoked.isError, true, JSON.stringify(revoked));
    const token = parsed.url.split("/").pop()!;
    assert.equal(await fileShares.resolveByToken(token), null);
  });
});
