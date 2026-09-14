import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { ShellJob, type CreateContainerOptions, type RunningContainer } from "@zakura/core";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { agents, runtimeNodes, tenants, users } from "../src/db/schema.js";
import type { AppConfig } from "../src/config.js";
import type { DockerRuntime } from "../src/runtime/docker.js";
import { RuntimeNodeService, mapRuntimeNode } from "../src/services/runtime-nodes.js";
import { AgentService } from "../src/services/agents.js";
import { ServerWorkspaceFsProvider } from "../src/services/workspace-fs-provider.js";
import { registerRuntimeNodeRoutes } from "../src/api/runtime-node-routes.js";
import { MigrationService } from "../src/services/migration-service.js";
import { registerMigrationRoutes } from "../src/api/migration-routes.js";

class TestDocker {
  readonly containers = new Map<string, RunningContainer>();
  readonly created: CreateContainerOptions[] = [];
  readonly execs: string[] = [];
  readonly pulled: string[] = [];
  readonly attached: string[] = [];
  readonly stdin: Buffer[] = [];
  available = true;
  async ping() { return this.available ? { ok: true, version: "test" } : { ok: false, error: "Docker unavailable" }; }
  async ensureImage() {}
  async ensureNetwork() {}
  async checkImageUpdates(images: string[]) {
    return images.map((image) => ({ image, localId: this.pulled.includes(image) ? "sha256:test" : null }));
  }
  async pullImage(image: string, progress?: (line: string) => void) {
    this.pulled.push(image);
    progress?.(`Pulled ${image}`);
  }
  async createAndStart(options: CreateContainerOptions): Promise<RunningContainer> {
    this.created.push(options);
    const row: RunningContainer = {
      id: `docker-${this.created.length}`, name: options.spec.name, image: options.spec.image,
      status: "running", ports: [{ containerPort: 6080, hostPort: 16080 }],
      labels: { "zakura.managed": "true", "zakura.tenant": options.tenantId, "zakura.purpose": options.purpose, ...options.spec.labels },
    };
    this.containers.set(row.id, row);
    return row;
  }
  async list(filters?: { tenantId?: string; purpose?: string }) {
    return [...this.containers.values()].filter((row) =>
      (!filters?.tenantId || row.labels["zakura.tenant"] === filters.tenantId)
      && (!filters?.purpose || row.labels["zakura.purpose"] === filters.purpose));
  }
  async inspect(id: string) { return this.containers.get(id) ?? [...this.containers.values()].find((row) => row.name === id) ?? null; }
  async stop(id: string) { const row = await this.inspect(id); if (row) row.status = "exited"; }
  async remove(id: string) { const row = await this.inspect(id); if (row) this.containers.delete(row.id); }
  async exec(id: string) { this.execs.push(id); return { stdout: "local execution", stderr: "", exitCode: 0 }; }
  async execJob(id: string, _command: string[], opts: { agentId: string }) {
    this.execs.push(id);
    const job = new ShellJob({ agentId: opts.agentId });
    job.append("stdout", "local shell");
    job.finish(0);
    return job;
  }
  async attachStdio(id: string) {
    this.attached.push(id);
    return {
      toWebStreams: () => ({
        writable: new WritableStream<Uint8Array>({ write: (chunk) => { this.stdin.push(Buffer.from(chunk)); } }),
        readable: new ReadableStream<Uint8Array>({ start: (controller) => { controller.enqueue(Buffer.from("local rpc\n")); controller.close(); } }),
      }),
      kill: async () => {},
      onStderr: () => () => {},
    };
  }
}

