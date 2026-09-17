import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { LocalWorkspaceFs } from "@zakura/core";
import type { CloudAgentAttachment } from "@zakura/shared";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { WebSocket } from "ws";
import type { AppConfig } from "../../src/config.js";
import { createDb } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { agents, newId, tenantMemberships, tenants, users } from "../../src/db/schema.js";
import type { AppVariables } from "../../src/api/routes.js";
import { registerFileShareRoutes } from "../../src/api/file-share-routes.js";
import { registerZakurabotRoutes } from "../../src/api/zakurabot-routes.js";
import { registerZakurabotAppRoutes } from "../../src/api/zakurabot-app-routes.js";
import { ZakurabotFileService } from "../../src/services/zakurabot-files.js";
import { ZakurabotInteractionService } from "../../src/services/zakurabot-interactions.js";
import { AskUserService } from "../../src/services/ask-user.js";
import type { AcpSessionService } from "../../src/services/acp/session.js";
import type { AgentWorkspaceService } from "../../src/services/agent-workspace.js";
import { createSocketGateway } from "../../src/realtime/socket-gateway.js";
import { signSession, verifySession } from "../../src/services/auth.js";
import { CloudAgentSessionStore } from "../../src/services/cloud-agent-session.js";
import { FileShareService } from "../../src/services/file-shares.js";
import { RemoteAgentIngress } from "../../src/services/remote-agent-ingress.js";
import { callRemoteChannelTool, RemoteChannelSessionRegistry, type RemoteChannelSessionHandle } from "../../src/services/remote-channel-tools.js";
import { createZakurabotFilePublisher } from "../../src/services/zakurabot-adapter.js";
import { ZakurabotChannel } from "../../src/services/zakurabot-channel.js";
import { ZakurabotGateway } from "../../src/services/zakurabot-gateway.js";
import type { ZakurabotServerFrame } from "../../src/services/zakurabot-protocol.js";
import { ZakurabotStore } from "../../src/services/zakurabot-store.js";

export async function within<T>(promise: Promise<T>, message = "Timed out", timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { clearTimeout(timer!); }
}

export class SocketProbe {
  readonly frames: ZakurabotServerFrame[] = [];
  readonly ws: WebSocket;
  private readonly events = new EventEmitter();
  readonly closed: Promise<number>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("error", () => {});
    this.ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as ZakurabotServerFrame;
      this.frames.push(frame);
      this.events.emit("frame", frame);
    });
    this.closed = new Promise((resolve) => this.ws.once("close", (code) => resolve(code)));
  }
  send(frame: unknown) { this.ws.send(JSON.stringify(frame)); }
  async wait<T extends ZakurabotServerFrame["type"]>(type: T,
    predicate: (frame: Extract<ZakurabotServerFrame, { type: T }>) => boolean = () => true) {
    type Frame = Extract<ZakurabotServerFrame, { type: T }>;
    const matches = (frame: ZakurabotServerFrame): frame is Frame => frame.type === type && predicate(frame as Frame);
    const existing = this.frames.find(matches);
    if (existing) return existing;
    let listener: (frame: ZakurabotServerFrame) => void;
    try {
      return await within(new Promise<Frame>((resolve) => {
        listener = (frame) => { if (matches(frame)) resolve(frame); };
        this.events.on("frame", listener);
      }), `Missing ${type}; received ${JSON.stringify(this.frames)}`);
    } finally { this.events.off("frame", listener!); }
  }
  async close() {
    this.ws.close();
    await within(this.closed);
  }
}

