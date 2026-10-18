import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement, createRef, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FluidHoverProvider, useFluidItem } from "../components/ui/fluid-hover.tsx";
import type { UseFluidHoverReturn } from "../hooks/use-fluid-hover.ts";

// Rendering exercises registration identities without a browser or DOM layout.
const hover = {} as UseFluidHoverReturn;
function Item({ index }: { index?: number }) {
  const ref = createRef<HTMLElement>();
  const itemIndex = useFluidItem(ref, index);
  return createElement("span", { "data-index": itemIndex });
}

function indexes(children: Parameters<typeof createElement>[2]) {
  const html = renderToStaticMarkup(createElement(FluidHoverProvider, { hover, children }));
  return Array.from(html.matchAll(/data-index="(\d+)"/g), (match) => Number(match[1]));
}

describe("fluid hover item identities", () => {
  it("allocates separate identities for items inside one wrapper", () => {
    assert.deepEqual(indexes(createElement("div", null,
      createElement(Item), createElement(Item), createElement(Item),
    )), [0, 1, 2]);
  });

  it("does not share an identity across fragments and nested groups", () => {
    assert.deepEqual(indexes(createElement(Fragment, null,
      createElement(Item),
      createElement("div", null, createElement(Item), createElement(Item)),
      createElement(Item),
    )), [0, 1, 2, 3]);
  });

  it("keeps a nested menu's identities in its own scope", () => {
    assert.deepEqual(indexes(createElement(Fragment, null,
      createElement(Item),
      createElement(FluidHoverProvider, { hover, children: createElement("div", null, createElement(Item), createElement(Item)) }),
      createElement(Item),
    )), [0, 0, 1, 1]);
  });

  it("honors explicit positional indexes used by radio groups", () => {
    assert.deepEqual(indexes(createElement("div", null,
      createElement(Item, { index: 2 }), createElement(Item, { index: 0 }),
    )), [2, 0]);
  });
});
