import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PathJailError,
  resolveInRoot,
  scrubHostPathsInMessage,
  toApiPath,
  toWorkspacePath,
} from "../src/path-jail.js";

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

  it("strips /workspace and host root prefixes", () => {
    assert.equal(
      toWorkspacePath(root, resolveInRoot(root, "/workspace/lib/i18n.ts")),
      "lib/i18n.ts",
    );
    const hostAbs = join(root, "lib", "i18n.ts").replace(/\\/g, "/");
    assert.equal(toWorkspacePath(root, resolveInRoot(root, hostAbs)), "lib/i18n.ts");
  });

  it("scrubs host paths in error messages", () => {
    const msg = `ENOENT: no such file or directory, stat '${join(root, "lib", "a.ts")}'`;
    assert.match(scrubHostPathsInMessage(root, msg), /\/workspace/);
    assert.ok(!scrubHostPathsInMessage(root, msg).includes(root.replace(/\\/g, "/")));
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
