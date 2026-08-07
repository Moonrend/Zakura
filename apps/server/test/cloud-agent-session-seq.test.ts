/**
 * Concurrent appendEvent must allocate unique (session_id, seq) under parallel writers.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRATCH =
  process.env.GROK_SCRATCH || join(tmpdir(), "grok-cloud-session-seq");

describe("CloudAgentSessionStore.appendEvent concurrency", () => {
  let dataDir: string;
  let db: import("../src/db/client.js").Db;
  let close: () => Promise<void>;
  let store: import("../src/services/cloud-agent-session.js").CloudAgentSessionStore;
  let tenantId: string;
  let agentId: string;
  let sessionId: string;

  before(async () => {
    process.env.REDIS_URL = "off";
    mkdirSync(SCRATCH, { recursive: true });
    dataDir = mkdtempSync(join(SCRATCH, "data-"));
    const pgliteDir = join(dataDir, "pglite");
    process.env.ZAKURA_DATA_DIR = dataDir;
    process.env.DATABASE_URL = `pglite:${pgliteDir}`;

    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(`pglite:${pgliteDir}`);

    const { createDb } = await import("../src/db/client.js");
    const created = await createDb({ databaseUrl: `pglite:${pgliteDir}`, dataDir });
    db = created.db;
    close = created.close;

    const { tenants, agents, newId } = await import("../src/db/schema.js");
    const now = new Date();
    tenantId = newId();
    agentId = newId();
    await db.insert(tenants).values({
      id: tenantId,
      name: "t",
      slug: `t-${tenantId.slice(0, 8)}`,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agents).values({
      id: agentId,
      tenantId,
      name: "a",
      slug: `a-${agentId.slice(0, 8)}`,
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

    const { CloudAgentSessionStore } = await import(
      "../src/services/cloud-agent-session.js"
    );
    store = new CloudAgentSessionStore(db);
    const session = await store.createSession({
      tenantId,
      agentId,
      title: "seq race",
    });
    sessionId = session.id;
  });

  after(async () => {
    await close?.();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("parallel appendEvent gets unique monotonic seq", async () => {
    const N = 40;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.appendEvent({
          sessionId,
          type: "run_log",
          runId: "run_parallel",
          payload: {
            runId: "run_parallel",
            level: "info",
            message: `log-${i}`,
          },
        }),
      ),
    );

    const seqs = results.map((e) => e.seq).sort((a, b) => a - b);
    assert.equal(seqs.length, N);
    assert.equal(new Set(seqs).size, N, "seq must be unique");
    assert.equal(seqs[0], 1);
    assert.equal(seqs[N - 1], N);

    const session = await store.getSession(tenantId, agentId, sessionId);
    assert.equal(session?.lastSeq, N);

    const events = await store.listEvents(sessionId, { limit: 2000 });
    assert.equal(events.length, N);
  });

  it("parallel createRun allows only one active run per session", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => store.createRun(sessionId)),
    );
    const created = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof store.createRun>>> =>
        r.status === "fulfilled",
    );
    assert.equal(created.length, 1);
    const session = await store.getSession(tenantId, agentId, sessionId);
    assert.equal(session?.activeRunId, created[0]!.value.id);
  });
});
