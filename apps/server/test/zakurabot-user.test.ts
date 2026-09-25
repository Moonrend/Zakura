import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { newId } from "../src/db/schema.js";
import { agents } from "../src/db/schema.js";
import { within, zakurabotHarness } from "./helpers/zakurabot.js";

describe("Zakura Bot user access", () => {
  let h: Awaited<ReturnType<typeof zakurabotHarness>>;
  before(async () => { h = await zakurabotHarness(); });
  after(async () => { await h?.close(); });

  it("connects an empty tenant and automatically covers newly created agents", async () => {
    const ctx = await h.access(0);
    const socket = await h.connect(ctx.token);
    const ready = await socket.wait("ready");
    assert.deepEqual(ready.agents, [], "an empty tenant connects with an empty roster");

    const id = newId();
    await h.db.insert(agents).values({ id, tenantId: ctx.tenantId, name: "Fresh", slug: id,
      status: "ready", configJson: "{}" });
    await h.gateway.refresh();
    const roster = await socket.wait("agents", (frame) => frame.agents.some((agent) => agent.id === id));
    const entry = roster.agents.find((agent) => agent.id === id)!;
    assert.ok(entry.bindingId, "the new agent gets an auto-provisioned channel binding");
    assert.equal(entry.capabilities?.files, false, "capabilities follow the agent's own flags");

    socket.send({ type: "send", agentId: id, clientMessageId: "fresh-send", text: "hello" });
    await socket.wait("message");
    const list = await (await fetch(`${h.url}/api/zakurabot/agents`, {
      headers: { authorization: `Bearer ${ctx.token}` } })).json() as { agents: { id: string }[] };
    assert.ok(list.agents.some((agent) => agent.id === id));
    await within(socket.close());
  });

  it("upgrades device-era restrictive bindings to open ACLs on first use", async () => {
    const ctx = await h.access(1);
    const socket = await h.connect(ctx.token);
    await socket.wait("ready");
    const settings = await h.ingress.getSettings(ctx.tenantId, ctx.bindings[0]!.id);
    assert.equal(settings?.allowAll, true, "the user session replaces the device allowlist");
    await within(socket.close());
  });
});