describe("explicit Local Runner", () => {
  let dir: string;
  let db: Db;
  let closeDb: () => Promise<void>;
  let config: AppConfig;
  let nodes: RuntimeNodeService;
  let agentService: AgentService;
  let fsProvider: ServerWorkspaceFsProvider;
  const docker = new TestDocker();
  let sequence = 0;

  before(async () => {
    process.env.REDIS_URL = "off";
    dir = mkdtempSync(join(tmpdir(), "zakura-local-runner-"));
    const databaseUrl = `pglite:${join(dir, "db")}`;
    await runMigrations(databaseUrl);
    const handle = await createDb({ databaseUrl, dataDir: dir });
    db = handle.db;
    closeDb = handle.close;
    config = { dataDir: dir, hostDataDir: "/host/zakura", migrationDir: join(dir, "migrations"), secret: "local-runner-test", multiTenant: true, runnerHeartbeatTimeoutSec: 60 } as AppConfig;
    await db.insert(tenants).values([
      { id: "selfhost", name: "Selfhost", slug: "selfhost" },
      { id: "saas", name: "SaaS", slug: "saas" },
      { id: "other", name: "Other", slug: "other" },
      { id: "legacy", name: "Legacy", slug: "legacy" },
      { id: "named", name: "Named", slug: "named" },
      { id: "upgrade", name: "Upgrade", slug: "upgrade" },
    ]);
    await db.insert(users).values([
      { id: "admin", email: "admin@example.com", name: "Admin", passwordHash: "test", isPlatformAdmin: true },
      { id: "allowed", email: "allowed@example.com", name: "Allowed", passwordHash: "test", canUseLocalRunner: true },
      { id: "denied", email: "denied@example.com", name: "Denied", passwordHash: "test" },
    ]);
    nodes = new RuntimeNodeService(db, config, docker as unknown as DockerRuntime);
    agentService = new AgentService(db, docker as unknown as DockerRuntime, config, nodes);
    fsProvider = new ServerWorkspaceFsProvider(db, config, nodes);
  });

  after(async () => {
    await closeDb?.();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function appFor(tenantId: string, userId: string, multiTenant = true) {
    const app = new Hono<any>();
    app.use("*", async (c, next) => {
      c.set("session", { tenantId, userId });
      await next();
    });
    registerRuntimeNodeRoutes(app, { nodes, db, config: { ...config, multiTenant } });
    return app;
  }

  async function newAgent(tenantId = "saas") {
    const [agent] = await db.insert(agents).values({ tenantId, name: "Local Agent", slug: `agent-${++sequence}` }).returning();
    return agent;
  }

  it("offers a usable Local Runner on self-hosted installations without a Go session", async () => {
    const app = appFor("selfhost", "api-key", false);
    const response = await app.request("/api/runtime-nodes");
    assert.equal(response.status, 200);
    const body = await response.json() as { canUseLocalRunner: boolean; nodes: Array<{ id: string; kind: string; status: string; needsReinstall: boolean }> };
    assert.equal(body.canUseLocalRunner, true);
    const node = body.nodes.find((row) => row.kind === "local");
    assert.ok(node);
    assert.equal(node.status, "online");
    assert.equal(node.needsReinstall, false);
    await nodes.refreshOfflineStatuses(0, "selfhost");
    assert.equal((await nodes.get("selfhost", node.id))?.status, "online");
    assert.equal((await app.request(`/api/runtime-nodes/${node.id}/detail`)).status, 200);
  });

  it("creates one tenant-scoped local node and repairs the old computer/slug=local record", async () => {
    await db.insert(runtimeNodes).values({ id: "old-local", tenantId: "legacy", name: "本机", slug: "local", kind: "computer", status: "offline", storageRoot: dir });
    const [first, second] = await Promise.all([nodes.ensureLocalNode("legacy"), nodes.ensureLocalNode("legacy")]);
    assert.equal(first.id, "old-local");
    assert.equal(second.id, first.id);
    assert.equal(first.kind, "local");
    assert.equal(mapRuntimeNode(first).needsReinstall, false);
    const stored = await db.query.runtimeNodes.findFirst({ where: eq(runtimeNodes.id, first.id) });
    assert.equal(mapRuntimeNode(stored!).status, "online");
    assert.equal((await nodes.getAccessible("legacy", first.id))?.status, "online");
    const [other, concurrent] = await Promise.all([nodes.ensureLocalNode("other"), nodes.ensureLocalNode("other")]);
    assert.equal(concurrent.id, other.id);
    assert.notEqual(other.id, first.id);
    assert.equal(await nodes.getAccessible("legacy", other.id), null);
  });

  it("preserves SaaS grants, including direct node endpoints and binding attempts", async () => {
    const local = await nodes.ensureLocalNode("saas");
    for (const userId of ["allowed", "admin", "denied", "api-key"]) {
      const allowed = userId === "allowed" || userId === "admin";
      const app = appFor("saas", userId);
      const response = await app.request("/api/runtime-nodes");
      const body = await response.json() as { nodes: Array<{ id: string }>; canUseLocalRunner: boolean };
      assert.equal(body.canUseLocalRunner, allowed);
      assert.equal(body.nodes.some((row) => row.id === local.id), allowed);
      for (const suffix of ["", "/detail", "/containers", "/image-updates"]) {
        const result = await app.request(`/api/runtime-nodes/${local.id}${suffix}`);
        if (!allowed) assert.equal(result.status, 403, `${userId}: ${suffix}`);
      }
      const agent = await newAgent();
      if (allowed) {
        const bound = await agentService.update("saas", agent.id, { runtimeNodeId: local.id, userId });
        assert.equal(bound.runtimeNodeId, local.id);
      } else {
        await assert.rejects(agentService.update("saas", agent.id, { runtimeNodeId: local.id, userId }), { status: 403 });
        await assert.rejects(agentService.startAsync("saas", agent.id, { runtimeNodeId: "local", userId }), { status: 403 });
        assert.equal((await db.query.agents.findFirst({ where: eq(agents.id, agent.id) }))?.runtimeNodeId, null);
      }
    }
  });

  it("binds the local alias, reads/writes local files, and starts/executes/stops local Docker", async () => {
    const agent = await newAgent();
    const bound = await agentService.update("saas", agent.id, { runtimeNodeId: "local", userId: "allowed" });
    assert.ok(bound.runtimeNodeId);
    assert.notEqual(bound.runtimeNodeId, "local");
    const fs = await fsProvider.forAgent(agent.id, "saas");
    await fs.writeText("/outputs/local.txt", "本地文件");
    assert.equal(readFileSync(join(dir, "agents", agent.id, "workspace/outputs/local.txt"), "utf8"), "本地文件");
    assert.equal((await fs.readText("/outputs/local.txt")).content, "本地文件");
    await assert.rejects(fs.writeText("../../escape.txt", "no"), /escapes/);

    const started = await agentService.startAsync("saas", agent.id, { userId: "allowed" });
    const container = await agentService.workspace.getWorkspaceContainer(agent.id);
    assert.ok(container?.dockerId);
    assert.equal(container.runtimeNodeId, bound.runtimeNodeId);
    const spec = docker.created.find((row) => row.spec.labels?.["zakura.agent"] === agent.id)!;
    assert.equal(spec.tenantId, "saas");
    assert.equal(spec.spec.volumes?.[0]?.hostPath, `/host/zakura/agents/${agent.id}/workspace`);
    assert.equal((await agentService.workspace.execInWorkspace(started, ["echo", "local"])).stdout, "local execution");
    const job = await agentService.workspace.startShellJob(started, ["echo", "local"]);
    assert.equal(job.stdout, "local shell");
    assert.equal((await agentService.workspace.getShellJob(started, job.jobId)).exitCode, 0);
    assert.equal(await agentService.workspace.isWorkspaceRunning(started), true);
    const count = docker.created.length;
    await agentService.workspace.ensureStarted(started);
    assert.equal(docker.created.length, count);
    await agentService.workspace.stop(started);
    assert.equal(await agentService.workspace.isWorkspaceRunning(started), false);
    assert.equal(existsSync(join(dir, "agents", agent.id, "workspace/outputs/local.txt")), true);
  });

  it("reports missing local Docker without converting the node into an offline Go runner", async () => {
    const agent = await newAgent();
    const bound = await agentService.update("saas", agent.id, { runtimeNodeId: "local", userId: "allowed" });
    docker.available = false;
    try {
      await assert.rejects(agentService.workspace.start(bound), /Docker unavailable/);
      assert.equal((await nodes.get("saas", bound.runtimeNodeId!))?.status, "online");
    } finally {
      docker.available = true;
    }
  });

  it("does not mistake a token-authenticated remote runner named Local for the server", async () => {
    const { node } = await nodes.create("named", { name: "Local" });
    await db.update(runtimeNodes).set({ slug: "local" }).where(eq(runtimeNodes.id, node.id));
    assert.equal((await nodes.get("named", node.id))?.status, "offline");
    await assert.rejects(nodes.requireRunnerClient("named", node.id), /Go 代理当前离线/);
  });

  it("repairs existing production records via the migration without changing bindings or remote nodes", async () => {
    await db.insert(runtimeNodes).values({ id: "upgrade-local", tenantId: "upgrade", name: "本机", slug: "local", kind: "computer", status: "draining", storageRoot: dir });
    const agent = await newAgent("upgrade");
    await db.update(agents).set({ runtimeNodeId: "upgrade-local" }).where(eq(agents.id, agent.id));
    await db.execute(sql.raw(readFileSync(new URL("../drizzle/0054_restore_local_runtime.sql", import.meta.url), "utf8")));
    const repaired = await db.query.runtimeNodes.findFirst({ where: eq(runtimeNodes.id, "upgrade-local") });
    assert.equal(repaired?.kind, "local");
    assert.equal(repaired?.status, "draining");
    assert.equal((await db.query.agents.findFirst({ where: eq(agents.id, agent.id) }))?.runtimeNodeId, "upgrade-local");
    const remote = await db.query.runtimeNodes.findFirst({ where: eq(runtimeNodes.tenantId, "named") });
    assert.equal(remote?.kind, "computer");
    assert.ok(remote?.tokenHash);
  });

  it("runs ACP image installation and stdio on local Docker with tenant isolation", async () => {
    const agent = await newAgent();
    const bound = await agentService.update("saas", agent.id, { runtimeNodeId: "local", userId: "allowed" });
    const progress: string[] = [];
    await agentService.workspace.ensureAcpAdapterImage(bound, "acp:test", (line) => progress.push(line));
    assert.ok(progress.includes("Pulled acp:test"));
    const connection = await agentService.workspace.attachStdioInAcpAdapter(bound, "test", "acp:test", "session");
    const reader = connection.readable.getReader();
    assert.equal(Buffer.from((await reader.read()).value!).toString(), "local rpc\n");
    await connection.writable.getWriter().write(Buffer.from("request\n"));
    assert.equal(docker.stdin.at(-1)?.toString(), "request\n");
    const adapter = [...docker.containers.values()].find((row) => row.labels["zakura.agent"] === agent.id)!;
    assert.equal(docker.attached.at(-1), adapter.id);
    const other = await nodes.ensureLocalNode("other");
    const { client } = await nodes.requireRunnerClient("other", other.id);
    await assert.rejects(client.execDocker(adapter.id, ["echo", "no"]), /does not belong/);
    assert.equal(await agentService.workspace.removeAcpAdapterContainers(bound, "test"), 1);
    assert.equal(docker.containers.has(adapter.id), false);
  });

  it("requires a Local grant when migrating to the server", async () => {
    const remote = (await nodes.create("saas", { name: "Migration source" })).node;
    const agent = await newAgent();
    await db.update(agents).set({ runtimeNodeId: remote.id }).where(eq(agents.id, agent.id));
    const app = new Hono<any>();
    app.use("*", async (c, next) => { c.set("session", { tenantId: "saas", userId: "denied" }); await next(); });
    registerMigrationRoutes(app, { migrations: new MigrationService(db, config, nodes), agentService });
    const response = await app.request(`/api/agents/${agent.id}/migrations`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetNodeId: "local" }),
    });
    assert.equal(response.status, 403);
    assert.equal((await db.query.agents.findFirst({ where: eq(agents.id, agent.id) }))?.runtimeNodeId, remote.id);
  });

  it("resolves the local alias before patching or checking residual workspace ownership", async () => {
    const agent = await newAgent();
    await agentService.update("saas", agent.id, { runtimeNodeId: "local", userId: "allowed" });
    const fs = await fsProvider.forAgent(agent.id, "saas");
    await fs.writeText("/keep.txt", "still bound");
    const app = appFor("saas", "allowed");
    const patch = await app.request("/api/runtime-nodes/local", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Renamed Local" }),
    });
    assert.equal(patch.status, 200);
    assert.equal((await patch.json() as { node: { name: string } }).node.name, "Renamed Local");
    const response = await app.request(`/api/runtime-nodes/local/agents/${agent.id}/workspace-residual`, { method: "DELETE" });
    assert.equal(response.status, 400);
    assert.equal((await fs.readText("/keep.txt")).content, "still bound");
  });
});
