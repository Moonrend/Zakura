import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathJailError, resolveInRoot, toApiPath, toWorkspacePath } from "../src/path-jail.js";

describe("resolveInRoot path jail", () => {
  const root = mkdtempSync(join(tmpdir(), "zakura-jail-"));

  it("resolves relative paths inside root", () => {
    const abs = resolveInRoot(root, "src/main.ts");
    assert.ok(abs.startsWith(root) || abs.replace(/\\/g, "/").includes(root.replace(/\\/g, "/")));
    assert.ok(abs.endsWith(join("src", "main.ts")) || abs.replace(/\\/g, "/").endsWith("src/main.ts"));
  });

  it("treats leading slash as workspace-relative", () => {
    const abs = resolveInRoot(root, "/README.md");
    assert.equal(toWorkspacePath(root, abs), "README.md");
  });

  it("rejects .. escape", () => {
    assert.throws(() => resolveInRoot(root, "../outside"), PathJailError);
    assert.throws(() => resolveInRoot(root, "foo/../../outside"), PathJailError);
  });

  it("toApiPath uses leading slash", () => {
    const abs = resolveInRoot(root, "a/b.txt");
    assert.equal(toApiPath(root, abs), "/a/b.txt");
    assert.equal(toApiPath(root, root), "/");
  });
});
