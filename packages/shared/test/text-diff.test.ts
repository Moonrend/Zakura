import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shiftIndex, textDiff } from "../src/text-diff.js";

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

describe("shiftIndex", () => {
  it("改动之前的下标不动", () => {
    assert.equal(shiftIndex(2, 5, 1, 3), 2);
  });
  it("改动之后的下标按净增量平移", () => {
    assert.equal(shiftIndex(8, 5, 1, 3), 10);
    assert.equal(shiftIndex(8, 5, 3, 0), 5);
  });
  it("落在删除区间内则吸到插入末尾", () => {
    assert.equal(shiftIndex(6, 5, 3, 1), 6);
  });
});
