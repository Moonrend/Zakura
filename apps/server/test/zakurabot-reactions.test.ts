import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { zakurabotHarness } from "./helpers/zakurabot.js";

type ReactionList = { reactions: { messageId: string; emoji: string; userId: string; createdAt: number }[] };

describe("Zakura Bot message reactions", () => {
  let h: Awaited<ReturnType<typeof zakurabotHarness>>;
  before(async () => { h = await zakurabotHarness(); });
  after(async () => { await h?.close(); });
  const headers = (token: string) => ({ authorization: `Bearer ${token}` });
  const get = (path: string, token: string) => fetch(`${h.url}/api/zakurabot/${path}`, { headers: headers(token) });
  const react = (agentId: string, token: string, messageId: string, emoji: string, method: "POST" | "DELETE" = "POST") =>
    fetch(`${h.url}/api/zakurabot/agents/${agentId}/messages/${messageId}/reactions`, {
      method, headers: { ...headers(token), "content-type": "application/json" }, body: JSON.stringify({ emoji }) });
  const list = (agentId: string, messageId: string, token: string) =>
    get(`agents/${agentId}/messages/${messageId}/reactions`, token).then((response) => response.json() as Promise<ReactionList>);

  it("adds, deduplicates, replaces, removes, and lists reactions while broadcasting to subscribers", async () => {
    const ctx = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    const socket = await h.connect(ctx.token);
    await socket.wait("ready");
    const messageId = "reaction-message-1";

    assert.equal((await react(agentId, ctx.token, messageId, "👍")).status, 201);
    const addFrame = await socket.wait("reaction", (frame) => frame.messageId === messageId && frame.op === "add");
    assert.deepEqual({ emoji: addFrame.emoji, userId: addFrame.userId, op: addFrame.op },
      { emoji: "👍", userId: ctx.userId, op: "add" });

    assert.equal((await react(agentId, ctx.token, messageId, "👍")).status, 201);
    let reactions = await list(agentId, messageId, ctx.token);
    assert.equal(reactions.reactions.length, 1);
    assert.equal(reactions.reactions[0]!.emoji, "👍");
    assert.equal(reactions.reactions[0]!.userId, ctx.userId);
    assert.ok(reactions.reactions[0]!.createdAt > 0);

    assert.equal((await react(agentId, ctx.token, messageId, "🎉")).status, 201);
    reactions = await list(agentId, messageId, ctx.token);
    assert.equal(reactions.reactions.length, 1);
    assert.equal(reactions.reactions[0]!.emoji, "🎉");

    const removed = await react(agentId, ctx.token, messageId, "🎉", "DELETE");
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { removed: true });
    const removeFrame = await socket.wait("reaction", (frame) => frame.messageId === messageId && frame.op === "remove");
    assert.equal(removeFrame.emoji, "🎉");
    assert.equal(removeFrame.userId, ctx.userId);
    assert.equal((await list(agentId, messageId, ctx.token)).reactions.length, 0);
    assert.deepEqual(await (await react(agentId, ctx.token, messageId, "🎉", "DELETE")).json(), { removed: false });
  });

  it("scopes reactions per user and per tenant", async () => {
    const ctx = await h.access(), other = await h.access();
    const peer = await h.addUser(ctx.tenantId);
    const agentId = ctx.bindings[0]!.agentId;
    const messageId = "reaction-message-2";
    assert.equal((await react(agentId, ctx.token, messageId, "✅")).status, 201);
    assert.equal((await react(agentId, peer.token, messageId, "🐛")).status, 201);
    const mine = await list(agentId, messageId, ctx.token);
    assert.equal(mine.reactions.length, 1);
    assert.equal(mine.reactions[0]!.emoji, "✅");
    assert.equal(mine.reactions[0]!.userId, ctx.userId);
    const theirs = await list(agentId, messageId, peer.token);
    assert.equal(theirs.reactions.length, 1);
    assert.equal(theirs.reactions[0]!.emoji, "🐛");
    assert.equal(theirs.reactions[0]!.userId, peer.userId);
    assert.equal((await react(agentId, other.token, messageId, "❌")).status, 403);
    assert.equal((await get(`agents/${agentId}/messages/${messageId}/reactions`, other.token)).status, 403);
    assert.equal((await react(other.bindings[0]!.agentId, ctx.token, messageId, "❌")).status, 403);
  });

  it("validates emoji input and accepts query-form deletions", async () => {
    const ctx = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    const messageId = "reaction-message-3";
    assert.equal((await react(agentId, ctx.token, messageId, "")).status, 400);
    assert.equal((await react(agentId, ctx.token, messageId, "x".repeat(17))).status, 400);
    assert.equal((await fetch(`${h.url}/api/zakurabot/agents/${agentId}/messages/${messageId}/reactions`,
      { method: "DELETE", headers: headers(ctx.token) })).status, 400);
    assert.equal((await react(agentId, ctx.token, messageId, "👍")).status, 201);
    const del = await fetch(`${h.url}/api/zakurabot/agents/${agentId}/messages/${messageId}/reactions?emoji=${encodeURIComponent("👍")}`,
      { method: "DELETE", headers: headers(ctx.token) });
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { removed: true });
  });
});
