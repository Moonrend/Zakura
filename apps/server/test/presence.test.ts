import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  removePresence,
  snapshotPresence,
  upsertPresence,
} from "../src/realtime/presence.js";

describe("presence hub", () => {
  before(() => {
    process.env.REDIS_URL = "off";
  });

  it("join / 更新 / leave", async () => {
    const tenant = "t-presence";
    await upsertPresence(tenant, "sock-a", "u1", {
      name: "A",
      email: "a@t.test",
      sessionId: "s1",
      agentId: "ag",
      filePath: "/projects/demo/a.ts",
    });
    await upsertPresence(tenant, "sock-b", "u2", {
      name: "B",
      email: "b@t.test",
      sessionId: "s2",
      agentId: "ag",
    });
    let snap = await snapshotPresence(tenant);
    assert.equal(snap.length, 2);
    assert.equal(snap.find((p) => p.userId === "u1")?.sessionId, "s1");
    assert.equal(snap.find((p) => p.userId === "u1")?.filePath, "/projects/demo/a.ts");

    await upsertPresence(tenant, "sock-a", "u1", { sessionId: "s9" });
    snap = await snapshotPresence(tenant);
    assert.equal(snap.find((p) => p.userId === "u1")?.sessionId, "s9");

    const left = await removePresence(tenant, "sock-a");
    assert.equal(left.leftUserId, "u1");
    snap = await snapshotPresence(tenant);
    assert.deepEqual(
      snap.map((p) => p.userId),
      ["u2"],
    );
    await removePresence(tenant, "sock-b");
  });

  it("同用户多连接 leave 一个仍在", async () => {
    const tenant = "t-multi";
    await upsertPresence(tenant, "s1", "u1", { name: "A", sessionId: "a" });
    await upsertPresence(tenant, "s2", "u1", { name: "A", sessionId: "b" });
    const left = await removePresence(tenant, "s1");
    assert.equal(left.leftUserId, null);
    const snap = await snapshotPresence(tenant);
    assert.equal(snap.length, 1);
    assert.equal(snap[0]?.sessionId, "b");
    await removePresence(tenant, "s2");
  });

  it("api-key 不进入 presence", async () => {
    const loc = await upsertPresence("t", "sock", "api-key", { name: "k" });
    assert.equal(loc, null);
  });
});
