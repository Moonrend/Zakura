import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { textDiff } from "@zakura/shared";
import {
  applyYjsUpdate,
  subscribeYjs,
  unsubscribeYjs,
  yjsDiffAgainst,
} from "../src/realtime/yjs-sync.js";

describe("yjs draft convergence", () => {
  it("两份文档交叉插入收敛到同一字符串", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on("update", (u: Uint8Array) => Y.applyUpdate(b, u));
    b.on("update", (u: Uint8Array) => Y.applyUpdate(a, u));
    a.getText("draft").insert(0, "hello");
    b.getText("draft").insert(5, "!");
    a.getText("draft").insert(0, "go ");
    assert.equal(a.getText("draft").toString(), b.getText("draft").toString());
    assert.match(a.getText("draft").toString(), /hello/);
  });

  it("prefs map 交叉写入收敛", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on("update", (u: Uint8Array) => Y.applyUpdate(b, u));
    b.on("update", (u: Uint8Array) => Y.applyUpdate(a, u));
    a.getMap<string>("prefs").set("model", "gpt");
    b.getMap<string>("prefs").set("reasoning", "off");
    b.getMap<string>("prefs").set("pane", "files");
    assert.equal(a.getMap("prefs").get("model"), "gpt");
    assert.equal(b.getMap("prefs").get("model"), "gpt");
    assert.equal(a.getMap("prefs").get("reasoning"), "off");
    assert.equal(a.getMap("prefs").get("pane"), "files");
  });

  it("同一事务写入多个 prefs 键后对端一次就能读到", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on("update", (u: Uint8Array) => Y.applyUpdate(b, u));
    a.transact(() => {
      a.getMap<string>("prefs").set("model", "claude");
      a.getMap<string>("prefs").set("reasoning", "high");
    });
    assert.equal(b.getMap("prefs").get("model"), "claude");
    assert.equal(b.getMap("prefs").get("reasoning"), "high");
  });

  it("textDiff 驱动的局部更新与直接 insert 等价", () => {
    const doc = new Y.Doc();
    const text = doc.getText("draft");
    text.insert(0, "ab");
    const next = "acb";
    const { start, deleted, inserted } = textDiff(text.toString(), next);
    if (deleted) text.delete(start, deleted);
    if (inserted) text.insert(start, inserted);
    assert.equal(text.toString(), next);
  });
});

describe("yjs state vector 差量", () => {
  before(() => {
    process.env.REDIS_URL = "off";
  });

  it("后到者用 SV 只拿缺失更新", async () => {
    const sid = `sv-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const store = { getSession: async () => ({ id: sid, draftText: "ab" }) };
    const first = await subscribeYjs("t", "ag", sid, store);
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const client = new Y.Doc();
    Y.applyUpdate(client, first.update);
    assert.equal(client.getText("draft").toString(), "ab");

    let captured: Uint8Array | null = null;
    client.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin !== "remote") captured = u;
    });
    client.getText("draft").insert(2, "!");
    assert.ok(captured);
    applyYjsUpdate(sid, captured, "c1", store);

    const late = new Y.Doc();
    Y.applyUpdate(late, first.update);
    const sv = Y.encodeStateVector(late);
    const diff = yjsDiffAgainst(sid, sv);
    const full = yjsDiffAgainst(sid, null);
    assert.ok(diff && full);
    assert.ok(diff.update.byteLength < full.update.byteLength);
    Y.applyUpdate(late, diff.update);
    assert.equal(late.getText("draft").toString(), "ab!");

    const garbage = yjsDiffAgainst(sid, new Uint8Array([255, 255, 255]));
    assert.ok(garbage);
    const recovered = new Y.Doc();
    Y.applyUpdate(recovered, garbage.update);
    assert.equal(recovered.getText("draft").toString(), "ab!");

    unsubscribeYjs(sid, store);
  });
});
