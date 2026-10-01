import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ZakurabotStoredFrame } from "../src/services/zakurabot-protocol.js";
import { zakurabotHarness } from "./helpers/zakurabot.js";

describe("Zakura Bot history cursor pagination", () => {
  let h: Awaited<ReturnType<typeof zakurabotHarness>>;
  let agentId = "";
  let token = "";

  const message = (id: string, agent: string, text: string, createdAt: number): ZakurabotStoredFrame =>
    ({ type: "message", message: { id, agentId: agent, role: "user", kind: "text", text, clientMessageId: id, createdAt } });

  before(async () => {
    h = await zakurabotHarness();
    const ctx = await h.access();
    token = ctx.token;
    const binding = ctx.bindings[0]!;
    agentId = binding.agentId;
    const conversation = { tenantId: ctx.tenantId, deviceId: ctx.userId, bindingId: binding.id, agentId: binding.agentId };
    for (let i = 1; i <= 5; i++) {
      await h.store.appendMessage(conversation, message(`msg-${i}`, binding.agentId, `Message ${i}`, i));
    }
  });
  after(async () => { await h?.close(); });

  async function hist(query = "") {
    const response = await fetch(`${h.url}/api/zakurabot/agents/${agentId}/history${query}`,
      { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    return await response.json() as {
      items: Array<{ seq: number; frame: { message?: { text: string } } }>;
      nextBefore: number | null;
    };
  }

  it("returns the latest page with a cursor to older messages", async () => {
    const all = await hist("?limit=100");
    assert.equal(all.items.length, 5);
    assert.equal(all.nextBefore, null, "a complete history has nothing older to page to");
    assert.deepEqual(all.items.map((item) => item.frame.message?.text),
      ["Message 1", "Message 2", "Message 3", "Message 4", "Message 5"]);
    assert.ok(all.items.every((item, index, rows) => index === 0 || item.seq > rows[index - 1]!.seq),
      "items are returned in ascending seq order");

    const page = await hist("?limit=2");
    assert.deepEqual(page.items.map((item) => item.frame.message?.text), ["Message 4", "Message 5"]);
    assert.equal(page.nextBefore, page.items[0]!.seq);
  });

  it("returns the N messages immediately older than before, in ascending order", async () => {
    const first = await hist("?limit=2");
    const older = await hist(`?limit=2&before=${first.nextBefore}`);
    assert.deepEqual(older.items.map((item) => item.frame.message?.text), ["Message 2", "Message 3"]);
    assert.equal(older.nextBefore, older.items[0]!.seq);

    const oldest = await hist(`?limit=2&before=${older.nextBefore}`);
    assert.deepEqual(oldest.items.map((item) => item.frame.message?.text), ["Message 1"]);
    assert.equal(oldest.nextBefore, null, "the first page has no older cursor");
  });

  it("returns an empty page when before predates the oldest message", async () => {
    const all = await hist("?limit=100");
    const beyond = await hist(`?limit=2&before=${all.items[0]!.seq}`);
    assert.deepEqual(beyond.items, []);
    assert.equal(beyond.nextBefore, null);
  });
});
