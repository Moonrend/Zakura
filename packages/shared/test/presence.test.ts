import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PRESENCE_TTL_MS,
  activeSessionIds,
  mergePresenceByUser,
  othersOnProject,
  othersOnSession,
  pointerHiddenForView,
  remoteOnOtherSibling,
  remoteOnOtherVariant,
  sameCaretChannel,
  splitActiveSessions,
  type PresenceLocation,
} from "../src/presence.js";

function loc(partial: Partial<PresenceLocation> & Pick<PresenceLocation, "userId">): PresenceLocation {
  return {
    name: partial.userId,
    email: `${partial.userId}@x.test`,
    agentId: "ag",
    project: null,
    sessionId: "s1",
    pane: "chat",
    idle: false,
    ts: Date.now(),
    ...partial,
  };
}

describe("mergePresenceByUser", () => {
  it("同用户留最新", () => {
    const now = 1_000_000;
    const merged = mergePresenceByUser(
      [
        loc({ userId: "a", sessionId: "old", ts: now - 10 }),
        loc({ userId: "a", sessionId: "new", ts: now }),
        loc({ userId: "b", sessionId: "s2", ts: now }),
      ],
      now,
    );
    assert.equal(merged.length, 2);
    assert.equal(merged.find((p) => p.userId === "a")?.sessionId, "new");
  });

  it("丢掉过期", () => {
    const now = 1_000_000;
    const merged = mergePresenceByUser(
      [loc({ userId: "a", ts: now - PRESENCE_TTL_MS - 1 })],
      now,
    );
    assert.equal(merged.length, 0);
  });
});

describe("splitActiveSessions / pin", () => {
  it("有人在看的会话置顶且保持相对顺序", () => {
    const sessions = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const { active, rest } = splitActiveSessions(sessions, ["c", "a"]);
    assert.deepEqual(
      active.map((s) => s.id),
      ["a", "c"],
    );
    assert.deepEqual(
      rest.map((s) => s.id),
      ["b", "d"],
    );
  });
});

describe("othersOn*", () => {
  it("过滤自己和无关会话", () => {
    const peers = [
      loc({ userId: "me", sessionId: "s1" }),
      loc({ userId: "a", sessionId: "s1" }),
      loc({ userId: "b", sessionId: "s2" }),
    ];
    assert.deepEqual(
      othersOnSession(peers, "s1", "me").map((p) => p.userId),
      ["a"],
    );
  });

  it("项目外层聚合该项目下所有人", () => {
    const peers = [
      loc({ userId: "a", project: "p1", sessionId: "s1" }),
      loc({ userId: "b", project: "p1", sessionId: "s2" }),
      loc({ userId: "c", project: "p2", sessionId: "s3" }),
      loc({ userId: "me", project: "p1", sessionId: "s1" }),
    ];
    assert.deepEqual(
      othersOnProject(peers, "p1", "me").map((p) => p.userId).sort(),
      ["a", "b"],
    );
  });

  it("idle 不计入正在工作", () => {
    const peers = [
      loc({ userId: "a", sessionId: "s1", idle: true }),
      loc({ userId: "b", sessionId: "s2", idle: false }),
    ];
    assert.deepEqual([...activeSessionIds(peers, "me")], ["s2"]);
  });

  it("idle 不出现在会话/项目头像", () => {
    const peers = [
      loc({ userId: "a", sessionId: "s1", project: "p1", idle: true }),
      loc({ userId: "b", sessionId: "s1", project: "p1", idle: false }),
    ];
    assert.deepEqual(
      othersOnSession(peers, "s1", "me").map((p) => p.userId),
      ["b"],
    );
    assert.deepEqual(
      othersOnProject(peers, "p1", "me").map((p) => p.userId),
      ["b"],
    );
  });
});

describe("pointerHiddenForView / other page", () => {
  const turn = {
    seq: 10,
    messageId: "m1",
    parentKey: "p",
    runId: "r1",
    siblings: ["m1", "m2"],
    variants: ["r1", "r2"],
  };

  it("兄弟消息不同页：藏光标", () => {
    assert.equal(
      remoteOnOtherSibling([{ messageId: "m2", parentKey: "p", runId: "r1" }], turn),
      true,
    );
    assert.equal(
      pointerHiddenForView(
        { pointer: { seq: 99, x: 0, y: 0 }, view: [{ messageId: "m2", parentKey: "p", runId: "r1" }] },
        [turn],
      ),
      true,
    );
  });

  it("回答变体不同页：藏光标", () => {
    assert.equal(
      remoteOnOtherVariant([{ messageId: "m1", parentKey: "p", runId: "r2" }], turn),
      true,
    );
    assert.equal(
      pointerHiddenForView(
        { pointer: { seq: 10, x: 0.5, y: 0.5 }, view: [{ messageId: "m1", parentKey: "p", runId: "r2" }] },
        [turn],
      ),
      true,
    );
  });

  it("同一页仍画光标", () => {
    assert.equal(
      pointerHiddenForView(
        { pointer: { seq: 10, x: 0.5, y: 0.5 }, view: [{ messageId: "m1", parentKey: "p", runId: "r1" }] },
        [turn],
      ),
      false,
    );
  });
});

describe("sameCaretChannel", () => {
  it("缺省都算草稿", () => {
    assert.equal(sameCaretChannel(undefined, undefined), true);
    assert.equal(sameCaretChannel("draft", {}), true);
  });
  it("编辑中的草稿 caret 不混画", () => {
    assert.equal(sameCaretChannel("edit:m1", { channel: "draft" }), false);
    assert.equal(sameCaretChannel("edit:m1", { channel: "edit:m1" }), true);
    assert.equal(sameCaretChannel("edit:m1", { channel: "edit:m2" }), false);
  });
});
