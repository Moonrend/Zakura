import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { io } from "socket.io-client";
import { agentChannelBindings, agents, tenantMemberships, tenants } from "../src/db/schema.js";
import { CloudAgentRuntime } from "../src/services/cloud-agent/runtime.js";
import { createZakurabotChat } from "../src/services/zakurabot-adapter.js";
import { CHAT_SDK_PLATFORMS, REMOTE_PLATFORMS } from "../src/services/remote-channel-runtime.js";
import { remoteChannelPromptBlock } from "../src/services/remote-channel-tools.js";
import type { ModelChatInvokeOptions, ModelChatMessage } from "@zakura/shared";
import type { ZakurabotServerFrame } from "../src/services/zakurabot-protocol.js";
import { ZakurabotChannel } from "../src/services/zakurabot-channel.js";
import { ZakurabotGateway } from "../src/services/zakurabot-gateway.js";
import { ZakurabotStore } from "../src/services/zakurabot-store.js";
import { ZakurabotInteractionService } from "../src/services/zakurabot-interactions.js";
import { within, zakurabotHarness } from "./helpers/zakurabot.js";

describe("zakurabot HTTP/WS channel with real persistent remote sessions", () => {
  let h: Awaited<ReturnType<typeof zakurabotHarness>>;
  before(async () => { h = await zakurabotHarness(); });
  after(async () => { await h?.close(); });

  it("registers a first-party platform while retaining every Chat SDK platform", () => {
    assert.ok(REMOTE_PLATFORMS.includes("zakurabot"));
    assert.equal((CHAT_SDK_PLATFORMS as readonly string[]).includes("zakurabot"), false);
    assert.ok(CHAT_SDK_PLATFORMS.includes("slack"));
    assert.ok(CHAT_SDK_PLATFORMS.includes("telegram"));
  });

  it("requires hello, rejects bad tokens and protocols, and times out unauthenticated sockets", async () => {
    const invalid = await h.connect("zbot_invalid");
    assert.equal(await within(invalid.closed), 4401);
    assert.equal(invalid.frames.some((f) => f.type === "ready"), false);
    const early = await h.connect();
    early.send({ type: "send", agentId: "a", clientMessageId: "early", text: "hello" });
    assert.equal(await within(early.closed), 4401);
    const version = await h.connect();
    version.send({ type: "hello", protocol: 2, token: "test", client: { name: "app", version: "1" } });
    assert.equal(await within(version.closed), 1008);
    const query = await h.connect(undefined, "/api/zakurabot/ws?token=never-accepted");
    assert.equal(await within(query.closed), 1008);
    const idle = await h.connect();
    assert.equal(await within(idle.closed, "Hello timeout not enforced", 7000), 4408);
    const timeout = idle.frames.findLast((frame) => frame.type === "error");
    assert.equal(timeout?.type === "error" && timeout.fatal, false, "a slow hello is retryable, not an auth failure");
  });

  it("rejects malformed upgrade paths without crashing the HTTP server", async () => {
    const error = await within(new Promise<Error>((resolve, reject) => {
      const req = request(h.url, { path: "/\\[", headers: {
        Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      } });
      req.once("error", resolve);
      req.once("response", (response) => { response.resume(); reject(new Error("Unexpected HTTP response")); });
      req.once("upgrade", (_response, socket) => { socket.destroy(); reject(new Error("Unexpected upgrade")); });
      req.end();
    }));
    assert.equal((error as NodeJS.ErrnoException).code, "ECONNRESET");
    assert.equal((await fetch(`${h.url}/api/health`)).status, 200);
  });

  it("authenticates OAuth api-scope tokens and rejects tokens without the scope", async () => {
    const ctx = await h.access();
    const other = await h.access();
    const endpoint = `${h.url}/api/zakurabot/agents`;
    const list = async (token?: string) => fetch(endpoint, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    assert.equal((await list()).status, 401);
    assert.equal((await list("not-a-jwt")).status, 401);
    const roster = await list(ctx.token);
    assert.equal(roster.status, 200);
    assert.deepEqual(new Set(((await roster.json()) as { agents: { id: string }[] }).agents.map((a) => a.id)),
      new Set(ctx.bindings.map((b) => b.agentId)));
    // MCP-scope tokens do not unlock the Zakura Bot surface.
    const mcpOnly = await h.signAccess(other.userId, other.tenantId, "mcp");
    assert.equal((await list(mcpOnly)).status, 401);
    const socket = await h.connect(mcpOnly);
    assert.equal(await within(socket.closed), 4401);
    const good = await h.connect(ctx.token);
    await good.wait("ready");
    await good.close();
  });

  it("shares the server with HTTP and Socket.IO, supports prefixes, and returns a scoped roster", async () => {
    const ctx = await h.access(2);
    const socket = await h.connect(ctx.token, "/prefix/api/zakurabot/ws");
    const ready = await socket.wait("ready");
    assert.equal(ready.protocol, 1);
    assert.deepEqual(new Set(ready.agents.map((a) => a.id)), new Set(ctx.bindings.map((b) => b.agentId)));
    socket.send({ type: "ping" });
    await socket.wait("pong");
    const response = await fetch(`${h.url}/api/health`);
    assert.equal(response.status, 200);
    const realtime = io(h.url, { path: "/api/socket.io", transports: ["websocket"], reconnection: false,
      auth: { token: h.adminToken(ctx.tenantId) } });
    try { await within(once(realtime, "connect")); }
    finally { realtime.close(); }
    await socket.close();
    // URL.pathname resets "" to "/", so the pinned client's += produces this path.
    const rootClient = await h.connect(ctx.token, "//api/zakurabot/ws");
    assert.equal((await rootClient.wait("ready")).agents.length, 2);
    await rootClient.close();
  });

  it("binds RemoteChannelSession before starting a run and deduplicates client retries", async () => {
    const ctx = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    const socket = await h.connect(ctx.token);
    await socket.wait("ready");
    const frame = { type: "send", agentId, clientMessageId: "retry-1", text: "Hello" };
    socket.send(frame);
    socket.send(frame);
    const echo = await socket.wait("message", (f) => f.message.clientMessageId === "retry-1");
    const run = await h.waitForRun("retry-1");
    await socket.wait("message", () => socket.frames.filter((f) => f.type === "message").length >= 2);
    assert.equal(echo.message.id, "retry-1");
    assert.equal(h.runs.filter((r) => r.handle.inboundMessageId === "retry-1").length, 1);
    assert.equal(run.handle.platform, "zakurabot");
    assert.equal(run.handle.bindingId, ctx.bindings[0]!.id);
    assert.equal(run.handle.sender?.userId, ctx.userId);
    assert.match(run.content, /来源: zakurabot/);
    assert.match(remoteChannelPromptBlock(run.handle), /必须调用 chat_reply/);
    const session = await h.sessions.getSession(ctx.tenantId, agentId, run.sessionId);
    assert.equal(session?.model, "test-model");
    assert.equal(JSON.parse(session!.originJson).platform, "zakurabot");
    socket.send({ ...frame, text: "different content with the same id" });
    await socket.wait("error", (f) => f.clientMessageId === "retry-1");
    await run.tool("chat_reply", { text: "Done" });
    await run.finish();
    await socket.wait("typing", (f) => !f.active);
    await socket.close();
  });

  it("isolates tenants and users even when client message ids match, and reaches every tenant agent", async () => {
    const ctx = await h.access();
    const foreign = await h.access();
    const sameTenant = await h.access(1, ctx.tenantId);
    const tablet = await h.addUser(ctx.tenantId);
    const phoneSocket = await h.connect(ctx.token);
    const tabletSocket = await h.connect(tablet.token);
    await phoneSocket.wait("ready");
    await tabletSocket.wait("ready");
    // 外租户的 Agent 不可见也不可达。
    phoneSocket.send({ type: "send", agentId: foreign.bindings[0]!.agentId, clientMessageId: `forbidden-${foreign.bindings[0]!.id}`, text: "No" });
    await phoneSocket.wait("error", (f) => f.clientMessageId === `forbidden-${foreign.bindings[0]!.id}`);
    // 同租户的全部 Agent 对每个成员自动可用（包括没有预配绑定的）。
    const crossFrame = { type: "send", agentId: sameTenant.bindings[0]!.agentId, clientMessageId: "cross-agent", text: "Hi" };
    phoneSocket.send(crossFrame);
    await h.waitForRun("cross-agent", ctx.userId);
    // 同一 Agent 上两个用户的会话互不相通。
    const frame = { type: "send", agentId: ctx.bindings[0]!.agentId, clientMessageId: "same-id", text: "Hi" };
    phoneSocket.send(frame);
    tabletSocket.send(frame);
    const phoneRun = await h.waitForRun("same-id", ctx.userId);
    const tabletRun = await h.waitForRun("same-id", tablet.userId);
    assert.notEqual(phoneRun.sessionId, tabletRun.sessionId);
    assert.notEqual(phoneRun.handle.threadId, tabletRun.handle.threadId);
    await phoneRun.tool("chat_reply", { text: "Phone only" });
    await tabletRun.tool("chat_reply", { text: "Tablet only" });
    await phoneRun.finish();
    await tabletRun.finish();
    await phoneSocket.wait("typing", (f) => !f.active);
    await tabletSocket.wait("typing", (f) => !f.active);
    assert.equal(JSON.stringify(phoneSocket.frames).includes("Tablet only"), false);
    assert.equal(JSON.stringify(tabletSocket.frames).includes("Phone only"), false);
    await phoneSocket.close();
    await tabletSocket.close();
  });

  it("interrupts an old turn before rebinding and rejects replies from superseded handles", async () => {
    const ctx = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    const socket = await h.connect(ctx.token);
    await socket.wait("ready");
    socket.send({ type: "send", agentId, clientMessageId: "old-turn", text: "Start" });
    const old = await h.waitForRun("old-turn");
    socket.send({ type: "send", agentId, clientMessageId: "new-turn", text: "Change direction" });
    const next = await h.waitForRun("new-turn");
    assert.equal(next.sessionId, old.sessionId);
    assert.equal((await h.sessions.getRun(old.runId))?.status, "cancelled");
    assert.equal((await old.tool("chat_reply", { text: "Stale reply" })).isError, true);
    assert.equal((await next.tool("chat_reply", { text: "New reply" })).isError, false);
    const reply = await socket.wait("chat_reply", (f) => f.payload.text === "New reply");
    assert.equal(reply.payload.reply_to, "new-turn");
    assert.equal(JSON.stringify(socket.frames).includes("Stale reply"), false);
    await next.finish();
    await socket.close();
  });

  it("the actual cloud runtime keeps its reply target across slow preparation and session rebinding", async () => {
    const ctx = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    await h.db.update(agents).set({ configJson: JSON.stringify({ cloud: {
      model: "test-model", autoMemory: false, autoTitle: false, autoCompact: false,
    } }) }).where(eq(agents.id, agentId));
    const agent = (await h.channel.deps.agents.get(ctx.tenantId, agentId))!;
    const session = await h.sessions.createSession({ tenantId: ctx.tenantId, agentId, title: "Runtime test", kind: "system" });
    const frames: ZakurabotServerFrame[] = [];
    const makeHandle = (inboundMessageId: string) => ({
      chat: createZakurabotChat({ agentId, deviceId: ctx.userId, deviceName: "Phone", threadId: "thread",
        post: async (f) => { frames.push(f); }, history: async () => [],
        publishFile: async () => { throw new Error("No files in this test"); } }),
      platform: "zakurabot", bindingId: ctx.bindings[0]!.id, threadId: "thread", channelId: "thread", inboundMessageId,
    });
    h.registry.bind(session.id, makeHandle("original-user-message"));
    const originalWarm = h.sessions.warmSession;
    h.sessions.warmSession = async (...args) => {
      await originalWarm.apply(h.sessions, args);
      if (args[0] === session.id) h.registry.bind(session.id, makeHandle("next-user-message"));
    };
    let calls = 0;
    const runtime = new CloudAgentRuntime({
      store: h.sessions, remoteChannels: h.registry,
      agentService: { get: async () => agent, list: async () => [agent] } as never,
      gateway: { listToolsForAgent: async () => [] } as never,
      modelRouter: {
        resolveRoute: async () => ({ meta: { contextLimit: 128_000 } }),
        chatStream: async (_tenant: string, messages: ModelChatMessage[], _route: unknown, options: ModelChatInvokeOptions) => {
          assert.ok(options.tools?.some((t) => t.function.name === "chat_reply"));
          assert.ok(messages.some((m) => m.role === "system" && m.content?.includes("必须调用 chat_reply")));
          return ++calls === 1
            ? { model: "test", routeSlug: "test", openai: {}, content: null,
              toolCalls: [{ id: "reply", type: "function", function: { name: "chat_reply", arguments: '{"text":"Runtime reply"}' } }] }
            : { model: "test", routeSlug: "test", openai: {}, content: "Private completion" };
        },
      } as never,
    });
    let unsubscribe = () => {};
    const completed = new Promise<void>((resolve, reject) => {
      unsubscribe = h.sessions.subscribe(session.id, (event) => {
        if (event.type === "run_error") reject(new Error(JSON.stringify(event.payload)));
        if (event.type === "run_end") resolve();
      });
    });
    try {
      await runtime.startTurn({ tenantId: ctx.tenantId, agentId, sessionId: session.id, content: "Hi" });
      await within(completed);
      const reply = frames.find((f) => f.type === "chat_reply");
      assert.equal(reply?.type, "chat_reply");
      if (reply?.type === "chat_reply") assert.equal(reply.payload.reply_to, "original-user-message");
      assert.equal(JSON.stringify(frames).includes("Private completion"), false);
    } finally { h.sessions.warmSession = originalWarm; unsubscribe(); }
  });

  it("emits chat_reply, downloadable attachments, cards, typing and safe tool activity without assistant mirroring", async () => {
    const ctx = await h.access();
    const socket = await h.connect(ctx.token);
    await socket.wait("ready");
    socket.send({ type: "send", agentId: ctx.bindings[0]!.agentId, clientMessageId: "rich", text: "Send report" });
    const run = await h.waitForRun("rich");
    await socket.wait("typing", (f) => f.active);
    for (const event of [
      { type: "assistant_delta", payload: { messageId: "internal", delta: "PRIVATE ASSISTANT TEXT" } },
      { type: "assistant_message", payload: { messageId: "internal", content: "PRIVATE ASSISTANT TEXT" } },
      { type: "tool_call_start", payload: { toolCallId: "tool-1", name: "shell_exec" } },
      { type: "tool_call_args", payload: { toolCallId: "tool-1", arguments: "SECRET ARGUMENTS" } },
      { type: "tool_call_result", payload: { toolCallId: "tool-1", name: "shell_exec", isError: false,
        resultText: "SECRET RESULTS", durationMs: 10 } },
    ] as const) await h.sessions.appendEvent({ sessionId: run.sessionId, runId: run.runId, ...event });
    const result = await run.tool("chat_reply", { text: "Report ready", kind: "raw",
      attachments: ["/workspace/report.txt", "https://example.com/chart.png"],
      actions: [{ label: "Open", url: "https://example.com", style: "primary" }],
      card: { title: "Report", fields: [{ label: "Status", value: "OK" }],
        table: { headers: ["Test"], rows: [["Passed"]] } } });
    assert.equal(result.isError, false);
    await run.tool("chat_reply", { attachments: ["https://example.com/extra.pdf"] });
    assert.equal((await run.tool("chat_reply", { attachments: ["/workspace/empty.txt"] })).isError, true);
    assert.equal((await run.tool("chat_reply", { attachments: ["/workspace/../outside.txt"] })).isError, true);
    await run.finish();
    const reply = await socket.wait("chat_reply", (f) => f.payload.text === "Report ready");
    const tool = await socket.wait("tool_activity", (f) => f.message.tool.name === "shell_exec" && f.message.tool.ok === true);
    await socket.wait("typing", (f) => !f.active);
    assert.equal(reply.payload.reply_to, "rich");
    assert.equal(reply.payload.kind, "raw");
    assert.deepEqual(reply.payload.card?.table?.rows, [["Passed"]]);
    assert.equal(reply.payload.actions?.[0]?.label, "Open");
    assert.equal(reply.payload.attachments?.length, 2);
    assert.equal(tool.message.tool.detail, undefined);
    const attachment = await fetch(reply.payload.attachments![0]!.url);
    assert.equal(attachment.status, 200);
    assert.equal(await attachment.text(), "hello from the workspace");
    const serialized = JSON.stringify(socket.frames);
    for (const secret of ["PRIVATE ASSISTANT TEXT", "SECRET ARGUMENTS", "SECRET RESULTS", "/workspace/"])
      assert.equal(serialized.includes(secret), false);
    assert.equal(socket.frames.filter((f) => f.type === "chat_reply").length, 2);
    await socket.close();
  });

  it("interrupts only the device's run and completes typing/tool activity; silent runs still use chat_reply", async () => {
    const ctx = await h.access();
    const socket = await h.connect(ctx.token);
    await socket.wait("ready");
    socket.send({ type: "send", agentId: ctx.bindings[0]!.agentId, clientMessageId: "stop", text: "Long task" });
    const run = await h.waitForRun("stop");
    await h.sessions.appendEvent({ sessionId: run.sessionId, runId: run.runId, type: "tool_call_start",
      payload: { toolCallId: "pending", name: "shell_exec" } });
    await socket.wait("tool_activity", (f) => f.message.tool.name === "shell_exec");
    socket.send({ type: "interrupt", agentId: ctx.bindings[0]!.agentId });
    await socket.wait("typing", (f) => !f.active);
    await socket.wait("tool_activity", (f) => f.message.tool.interrupted === true);
    assert.equal((await h.sessions.getRun(run.runId))?.status, "cancelled");
    const fallback = await socket.wait("chat_reply");
    assert.equal(fallback.payload.reply_to, "stop");
    assert.equal(run.handle.chatReplySuccessCount, 1);
    await socket.close();
  });

  it("stores replies without waiting on a slow socket subscriber", async () => {
    const ctx = await h.access();
    const socket = await h.connect(ctx.token);
    await socket.wait("ready");
    socket.send({ type: "send", agentId: ctx.bindings[0]!.agentId, clientMessageId: "slow-subscriber", text: "Hi" });
    const run = await h.waitForRun("slow-subscriber");
    const unsubscribe = h.channel.subscribe({ tenantId: ctx.tenantId, userId: ctx.userId }, () => new Promise(() => {}));
    try {
      assert.equal((await within(run.tool("chat_reply", { text: "Stored reply" }), "Slow subscriber blocked a reply", 1000)).isError, false);
      await socket.wait("chat_reply", (f) => f.payload.text === "Stored reply");
    } finally { unsubscribe(); await run.finish(); await socket.close(); }
  });

  it("reflects binding and membership changes; suspended members cannot authenticate", async () => {
    const ctx = await h.access();
    const socket = await h.connect(ctx.token);
    await socket.wait("ready");
    await h.db.update(agentChannelBindings).set({ enabled: false }).where(eq(agentChannelBindings.id, ctx.bindings[0]!.id));
    await h.gateway.refresh();
    assert.equal(await socket.wait("agents", (f) => f.agents.length === 0).then(() => true), true,
      "a disabled binding simply empties the roster");
    await h.db.update(agentChannelBindings).set({ enabled: true }).where(eq(agentChannelBindings.id, ctx.bindings[0]!.id));
    await h.gateway.refresh();
    await socket.wait("agents", (f) => f.agents.length === 1);
    await socket.close();
    const other = await h.access();
    const suspended = await h.connect(other.token);
    await suspended.wait("ready");
    await h.db.update(tenants).set({ suspendedAt: new Date() }).where(eq(tenants.id, other.tenantId));
    suspended.send({ type: "ping" });
    assert.equal(await within(suspended.closed), 4401);
  });

  it("correlates a suspended member error with the failed send and cancels their active run", async () => {
    const ctx = await h.access();
    const socket = await h.connect(ctx.token);
    await socket.wait("ready");
    await h.db.update(tenantMemberships).set({ status: "suspended" })
      .where(and(eq(tenantMemberships.tenantId, ctx.tenantId), eq(tenantMemberships.userId, ctx.userId)));
    socket.send({ type: "send", agentId: ctx.bindings[0]!.agentId, clientMessageId: "expired-send", text: "Hi" });
    const error = await socket.wait("error", (f) => f.clientMessageId === "expired-send");
    assert.equal(error.fatal, true);
    assert.equal(await within(socket.closed), 4401);

    const running = await h.access();
    const connected = await h.connect(running.token);
    await connected.wait("ready");
    connected.send({ type: "send", agentId: running.bindings[0]!.agentId, clientMessageId: "revoke-active", text: "Work" });
    const run = await h.waitForRun("revoke-active");
    await connected.wait("typing", (f) => f.active);
    await h.db.update(tenantMemberships).set({ status: "suspended" })
      .where(and(eq(tenantMemberships.tenantId, running.tenantId), eq(tenantMemberships.userId, running.userId)));
    await h.gateway.disconnectUser(running.tenantId, running.userId);
    assert.equal(await within(connected.closed), 4401);
    await h.gateway.refresh();
    await run.finish("cancelled");
    assert.equal((await h.sessions.getRun(run.runId))?.status, "cancelled");
    assert.equal((await run.tool("chat_reply", { text: "Not delivered" })).isError, true);
  });

  it("replays persisted messages after disconnect and gateway restart, without starting a duplicate run", async () => {
    const ctx = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    const socket = await h.connect(ctx.token);
    await socket.wait("ready");
    const frame = { type: "send", agentId, clientMessageId: "offline", text: "Continue offline" };
    socket.send(frame);
    const run = await h.waitForRun("offline");
    await socket.close();
    assert.equal((await run.tool("chat_reply", { text: "Delivered while offline" })).isError, false);
    await run.finish();
    await h.gateway.close();
    const channel = new ZakurabotChannel({ ...h.channel.deps, store: new ZakurabotStore(h.db),
      interactions: new ZakurabotInteractionService(h.db, { sessions: h.sessions, askUser: h.askUser }) });
    const gateway = new ZakurabotGateway(channel, { publicBaseUrl: h.url });
    gateway.attach(h.server);
    try {
      const reconnected = await h.connect(ctx.token);
      await reconnected.wait("ready");
      await reconnected.wait("message", (f) => f.message.clientMessageId === "offline");
      const replay = await reconnected.wait("chat_reply", (f) => f.payload.text === "Delivered while offline");
      assert.equal(replay.payload.reply_to, "offline");
      reconnected.send(frame);
      await reconnected.wait("message", () => reconnected.frames.filter((f) => f.type === "message").length >= 2);
      assert.equal(h.runs.filter((r) => r.handle.inboundMessageId === "offline").length, 1);
      await reconnected.close();
    } finally { await gateway.close(); }
  });
});
