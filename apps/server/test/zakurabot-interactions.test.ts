import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { agentUserQuestions, zakurabotInteractions, zakurabotMessages } from "../src/db/schema.js";
import { ZakurabotInteractionService } from "../src/services/zakurabot-interactions.js";
import { ZakurabotChannel } from "../src/services/zakurabot-channel.js";
import { AskUserService } from "../src/services/ask-user.js";
import type { ZakurabotReplyFrame } from "../src/services/zakurabot-protocol.js";
import { within, zakurabotHarness } from "./helpers/zakurabot.js";

describe("Zakura Bot interactions", () => {
  let h: Awaited<ReturnType<typeof zakurabotHarness>>;
  const approvals: unknown[] = [];
  let onStart: ((run: { sessionId: string; runId: string }) => Promise<void>) | undefined;
  let onForm: (() => void) | undefined;
  const acp = {
    async resolvePermission(...args: unknown[]) { approvals.push(args); },
    async resolveElicitation(...args: unknown[]) { approvals.push(args); onForm?.(); },
  };
  before(async () => { h = await zakurabotHarness({
    acp, onStart: async (run) => { await onStart?.(run); },
  }); });
  after(async () => { await h?.close(); });
  const headers = (token: string) => ({ authorization: `Bearer ${token}` });
  const get = (path: string, token: string) => fetch(`${h.url}/api/zakurabot/${path}`, { headers: headers(token) });
  const post = (path: string, body: unknown, token: string) => fetch(`${h.url}/api/zakurabot/${path}`, {
    method: "POST", headers: { ...headers(token), "content-type": "application/json" }, body: JSON.stringify(body),
  });
  it("delivers and resolves secret questions only through chat_reply, persists state, and rejects other users", async () => {
    const ctx = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    const peer = await h.addUser(ctx.tenantId);
    const socket = await h.connect(ctx.token);
    await socket.wait("ready");
    socket.send({ type: "send", agentId, clientMessageId: "secret-question", text: "Ask me" });
    const run = await h.waitForRun("secret-question");
    const answering = h.askUser.ask({ tenantId: ctx.tenantId, agentId, sessionId: run.sessionId, runId: run.runId,
      question: "Enter the credential", secret: true, mode: "sync", timeoutSeconds: 60 });
    const question = await socket.wait("chat_reply", (frame) => frame.payload.interaction?.type === "question");
    assert.equal(question.payload.kind, "card");
    assert.equal(question.payload.reply_to, "secret-question");
    assert.equal(question.payload.interaction?.secret, true);
    const endpoint = `agents/${agentId}/interactions/${question.messageId}`;
    assert.notEqual((await post(endpoint, { text: "steal" }, peer.token)).status, 200);
    assert.equal((await fetch(`${h.url}/api/zakurabot/${endpoint}`)).status, 401);
    // 控制台会话与 OAuth token 同权；同租户其他成员只能看到 pending 快照。
    const consoleView = await get(endpoint, h.adminToken(ctx.tenantId));
    assert.equal(consoleView.status, 200);
    assert.equal(((await consoleView.json()) as { interaction: { status: string } }).interaction.status, "pending");
    const answer = await post(endpoint, { text: "super-secret-answer" }, ctx.token);
    assert.equal(answer.status, 200);
    const snapshot = await answer.json();
    assert.equal(snapshot.messageId, question.messageId);
    assert.equal(snapshot.interaction.status, "answered");
    assert.equal(JSON.stringify(snapshot).includes("super-secret-answer"), false);
    assert.equal((await (await get(endpoint, ctx.token)).json()).interaction.status, "answered");
    assert.match((await within(answering)).text, /super-secret-answer/);
    const resolved = await socket.wait("chat_reply", (frame) => frame.messageId === question.messageId && frame.payload.interaction?.status === "answered");
    assert.equal(resolved.createdAt, question.createdAt);
    assert.equal((await post(endpoint, { text: "again" }, ctx.token)).status, 409);
    await run.finish();
    await socket.wait("typing", (frame) => frame.agentId === agentId && !frame.active);
    const history = await (await get(`agents/${agentId}/history`, ctx.token)).json();
    assert.equal(JSON.stringify(history).includes("super-secret-answer"), false);
    assert.equal(history.messages.filter((frame: { messageId?: string }) => frame.messageId === question.messageId).length, 1);
    assert.equal(JSON.stringify(socket.frames).includes("super-secret-answer"), false);
    assert.ok(socket.frames.filter((frame) => frame.type === "chat_reply").every((frame) => frame.payload.interaction));
    const stored = await h.db.select().from(zakurabotInteractions).where(eq(zakurabotInteractions.id, question.messageId));
    assert.equal(JSON.stringify(stored).includes("super-secret-answer"), false);
    const reconnected = await h.connect(ctx.token);
    await reconnected.wait("ready");
    await reconnected.wait("chat_reply", (frame) => frame.messageId === question.messageId && frame.payload.interaction?.status === "answered");
  });

  it("maps approvals to cards, validates the offered choices, and never sends raw tool data", async () => {
    const ctx = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    const socket = await h.connect(ctx.token);
    await socket.wait("ready");
    socket.send({ type: "send", agentId, clientMessageId: "approval", text: "Request approval" });
    const run = await h.waitForRun("approval");
    await h.sessions.appendEvent({ sessionId: run.sessionId, runId: run.runId, type: "permission_request", payload: {
      requestId: "approval-1", title: "Allow this action?", options: [
        { optionId: "yes", name: "Allow once", kind: "allow_once" }, { optionId: "no", name: "Deny", kind: "reject_once" },
      ], raw: "PRIVATE_TOOL_ARGUMENTS",
    } as never });
    const approval = await socket.wait("chat_reply", (frame) => frame.payload.interaction?.type === "approval");
    assert.equal(JSON.stringify(approval).includes("PRIVATE_TOOL_ARGUMENTS"), false);
    const endpoint = `agents/${agentId}/interactions/${approval.messageId}`;
    assert.equal((await post(endpoint, { optionId: "invented" }, ctx.token)).status, 400);
    assert.equal((await post(endpoint, { optionId: "yes" }, ctx.token)).status, 200);
    assert.equal(approvals.length, 1);
    assert.deepEqual(approvals[0], [ctx.tenantId, agentId, run.sessionId, { requestId: "approval-1", cancelled: false, optionId: "yes" }]);
    await socket.wait("chat_reply", (frame) => frame.messageId === approval.messageId && frame.payload.interaction?.status === "answered");
    const pending = await (await get(`agents/${agentId}/interactions`, ctx.token)).json();
    assert.equal(pending.interactions.length, 0);
    await run.finish();
  });

  it("projects ACP child permissions to their owning user and resolves the source session", async () => {
    const ctx = await h.access(2);
    const agentId = ctx.bindings[0]!.agentId;
    const peer = await h.addUser(ctx.tenantId);
    const socket = await h.connect(ctx.token), peerSocket = await h.connect(peer.token);
    await socket.wait("ready");
    await peerSocket.wait("ready");
    socket.send({ type: "send", agentId, clientMessageId: "acp-parent", text: "Run the coding agent" });
    peerSocket.send({ type: "send", agentId, clientMessageId: "acp-peer", text: "My separate conversation" });
    const run = await h.waitForRun("acp-parent");
    await h.waitForRun("acp-peer");
    const child = await h.sessions.createSession({ tenantId: ctx.tenantId, agentId, kind: "acp", origin: {
      source: "agent_loop", parentSessionId: run.sessionId, parentRunId: run.runId,
    } });
    const childRun = await h.sessions.createRun(child.id);
    await h.sessions.markRunStarted(childRun.id);
    const request = { requestId: "child-permission", title: "Allow the coding agent?",
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] };
    await h.sessions.appendEvent({ sessionId: child.id, runId: childRun.id, type: "permission_request", payload: request });
    const card = await socket.wait("chat_reply", (frame) => frame.payload.interaction?.requestId === request.requestId);
    assert.equal(card.payload.reply_to, "acp-parent");
    assert.equal(JSON.stringify(card).includes(child.id), false);
    assert.equal(peerSocket.frames.some((frame) => frame.type === "chat_reply" && frame.messageId === card.messageId), false);
    const endpoint = `agents/${agentId}/interactions/${card.messageId}`;
    assert.equal((await post(endpoint, { optionId: "allow" }, peer.token)).status, 404);
    assert.equal((await post(`agents/${ctx.bindings[1]!.agentId}/interactions/${card.messageId}`, { optionId: "allow" }, ctx.token)).status, 404);
    assert.equal((await post(endpoint, { optionId: "allow" }, ctx.token)).status, 200);
    assert.deepEqual(approvals.at(-1), [ctx.tenantId, agentId, child.id,
      { requestId: request.requestId, optionId: "allow", cancelled: false }]);
    const unrelated = await h.sessions.createSession({ tenantId: ctx.tenantId, agentId, kind: "acp", origin: { source: "api" } });
    await h.sessions.appendEvent({ sessionId: unrelated.id, type: "permission_request", payload: { ...request, requestId: "unrelated" } });
    await h.channel.deps.interactions!.sync(run.sessionId);
    assert.equal(socket.frames.some((frame) => frame.type === "chat_reply" && frame.payload.interaction?.requestId === "unrelated"), false);
    await h.sessions.appendEvent({ sessionId: child.id, runId: childRun.id, type: "permission_request",
      payload: { ...request, requestId: "cancel-with-parent" } });
    const pending = await socket.wait("chat_reply", (frame) => frame.payload.interaction?.requestId === "cancel-with-parent");
    await run.finish("cancelled");
    await socket.wait("chat_reply", (frame) => frame.messageId === pending.messageId && frame.payload.interaction?.status === "cancelled");
    assert.equal((await post(`agents/${agentId}/interactions/${pending.messageId}`, { optionId: "allow" }, ctx.token)).status, 409);
    await h.sessions.finishRun(child.id, childRun.id, "cancelled");
  });

  it("accepts a validated form while runtime startup is waiting for the answer", async () => {
    const ctx = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    let release!: () => void;
    const answered = new Promise<void>((resolve) => { release = resolve; });
    onForm = release;
    onStart = async (run) => {
      await h.sessions.appendEvent({ sessionId: run.sessionId, runId: run.runId, type: "elicitation_request", payload: {
        requestId: "startup-form", mode: "form", message: "Choose login method", fields: [
          { id: "methodId", type: "string", title: "Method", required: true, options: ["browser"] },
          { id: "count", type: "integer", required: true },
        ],
      } as never });
      await answered;
    };
    try {
      const socket = await h.connect(ctx.token);
      await socket.wait("ready");
      socket.send({ type: "send", agentId, clientMessageId: "startup", text: "Sign in" });
      const run = await h.waitForRun("startup");
      const form = await socket.wait("chat_reply", (frame) => frame.payload.interaction?.requestId === "startup-form");
      const endpoint = `agents/${agentId}/interactions/${form.messageId}`;
      for (const content of [{}, { methodId: "invented", count: 1 }, { methodId: "browser", count: 1.5 },
        { methodId: "browser", count: 1, injected: "field" }]) {
        assert.equal((await post(endpoint, { content }, ctx.token)).status, 400);
      }
      const response = await within(post(endpoint, { content: { methodId: "browser", count: 1 } }, ctx.token), "Answer blocked on startup");
      assert.equal(response.status, 200);
      assert.equal((await response.json()).interaction.status, "resolved");
      assert.deepEqual(approvals.at(-1), [ctx.tenantId, agentId, run.sessionId,
        { requestId: "startup-form", cancelled: false, content: { methodId: "browser", count: 1 } }]);
      await run.finish();
    } finally { release(); onStart = undefined; onForm = undefined; }
  });

  it("updates expired cards and cancels asynchronous questions when resetting context", async () => {
    const ctx = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    const socket = await h.connect(ctx.token);
    await socket.wait("ready");
    socket.send({ type: "send", agentId, clientMessageId: "expiry", text: "Ask questions" });
    const run = await h.waitForRun("expiry");
    await h.askUser.ask({ tenantId: ctx.tenantId, agentId, sessionId: run.sessionId, runId: run.runId,
      question: "Time limited", mode: "async", timeoutSeconds: 60 });
    const expiring = await socket.wait("chat_reply", (frame) => frame.payload.interaction?.title === "Time limited");
    await h.db.update(agentUserQuestions).set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(agentUserQuestions.id, expiring.payload.interaction!.requestId));
    await h.askUser.tick();
    await socket.wait("chat_reply", (frame) => frame.messageId === expiring.messageId && frame.payload.interaction?.status === "timeout");
    assert.equal((await post(`agents/${agentId}/interactions/${expiring.messageId}`, { text: "Late" }, ctx.token)).status, 409);
    await h.askUser.ask({ tenantId: ctx.tenantId, agentId, sessionId: run.sessionId, runId: run.runId,
      question: "Old context", mode: "async" });
    const old = await socket.wait("chat_reply", (frame) => frame.payload.interaction?.title === "Old context");
    await run.finish();
    assert.equal((await post(`sessions/${agentId}`, { action: "new" }, ctx.token)).status, 200);
    await socket.wait("chat_reply", (frame) => frame.messageId === old.messageId && frame.payload.interaction?.status === "cancelled");
    const [question] = await h.db.select().from(agentUserQuestions).where(eq(agentUserQuestions.id, old.payload.interaction!.requestId));
    assert.equal(question?.status, "cancelled");
    assert.equal((await (await get(`agents/${agentId}/interactions`, ctx.token)).json()).interactions.length, 0);
    assert.equal((await post(`agents/${agentId}/interactions/${old.messageId}`, { text: "Stale" }, ctx.token)).status, 404);
    assert.equal((await (await get(`agents/${agentId}/interactions/${old.messageId}`, ctx.token)).json()).interaction.status, "cancelled");
  });

  it("keeps asynchronous questions answerable after a turn ends and recovers a missing delivery after projection restart", async () => {
    const ctx = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    const socket = await h.connect(ctx.token);
    await socket.wait("ready");
    socket.send({ type: "send", agentId, clientMessageId: "async-question", text: "Ask asynchronously" });
    const run = await h.waitForRun("async-question");
    await h.askUser.ask({ tenantId: ctx.tenantId, agentId, sessionId: run.sessionId, runId: run.runId,
      question: "Choose a region", options: [{ id: "eu", label: "Europe" }, { id: "us", label: "US" }], mode: "async" });
    const question = await socket.wait("chat_reply", (frame) => frame.payload.interaction?.type === "question");
    await run.finish();
    await h.channel.deps.interactions!.sync(run.sessionId);
    await h.channel.deps.interactions!.close();
    await h.db.delete(zakurabotMessages).where(eq(zakurabotMessages.id, question.messageId));
    h.channel.deps.interactions = new ZakurabotInteractionService(h.db, { sessions: h.sessions, askUser: h.askUser, acp });
    const replay = await h.connect(ctx.token);
    await replay.wait("ready");
    const recovered = await replay.wait("chat_reply", (frame) => frame.messageId === question.messageId);
    assert.equal(recovered.payload.interaction?.status, "pending");
    assert.equal(recovered.createdAt, question.createdAt);
    const followUps: string[] = [];
    h.askUser.setFollowUp(async (input) => { followUps.push(input.content); });
    const endpoint = `agents/${agentId}/interactions/${question.messageId}`;
    assert.equal((await post(endpoint, { selected: ["invented"] }, ctx.token)).status, 400);
    const answered = await Promise.all([post(endpoint, { selected: ["eu"] }, ctx.token), post(endpoint, { selected: ["us"] }, ctx.token)]);
    assert.deepEqual(answered.map((response) => response.status).sort(), [200, 409]);
    assert.equal(followUps.length, 1);
    await replay.wait("chat_reply", (frame) => frame.messageId === question.messageId && frame.payload.interaction?.status === "answered");
  });

  it("restores chat_reply and observes an asynchronous follow-up after channel restart", async () => {
    const local = await zakurabotHarness();
    let restarted: ZakurabotChannel | undefined;
    try {
      const ctx = await local.access();
      const agentId = ctx.bindings[0]!.agentId;
      const socket = await local.connect(ctx.token);
      await socket.wait("ready");
      socket.send({ type: "send", agentId, clientMessageId: "before-restart", text: "Ask me later" });
      const run = await local.waitForRun("before-restart");
      await local.askUser.ask({ tenantId: ctx.tenantId, agentId, sessionId: run.sessionId, runId: run.runId,
        question: "Which region?", mode: "async" });
      const question = await socket.wait("chat_reply", (frame) => frame.payload.interaction?.type === "question");
      await run.finish();
      await socket.wait("typing", (frame) => frame.agentId === agentId && !frame.active);
      await local.channel.stop();
      assert.equal(local.registry.get(run.sessionId), undefined);
      const askUser = new AskUserService(local.db, local.sessions);
      restarted = new ZakurabotChannel({ ...local.channel.deps,
        interactions: new ZakurabotInteractionService(local.db, { sessions: local.sessions, askUser }) });
      let delivered!: (frame: ZakurabotReplyFrame) => void;
      const reply = new Promise<ZakurabotReplyFrame>((resolve) => { delivered = resolve; });
      restarted.subscribe({ tenantId: ctx.tenantId, userId: ctx.userId }, async (_conversation, frame) => {
        if (frame.type === "chat_reply" && frame.payload.text === "Follow-up after restart") delivered(frame);
      });
      askUser.setFollowUp(async (input) => {
        assert.ok(local.registry.get(input.sessionId), "follow-up must retain its remote tools");
        const next = await local.sessions.createRun(input.sessionId);
        await local.sessions.markRunStarted(next.id);
        await local.sessions.appendEvent({ sessionId: input.sessionId, runId: next.id, type: "run_start", payload: { runId: next.id } });
        await local.sessions.appendEvent({ sessionId: input.sessionId, runId: next.id, type: "assistant_message",
          payload: { messageId: "followup-final", content: "Follow-up after restart" } });
        await local.sessions.appendEvent({ sessionId: input.sessionId, runId: next.id, type: "run_end",
          payload: { runId: next.id, status: "completed" } });
        await local.sessions.finishRun(input.sessionId, next.id, "completed");
      });
      const snapshot = await restarted.respondInteraction({ tenantId: ctx.tenantId, userId: ctx.userId }, agentId, question.messageId, { cancelled: false, text: "Europe" });
      assert.equal(snapshot.interaction.status, "answered");
      assert.equal((await within(reply, "Follow-up lost its remote reply")).payload.reply_to, "before-restart");
    } finally { await restarted?.stop(); await local.close(); }
  });
});
