import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyComposerSlash,
  filterComposerSlashItems,
  parseComposerSlash,
} from "./composer-slash";

describe("parseComposerSlash", () => {
  it("reads a leading slash on the last line", () => {
    assert.deepEqual(parseComposerSlash("/rev"), {
      from: 0,
      to: 4,
      query: "rev",
    });
    assert.deepEqual(parseComposerSlash("hello\n/comp"), {
      from: 6,
      to: 11,
      query: "comp",
    });
  });

  it("closes once the user starts typing arguments", () => {
    assert.equal(parseComposerSlash("/review files"), null);
    assert.equal(parseComposerSlash("plain text"), null);
    assert.equal(parseComposerSlash(""), null);
  });
});

describe("filterComposerSlashItems", () => {
  const items = [
    { id: "1", name: "review", description: "Review the diff", kind: "command" as const },
    { id: "2", name: "compact", description: "Shrink context", kind: "command" as const },
  ];

  it("filters by name or description", () => {
    assert.deepEqual(
      filterComposerSlashItems(items, "rev").map((i) => i.name),
      ["review"],
    );
    assert.deepEqual(
      filterComposerSlashItems(items, "context").map((i) => i.name),
      ["compact"],
    );
    assert.equal(filterComposerSlashItems(items, "").length, 2);
  });
});

describe("applyComposerSlash", () => {
  it("replaces the draft token with /name plus a trailing space", () => {
    const draft = parseComposerSlash("note\n/re");
    assert.ok(draft);
    assert.equal(applyComposerSlash("note\n/re", draft, "review"), "note\n/review ");
  });
});
