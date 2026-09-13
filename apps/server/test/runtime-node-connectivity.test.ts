import assert from "node:assert/strict";
import { before, after, afterEach, describe, it } from "node:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { agents, runtimeNodes, tenants } from "../src/db/schema.js";
import type { AppConfig } from "../src/config.js";
import { RuntimeNodeService, mapRuntimeNode } from "../src/services/runtime-nodes.js";
import { RunnerHub } from "../src/services/runner-hub.js";
import { AgentService } from "../src/services/agents.js";
import { registerRuntimeNodeRoutes } from "../src/api/runtime-node-routes.js";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail("condition did not become true");
    await delay(5);
  }
}

describe("Go runner availability and shared node selection", () => {
  let db: Db;
  let closeDb: () => Promise<void>;
  let dir: string;
  let server: Server;
  let hub: RunnerHub;
  let nodes: RuntimeNodeService;
  let agentService: AgentService;
  let url: string;
  let sequence = 0;
  const sockets = new Set<WebSocket>();
  const config = {
    secret: "runner-connectivity-test-secret",
    multiTenant: true,
    runnerHeartbeatTimeoutSec: 60,
  } as AppConfig;

  before(async () => {
    process.env.REDIS_URL = "off";
    dir = mkdtempSync(join(tmpdir(), "zakura-runner-connectivity-"));
    const databaseUrl = `pglite:${join(dir, "pglite")}`;
    await runMigrations(databaseUrl);
    const created = await createDb({ databaseUrl, dataDir: dir });
    db = created.db;
    closeDb = created.close;
    await db.insert(tenants).values([
      { id: "owner", name: "Owner", slug: "runner-owner" },
      { id: "consumer", name: "Consumer", slug: "runner-consumer" },
    ]);
    hub = new RunnerHub(db, { heartbeatIntervalMs: 30, heartbeatTimeoutMs: 5000 });
    nodes = new RuntimeNodeService(db, config);
    nodes.bindHub(hub);
    agentService = new AgentService(db, {} as never, config, nodes);
    server = createServer();
    hub.attach(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/runtime-nodes/hub`;
  });

  afterEach(async () => {
    await Promise.all([...sockets].map(async (socket) => {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = once(socket, "close");
      socket.terminate();
      await closed;
    }));
    sockets.clear();
    // Let close handlers finish their database status writes.
    await db.query.runtimeNodes.findMany();
  });

  after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb?.();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function newNode(kind: "computer" | "server" | "runner" = "server", shared = true) {
    const number = ++sequence;
    const created = await nodes.create("owner", {
      name: `Zakura 厚浪云试用节点 ${number}`,
      kind: kind === "computer" ? "computer" : "server",
    });
    const [node] = await db.update(runtimeNodes).set({
      kind, isShared: shared, status: "online", lastSeenAt: new Date(), endpoint: "http://legacy:7443",
    }).where(eq(runtimeNodes.id, created.node.id)).returning();
    return { node, token: created.token };
  }

  async function newAgent(nodeId: string | null = null) {
    const number = ++sequence;
    const [agent] = await db.insert(agents).values({
      tenantId: "consumer", name: "ACP", slug: `acp-${number}`, runtimeNodeId: nodeId,
    }).returning();
    return agent;
  }

  async function connect(
    input: Awaited<ReturnType<typeof newNode>>,
    options: { handshake?: "hold" | "fail"; pong?: boolean } = {},
  ) {
    const frames: Array<{ type: string; method?: string; id: string }> = [];
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${input.token}` } });
    sockets.add(socket);
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      frames.push(frame);
      if (frame.type === "ping" && options.pong !== false) {
        socket.send(JSON.stringify({ type: "pong", id: frame.id }));
      }
      if (frame.type === "req" && frame.method === "sys.info" && options.handshake !== "hold") {
        socket.send(JSON.stringify({
          type: "res", id: frame.id, ok: options.handshake !== "fail", error: "info failed",
          result: { kind: "server", version: "test-go", storageRoot: "/runner", capabilities: { host: true, docker: true }, docker: { ok: true } },
        }));
      }
    });
    await once(socket, "open");
    await until(() => frames.some((frame) => frame.method === "sys.info"));
    if (!options.handshake) await until(() => hub.get(input.node.id) !== null);
    return { socket, frames };
  }

  it("reports a stale shared HTTP runner as offline and rejects binding before saving it", async () => {
    const { node, token } = await newNode("runner");
    assert.equal((await nodes.listAccessible("consumer")).find((row) => row.id === node.id)?.status, "offline");
    await nodes.register({ token, endpoint: "http://legacy:7443" });
    await nodes.heartbeat(node.id, { token });
    const listed = (await nodes.listAccessible("consumer")).find((row) => row.id === node.id)!;
    assert.equal(listed.status, "offline");
    assert.equal(listed.access, "shared");
    assert.equal((await nodes.getAccessible("consumer", node.id))?.status, "offline");
    assert.equal((await nodes.listAllRemote()).find((row) => row.id === node.id)?.status, "offline");
    await assert.rejects(nodes.requireRunnerClient("consumer", node.id), (error: Error) => {
      assert.match(error.message, /共享节点.*当前离线/);
      assert.doesNotMatch(error.message, /运行安装脚本/);
      return true;
    });
    const agent = await newAgent();
    await assert.rejects(agentService.update("consumer", agent.id, { runtimeNodeId: node.id, userId: "member" }), /当前离线/);
    assert.equal((await db.query.agents.findFirst({ where: eq(agents.id, agent.id) }))?.runtimeNodeId, null);
    const bound = await newAgent(node.id);
    await assert.rejects(agentService.startAsync("consumer", bound.id), /当前离线/);

    const app = new Hono<any>();
    app.use("*", async (c, next) => {
      c.set("session", { tenantId: "consumer", userId: "member" });
      await next();
    });
    registerRuntimeNodeRoutes(app, { nodes, db, config });
    const response = await app.request("/api/runtime-nodes");
    assert.equal(response.status, 200);
    const body = await response.json() as { nodes: Array<{ id: string; status: string }> };
    assert.equal(body.nodes.find((row) => row.id === node.id)?.status, "offline");
  });

  it("includes shared Go server/computer nodes while preserving tenant isolation", async () => {
    const sharedServer = await newNode("server");
    const sharedComputer = await newNode("computer");
    const privateNode = await newNode("server", false);
    const retiredLocal = await newNode("runner");
    await db.update(runtimeNodes).set({ slug: "local" }).where(eq(runtimeNodes.id, retiredLocal.node.id));
    await connect(sharedServer);
    const listed = await nodes.listAccessible("consumer");
    assert.equal(listed.find((node) => node.id === sharedServer.node.id)?.status, "online");
    assert.ok(listed.some((node) => node.id === sharedComputer.node.id));
    assert.ok(!listed.some((node) => node.id === privateNode.node.id || node.id === retiredLocal.node.id));
    assert.equal(await nodes.getAccessible("consumer", privateNode.node.id), null);
    const { client } = await nodes.requireRunnerClient("consumer", sharedServer.node.id);
    assert.equal(client.workspaceKind, "container");
    assert.equal((await client.ping()).docker?.ok, true);
    const agent = await newAgent();
    const bound = await agentService.update("consumer", agent.id, { runtimeNodeId: sharedServer.node.id, userId: "member", restart: false });
    assert.equal(bound.runtimeNodeId, sharedServer.node.id);
  });

  it("a legacy runner reconnects with its existing token and becomes a usable shared Go node", async () => {
    const legacy = await newNode("runner");
    await connect(legacy);
    const node = await nodes.getAccessible("consumer", legacy.node.id);
    assert.ok(node);
    assert.equal(node.kind, "server");
    assert.equal(node.endpoint, null);
    assert.equal(node.status, "online");
    assert.equal(mapRuntimeNode(node).needsReinstall, false);
    assert.equal((await nodes.requireRunnerClient("consumer", node.id)).client.workspaceKind, "container");
  });

  it("keeps draining nodes available for maintenance but rejects new bindings", async () => {
    const input = await newNode();
    const { frames } = await connect(input);
    await db.update(runtimeNodes).set({ status: "draining" }).where(eq(runtimeNodes.id, input.node.id));
    const pings = frames.filter((frame) => frame.type === "ping").length;
    await until(() => frames.filter((frame) => frame.type === "ping").length > pings);
    const { client, node } = await nodes.requireRunnerClient("consumer", input.node.id);
    assert.equal(node.status, "draining");
    assert.equal((await client.ping()).docker?.ok, true);
    const agent = await newAgent();
    await assert.rejects(agentService.update("consumer", agent.id, { runtimeNodeId: node.id, userId: "member" }), /正在排空/);
    await assert.rejects(agentService.startAsync("consumer", agent.id, { runtimeNodeId: node.id }), /正在排空/);
  });

  it("does not offer sessions before a successful handshake or after handshake failure", async () => {
    for (const handshake of ["hold", "fail"] as const) {
      const input = await newNode();
      const { socket } = await connect(input, { handshake });
      assert.equal(hub.get(input.node.id), null);
      assert.equal((await nodes.getAccessible("consumer", input.node.id))?.status, "offline");
      if (handshake === "fail") await until(() => socket.readyState === WebSocket.CLOSED);
    }
  });

  it("sending pings cannot keep an unresponsive runner online", async () => {
    const input = await newNode();
    const { socket, frames } = await connect(input, { pong: false });
    const session = hub.get(input.node.id)!;
    const beforePing = await db.query.runtimeNodes.findFirst({ where: eq(runtimeNodes.id, input.node.id) });
    await until(() => frames.some((frame) => frame.type === "ping"));
    const afterPing = await db.query.runtimeNodes.findFirst({ where: eq(runtimeNodes.id, input.node.id) });
    assert.equal(afterPing?.lastSeenAt?.getTime(), beforePing?.lastSeenAt?.getTime());
    session.lastSeenAt = Date.now() - 6000;
    assert.equal(hub.get(input.node.id), null);
    assert.equal((await nodes.getAccessible("consumer", input.node.id))?.status, "offline");
    await until(() => socket.readyState === WebSocket.CLOSED);
    await until(async () => (await db.query.runtimeNodes.findFirst({ where: eq(runtimeNodes.id, input.node.id) }))?.status === "offline");
  });

  it("reconnection replaces the old session and rejects its pending RPCs", async () => {
    const input = await newNode();
    const first = await connect(input);
    const old = hub.get(input.node.id)!;
    const rejected = assert.rejects(old.rpc("docker.pull", { image: "test:1" }), /replaced|连接关闭/);
    await until(() => first.frames.some((frame) => frame.method === "docker.pull"));
    await connect(input);
    await rejected;
    await until(() => first.socket.readyState === WebSocket.CLOSED);
    assert.notEqual(hub.get(input.node.id), old);
    assert.equal((await nodes.getAccessible("consumer", input.node.id))?.status, "online");
  });
});
