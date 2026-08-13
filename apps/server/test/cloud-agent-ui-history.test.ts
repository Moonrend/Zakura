/**
 * 长对话 UI 空屏回归：尾窗截断与 orphan parent 重挂。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  reattachOrphanUserRoots,
  sliceEventsPreferringUserMessage,
  slimToolEventsForUi,
} from "../src/services/cloud-agent/ui-history.js";

describe("ui-history window", () => {
  it("sliceEventsPreferringUserMessage keeps a user_message when tail is pure noise", () => {
    const events = [
      { type: "user_message", seq: 1 },
      { type: "run_start", seq: 2 },
      ...Array.from({ length: 600 }, (_, i) => ({
        type: "assistant_delta",
        seq: 3 + i,
      })),
    ];
    const defaultTail = events.slice(-500);
    assert.equal(defaultTail.some((e) => e.type === "user_message"), false);

    const forUi = sliceEventsPreferringUserMessage(events, 500);
    assert.ok(forUi.some((e) => e.type === "user_message"));
    assert.equal(forUi[0]?.type, "user_message");
  });

  it("reattachOrphanUserRoots promotes truncated parents so turns are not empty", () => {
    const userMsgs = new Map([
      ["m2", { id: "m2", parentKey: "missing-run", seq: 10 }],
      ["m3", { id: "m3", parentKey: "run-in-window", seq: 20 }],
    ]);
    reattachOrphanUserRoots(userMsgs, ["", "run-in-window"]);
    assert.equal(userMsgs.get("m2")!.parentKey, "");
    assert.equal(userMsgs.get("m3")!.parentKey, "run-in-window");
  });

  it("slice keeps boundary for paging: older page must still surface user_message", () => {
    const olderPage = [
      { type: "user_message", seq: 1 },
      { type: "assistant_message", seq: 2 },
      ...Array.from({ length: 80 }, (_, i) => ({
        type: "assistant_delta",
        seq: 3 + i,
      })),
    ];
    const page = sliceEventsPreferringUserMessage(olderPage, 40);
    assert.ok(page.some((e) => e.type === "user_message"));
  });

  it("slimToolEventsForUi keeps first tool full and marks later tools detailPending", () => {
    const base = {
      id: "e",
      sessionId: "s",
      runId: "r",
      createdAt: new Date().toISOString(),
    };
    const events = [
      { ...base, id: "1", seq: 1, type: "tool_call_start" as const, payload: { toolCallId: "t1", name: "fs_read" } },
      { ...base, id: "2", seq: 2, type: "tool_call_args" as const, payload: { toolCallId: "t1", arguments: '{"path":"a"}' } },
      {
        ...base,
        id: "3",
        seq: 3,
        type: "tool_call_result" as const,
        payload: { toolCallId: "t1", name: "fs_read", isError: false, resultText: "ok", durationMs: 1 },
      },
      { ...base, id: "4", seq: 4, type: "tool_call_start" as const, payload: { toolCallId: "t2", name: "fs_write" } },
      { ...base, id: "5", seq: 5, type: "tool_call_args" as const, payload: { toolCallId: "t2", arguments: '{"path":"b"}' } },
      {
        ...base,
        id: "6",
        seq: 6,
        type: "tool_call_result" as const,
        payload: {
          toolCallId: "t2",
          name: "fs_write",
          isError: false,
          resultText: "big".repeat(100),
          durationMs: 2,
        },
      },
      {
        ...base,
        id: "7",
        seq: 7,
        type: "assistant_message" as const,
        payload: { messageId: "m", content: "done" },
      },
    ];
    const slim = slimToolEventsForUi(events as never);
    assert.ok(slim.some((e) => e.type === "tool_call_args" && (e.payload as { toolCallId: string }).toolCallId === "t1"));
    assert.equal(
      slim.some((e) => e.type === "tool_call_args" && (e.payload as { toolCallId: string }).toolCallId === "t2"),
      false,
    );
    const t2 = slim.find(
      (e) => e.type === "tool_call_result" && (e.payload as { toolCallId: string }).toolCallId === "t2",
    );
    assert.equal((t2?.payload as { detailPending?: boolean }).detailPending, true);
  });
});