export async function zakurabotHarness(options: {
  workspace?: Pick<AgentWorkspaceService, "getDesktopInfo" | "execInWorkspace" | "ensureStarted">;
  acp?: Pick<AcpSessionService, "resolvePermission" | "resolveElicitation">;
  onStart?: (run: { sessionId: string; runId: string }) => Promise<void>;
} = {}) {
  process.env.REDIS_URL = "off";
  const dataDir = mkdtempSync(join(tmpdir(), "zakurabot-test-"));
  const databaseUrl = `pglite:${join(dataDir, "db")}`;
  await runMigrations(databaseUrl);
  const database = await createDb({ databaseUrl, dataDir });
  const db = database.db;
  const config = { dataDir, databaseUrl, secret: "zakurabot-test-secret", publicBaseUrl: "http://localhost" } as AppConfig;
  const app = new Hono<{ Variables: AppVariables }>();
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.use("/api/*", async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer /, "");
    const session = token ? verifySession(config.secret, token) : null;
    if (session) c.set("session", session);
    await next();
  });
  const server = await new Promise<Server>((resolve) => {
    const running = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(running as Server));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.publicBaseUrl = url;
  const agentService = {
    get: async (tenantId: string, agentId: string) => (await db.select().from(agents)
      .where(and(eq(agents.tenantId, tenantId), eq(agents.id, agentId))).limit(1))[0] ?? null,
  };
  const workspaceFs = {
    forAgentBinding: async (binding: { id: string }) => new LocalWorkspaceFs(join(dataDir, "workspaces", binding.id)),
  };
  const fileShares = new FileShareService(db, config);
  const sessions = new CloudAgentSessionStore(db);
  const askUser = new AskUserService(db, sessions);
  const interactions = new ZakurabotInteractionService(db, { sessions, askUser, acp: options.acp });
  const registry = new RemoteChannelSessionRegistry();
  const runEvents = new EventEmitter();
  const runs: Array<{
    sessionId: string; runId: string; content: string; attachments: CloudAgentAttachment[]; handle: RemoteChannelSessionHandle;
    finish: (status?: "completed" | "cancelled" | "failed") => Promise<void>;
    tool: (name: string, args: Record<string, unknown>) => ReturnType<typeof callRemoteChannelTool>;
  }> = [];
  const ingress = new RemoteAgentIngress(db, agentService as never, sessions, {
    startTurn: async (input) => {
      const handle = registry.get(input.sessionId);
      assert.ok(handle, "remote handle must be bound before runtime.startTurn");
      const run = await sessions.createRun(input.sessionId);
      await sessions.markRunStarted(run.id);
      let ending: Promise<void> | undefined;
      const controlled = {
        sessionId: input.sessionId, runId: run.id, content: input.content, attachments: input.attachments ?? [], handle,
        finish(status: "completed" | "cancelled" | "failed" = "completed") {
          ending ??= (async () => {
            await sessions.appendEvent({ sessionId: input.sessionId, runId: run.id, type: "run_end", payload: { runId: run.id, status } });
            await sessions.finishRun(input.sessionId, run.id, status);
          })();
          return ending;
        },
        tool: (name: string, args: Record<string, unknown>) => callRemoteChannelTool(handle, name, args),
      };
      sessions.onRunCancel(run.id, () => { void controlled.finish("cancelled"); });
      runs.push(controlled);
      runEvents.emit("run", controlled);
      await options.onStart?.(controlled);
      return { runId: run.id };
    },
  }, config);
  const store = new ZakurabotStore(db);
  const channel = new ZakurabotChannel({ store, ingress, sessions: registry, sessionStore: sessions,
    agents: agentService, files: new ZakurabotFileService(db, { agents: agentService, workspaceFs, publicBaseUrl: url }), interactions,
    desktopAvailable: Boolean(options.workspace),
    publishFile: createZakurabotFilePublisher({ agents: agentService, workspaceFs, fileShares }) });
  const gateway = new ZakurabotGateway(channel, { publicBaseUrl: `${url}/prefix` });
  registerZakurabotRoutes(app, gateway, url);
  registerZakurabotAppRoutes(app, gateway, url, options.workspace);
  registerFileShareRoutes(app, fileShares, agentService as never, workspaceFs as never);
  const socketIo = createSocketGateway(server, { db, config, store: sessions });
  gateway.attach(server);
  const probes: SocketProbe[] = [];

  async function access(count = 1, tenantId = newId()) {
    const exists = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    if (!exists) {
      await db.insert(tenants).values({ id: tenantId, name: "Test tenant", slug: tenantId });
      await db.insert(users).values({ id: tenantId, email: `${tenantId}@example.test` });
      await db.insert(tenantMemberships).values({ tenantId, userId: tenantId, role: "owner", status: "active" });
    }
    const bindings = [];
    for (let i = 0; i < count; i++) {
      const id = newId();
      await db.insert(agents).values({ id, tenantId, name: `Agent ${i + 1}`, slug: id,
        enableFs: true, status: "ready", configJson: JSON.stringify({ cloud: { model: "test-model" } }) });
      const fs = await workspaceFs.forAgentBinding({ id });
      writeFileSync(join(fs.getRoot(), "report.txt"), "hello from the workspace");
      writeFileSync(join(fs.getRoot(), "empty.txt"), "");
      bindings.push((await ingress.saveBinding(tenantId, { agentId: id, platform: "zakurabot", profileKey: "remote-zakurabot",
        enabled: true, label: `Bot ${i + 1}` }))!);
    }
    const issued = await channel.issueDevice(tenantId, { name: "Phone", bindingIds: bindings.map((b) => b.id), expiresInDays: 90 });
    return { tenantId, bindings, ...issued };
  }

  const adminToken = (tenantId: string, role = "owner") => signSession(config.secret,
    { userId: tenantId, tenantId, email: `${tenantId}@example.test`, role });
  return {
    url, app, db, config, server, ingress, registry, sessions, store, channel, gateway, runs, access, adminToken, fileShares,
    askUser, interactions, workspaceFs,
    async connect(token?: string, path = "/api/zakurabot/ws") {
      const probe = new SocketProbe(`${url.replace("http:", "ws:")}${path}`);
      probes.push(probe);
      await within(once(probe.ws, "open"));
      if (token !== undefined) probe.send({ type: "hello", protocol: 1, token, client: { name: "zakura-bot", version: "1.0" } });
      return probe;
    },
    async waitForRun(clientMessageId: string, deviceId?: string) {
      const matches = (r: (typeof runs)[number]) => r.handle.inboundMessageId === clientMessageId &&
        (!deviceId || r.handle.sender?.userId === deviceId);
      const exists = runs.find(matches);
      if (exists) return exists;
      const waiting = new Promise<(typeof runs)[number]>((resolve) => {
        const listener = (run: (typeof runs)[number]) => {
          if (matches(run)) { runEvents.off("run", listener); resolve(run); }
        };
        runEvents.on("run", listener);
      });
      return within(waiting, `Run not started for ${clientMessageId}`);
    },
    async close() {
      for (const probe of probes) probe.ws.terminate();
      await gateway.close();
      for (const run of runs) { await askUser.cancelRun(run.runId); await run.finish("cancelled"); }
      askUser.stop();
      await new Promise<void>((resolve) => socketIo.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await database.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
