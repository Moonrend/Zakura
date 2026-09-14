import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
  after(() => rmSync(root, { recursive: true, force: true }));

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

  it("strips only one workspace prefix and respects path boundaries", () => {
    for (const path of ["workspace/a.txt", "/workspace/workspace/a.txt", join(root, "workspace/a.txt")]) {
      assert.equal(resolveInRoot(root, path), join(root, "workspace/a.txt"), path);
    }
    assert.equal(resolveInRoot(root, "/workspace-other/a.txt"), join(root, "workspace-other/a.txt"));
    assert.equal(resolveInRoot(root, "..notes/a.txt"), join(root, "..notes/a.txt"));
  });

  it("accepts equivalent file paths and in-workspace parent segments", () => {
    for (const path of ["shots/a.png", "/shots/a.png", "/workspace/shots/a.png", join(root, "shots/a.png"), "shots/old/../a.png"]) {
      assert.equal(resolveInRoot(root, path), join(root, "shots/a.png"), path);
    }
  });

  it("scrubs host paths in error messages", () => {
    const msg = `ENOENT: no such file or directory, stat '${join(root, "lib", "a.ts")}'`;
    assert.match(scrubHostPathsInMessage(root, msg), /\/workspace/);
    assert.ok(!scrubHostPathsInMessage(root, msg).includes(root.replace(/\\/g, "/")));
    assert.equal(
      scrubHostPathsInMessage(undefined, "open /srv/zakura/agents/a1/workspace/data/a.txt: missing"),
      "open /workspace/data/a.txt: missing",
    );
    assert.equal(
      scrubHostPathsInMessage(undefined, String.raw`open C:\data\agents\a1\workspace\a.txt: missing`),
      String.raw`open /workspace\a.txt: missing`,
    );
  });

  it("does not strip a workspace subdirectory that resembles a host storage layout", () => {
    const suffix = "/projects/agents/demo/workspace/a.txt";
    assert.equal(scrubHostPathsInMessage(root, `open ${root}${suffix}`), `open /workspace${suffix}`);
    assert.equal(scrubHostPathsInMessage(undefined, `open /workspace${suffix}`), `open /workspace${suffix}`);
  });

  it("rejects .. escape", () => {
    for (const path of ["../outside", "foo/../../outside", "/../outside", "/workspace/../outside", `${root}/../outside`, "..\\outside"]) {
      assert.throws(() => resolveInRoot(root, path), (err: unknown) => {
        assert.ok(err instanceof PathJailError);
        assert.ok(!err.message.includes(root), err.message);
        return true;
      }, path);
    }
    assert.throws(() => resolveInRoot(root, "a\0b"), PathJailError);
  });

  it("toApiPath uses leading slash", () => {
    const abs = resolveInRoot(root, "a/b.txt");
    assert.equal(toApiPath(root, abs), "/a/b.txt");
    assert.equal(toApiPath(root, root), "/");
  });
});
