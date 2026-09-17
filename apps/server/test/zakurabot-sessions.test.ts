import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { zakurabotHarness } from "./helpers/zakurabot.js";

describe("Zakura Bot session management", () => {
  let h: Awaited<ReturnType<typeof zakurabotHarness>>;
  before(async () => { h = await zakurabotHarness(); });
  after(async () => { await h?.close(); });
  it("starts an authorized session, stops its run, and resets context without discarding channel history", async () => {
    const ctx = await h.access(), other = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    const endpoint = `${h.url}/api/zakurabot/sessions/${agentId}`;
    const get = (token = ctx.token) => fetch(endpoint, { headers: { authorization: `Bearer ${token}` } });
    const act = (action: string) => fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${ctx.token}`, "content-type": "application/json" }, body: JSON.stringify({ action }) });
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await get(other.token)).status, 403);
    assert.equal((await (await get()).json()).session.status, "not_started");
    assert.equal((await act("invalid")).status, 400);
    const started = (await (await act("start")).json()).session;
    assert.equal(started.status, "ready");
    assert.equal(started.bindingId, ctx.bindings[0]!.id);
    assert.equal((await (await act("start")).json()).session.sessionId, started.sessionId);
    const socket = await h.connect(ctx.token);
    await socket.wait("ready");
    socket.send({ type: "send", agentId, clientMessageId: "old-context", text: "Hello from the old context" });
    const run = await h.waitForRun("old-context");
    assert.equal(run.sessionId, started.sessionId);
    assert.equal((await (await get()).json()).session.status, "busy");
    assert.equal((await (await act("stop")).json()).session.status, "ready");
    const fresh = (await (await act("new")).json()).session;
    assert.notEqual(fresh.sessionId, started.sessionId);
    socket.send({ type: "send", agentId, clientMessageId: "fresh-context", text: "Use the new context" });
    assert.equal((await h.waitForRun("fresh-context")).sessionId, fresh.sessionId);
    const restored = await h.connect(ctx.token);
    await restored.wait("ready");
    assert.equal((await restored.wait("message", (frame) => frame.message.id === "old-context")).message.text, "Hello from the old context");
  });
});
