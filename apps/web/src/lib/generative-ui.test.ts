import assert from "node:assert/strict";
import test from "node:test";
import { createUICompiler, splitUIContent, validateUISpec, validateStateForSpec, type UISpec } from "./generative-ui";
import { uiFunctions } from "./generative-ui-catalog";

const spec: UISpec = { catalogVersion: 1, state: { quantity: 2, price: 10, query: "" }, root: "main", elements: {
  main: { type: "Stack", props: {}, children: ["input", "total", "send"] },
  input: { type: "Input", props: { label: "数量", type: "number", value: { $bindState: "/quantity" } }, children: [] },
  total: { type: "Text", props: { text: { $computed: "calculate", args: { operation: "product", values: [{ $state: "/quantity" }, { $state: "/price" }] } } }, children: [] },
  send: { type: "Button", props: { label: "继续" }, children: [], on: { press: { action: "continueConversation", params: { message: "继续处理" } } } },
} };
const patches = [
  ...Object.entries(spec).filter(([key]) => key !== "elements").map(([key, value]) => ({ op: "add", path: `/${key}`, value })),
  { op: "add", path: "/elements", value: {} },
  ...Object.entries(spec.elements).map(([key, value]) => ({ op: "add", path: `/elements/${key}`, value })),
].map((patch) => JSON.stringify(patch)).join("\n") + "\n";

test("UI parser preserves Markdown and ignores literal nested fences", () => {
  const content = ["Before", "````markdown", "```json-render", "not a UI", "```", "````", "```json-render", JSON.stringify(spec), "```", "After"].join("\r\n");
  const parts = splitUIContent(content);
  assert.deepEqual(parts.map((part) => part.kind), ["text", "ui", "text"]);
  const ui = parts[1];
  if (ui?.kind !== "ui") throw new Error("UI missing");
  assert.equal(ui.closed, true);
  assert.equal(ui.blockIndex, 0);
  assert.match(parts[0]!.content, /not a UI/);
  assert.equal(parts[2]!.content, "After");
});

test("UI compiler renders complete JSON and streamed patches equivalently", () => {
  assert.deepEqual(createUICompiler().update(JSON.stringify(spec), true).spec, spec);
  for (const size of [1, 7, 31, 127]) {
    const compiler = createUICompiler();
    for (let offset = size; offset < patches.length; offset += size) {
      assert.equal(compiler.update(patches.slice(0, offset), false).error, undefined);
    }
    const final = compiler.update(patches, true);
    assert.equal(final.error, undefined);
    assert.deepEqual(final.spec, spec);
  }
});

test("UI reset replaces output instead of retaining an old spec", () => {
  const compiler = createUICompiler();
  compiler.update(patches, true);
  assert.equal(compiler.update("", false).spec, null);
  assert.equal(splitUIContent("```json-render\n{}")[0]?.kind, "ui");
});

test("UI rejects unknown behaviors, cyclic trees and prototype paths", () => {
  for (const change of [
    (s: UISpec) => { s.elements.main!.children = ["main"]; },
    (s: UISpec) => { s.elements.main!.type = "HTML"; },
    (s: UISpec) => { Object.assign(s.elements.main!, { watch: { "/quantity": { action: "continueConversation" } } }); },
    (s: UISpec) => { s.elements.send!.on = { press: { action: "fetch", params: {} } }; },
    (s: UISpec) => { s.elements.total!.props.text = { $computed: "eval", args: {} }; },
  ]) {
    const copy = structuredClone(spec); change(copy);
    assert.throws(() => validateUISpec(copy));
  }
  assert.ok(createUICompiler().update(patches + '{"op":"add","path":"/elements/__proto__","value":{}}', true).error);
  assert.ok(createUICompiler().update("x".repeat(131073), true).error);
});

test("UI saved state preserves declared field types", () => {
  validateStateForSpec({ quantity: 5, price: 12, query: "abc" }, spec);
  assert.throws(() => validateStateForSpec({ quantity: "5", price: 12, query: "abc" }, spec));
  assert.throws(() => validateStateForSpec({ quantity: 5, price: 12 }, spec));
});

test("UI local computations are bounded and do not execute code", () => {
  assert.equal(uiFunctions.calculate!({ operation: "product", values: [2, 10] }), 20);
  assert.equal(uiFunctions.calculate!({ operation: "divide", values: [2, 0] }), 0);
  assert.equal(uiFunctions.calculate!({ operation: "power", values: [1e300, 100] }), 0);
  assert.equal(uiFunctions.calculate!({ operation: "sum", values: [1e308] }), 1e308);
  assert.deepEqual(uiFunctions.filterRows!({ rows: [{ name: "Apple" }, { name: "Pear" }], query: "app" }), [{ name: "Apple" }]);
});
