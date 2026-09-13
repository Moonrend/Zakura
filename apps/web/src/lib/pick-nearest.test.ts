import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickNearest } from "./pick-nearest.ts";

const rects = [
  { top: 0, height: 32, left: 0, width: 200 },
  { top: 40, height: 32, left: 0, width: 200 },
  { top: 80, height: 32, left: 0, width: 200 },
];
const frame = {
  rects,
  containerRect: { left: 0, top: 0, width: 200, height: 112 },
  scroll: { x: 0, y: 0 },
  border: { x: 0, y: 0 },
  layoutSize: { width: 200, height: 112 },
};

describe("pickNearest", () => {
  it("picks the row whose center is closest on the y axis", () => {
    assert.equal(pickNearest({ ...frame, axis: "y", point: { x: 20, y: 16 } }), 0);
    assert.equal(pickNearest({ ...frame, axis: "y", point: { x: 20, y: 56 } }), 1);
    assert.equal(pickNearest({ ...frame, axis: "y", point: { x: 20, y: 120 } }), 2);
  });

  it("prefers the smallest row when a parent rect covers nested children", () => {
    const nested = {
      rects: [
        { top: 0, height: 160, left: 0, width: 200 },
        { top: 40, height: 32, left: 16, width: 168 },
        { top: 80, height: 32, left: 16, width: 168 },
        { top: 120, height: 32, left: 16, width: 168 },
      ],
      containerRect: { left: 0, top: 0, width: 200, height: 160 },
      scroll: { x: 0, y: 0 },
      border: { x: 0, y: 0 },
      layoutSize: { width: 200, height: 160 },
    };
    assert.equal(pickNearest({ ...nested, axis: "y", point: { x: 20, y: 16 } }), 0);
    assert.equal(pickNearest({ ...nested, axis: "y", point: { x: 20, y: 56 } }), 1);
    assert.equal(pickNearest({ ...nested, axis: "y", point: { x: 20, y: 96 } }), 2);
    assert.equal(pickNearest({ ...nested, axis: "y", point: { x: 20, y: 136 } }), 3);
  });
});
