import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { textDiff } from "../src/text-diff.js";

describe("textDiff", () => {
  it("插入中间", () => {
    assert.deepEqual(textDiff("ab", "acb"), { start: 1, deleted: 0, inserted: "c" });
  });
  it("删除一段", () => {
    assert.deepEqual(textDiff("hello", "ho"), { start: 1, deleted: 3, inserted: "" });
  });
  it("替换", () => {
    assert.deepEqual(textDiff("cat", "cot"), { start: 1, deleted: 1, inserted: "o" });
  });
});
