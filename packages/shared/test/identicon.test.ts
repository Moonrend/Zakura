import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hash32, identiconFromId, identiconColor } from "../src/identicon.js";

describe("identicon", () => {
  it("同一 id 稳定", () => {
    const a = identiconFromId("user-abc");
    const b = identiconFromId("user-abc");
    assert.equal(a.color, b.color);
    assert.deepEqual(a.cells, b.cells);
    assert.equal(a.cells.length, 25);
  });

  it("左右镜像", () => {
    const { cells } = identiconFromId("mirror-check");
    for (let y = 0; y < 5; y++) {
      assert.equal(cells[y * 5 + 0], cells[y * 5 + 4]);
      assert.equal(cells[y * 5 + 1], cells[y * 5 + 3]);
    }
  });

  it("不同 id 通常不同", () => {
    const a = identiconFromId("alice");
    const b = identiconFromId("bob");
    assert.notEqual(hash32("alice"), hash32("bob"));
    const same =
      a.color === b.color && a.cells.every((c, i) => c === b.cells[i]);
    assert.equal(same, false);
  });

  it("identiconColor 与格子同色", () => {
    assert.equal(identiconColor("u1"), identiconFromId("u1").color);
  });
});
