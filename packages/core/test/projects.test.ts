import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isSafeGitRemoteUrl,
  isValidProjectSlug,
  parseProjectField,
  projectDefaultWorkingDir,
  projectSlugsFromList,
  projectWorkspacePath,
} from "@zakura/shared";
import { LocalWorkspaceFs, ensureWorkspaceDir } from "../src/local-workspace-fs.js";

describe("workspace projects", () => {
  it("validates slugs and rejects hidden / traversal names", () => {
    assert.equal(isValidProjectSlug("foo"), true);
    assert.equal(isValidProjectSlug("my-app.v2"), true);
    assert.equal(isValidProjectSlug("A_b-1"), true);
    assert.equal(isValidProjectSlug(".hidden"), false);
    assert.equal(isValidProjectSlug(".."), false);
    assert.equal(isValidProjectSlug("foo/bar"), false);
    assert.equal(isValidProjectSlug(""), false);
    assert.equal(isValidProjectSlug("-nope"), false);
  });

  it("parseProjectField distinguishes omit / unbind / slug", () => {
    assert.deepEqual(parseProjectField(undefined), { status: "omit" });
    assert.deepEqual(parseProjectField(null), { status: "ok", slug: null });
    assert.deepEqual(parseProjectField(""), { status: "ok", slug: null });
    assert.deepEqual(parseProjectField("  demo  "), { status: "ok", slug: "demo" });
    assert.equal(parseProjectField("../x").status, "invalid");
  });

  it("lists only valid project directories", () => {
    assert.deepEqual(
      projectSlugsFromList([
        { name: "app", type: "dir" },
        { name: ".cache", type: "dir" },
        { name: "readme.md", type: "file" },
        { name: "ok_2", isDir: true },
        { name: "..", type: "dir" },
      ]),
      ["app", "ok_2"],
    );
  });

  it("default cwd is project path when bound, workspace root otherwise", () => {
    assert.equal(projectDefaultWorkingDir("foo"), "/workspace/projects/foo");
    assert.equal(projectWorkspacePath("foo"), "/workspace/projects/foo");
    assert.equal(projectDefaultWorkingDir(null), "/workspace");
    assert.equal(projectDefaultWorkingDir(undefined), "/workspace");
    assert.equal(projectDefaultWorkingDir("../x"), "/workspace");
  });

  it("rejects unsafe git remotes", () => {
    assert.equal(isSafeGitRemoteUrl("https://github.com/a/b.git"), true);
    assert.equal(isSafeGitRemoteUrl("git@github.com:a/b.git"), true);
    assert.equal(isSafeGitRemoteUrl("file:///etc/passwd"), false);
    assert.equal(isSafeGitRemoteUrl("https://evil.test/repo.git; rm -rf /"), false);
  });

  it("ensureWorkspaceDir creates layout dirs including projects/", async () => {
    const root = mkdtempSync(join(tmpdir(), "zakura-projects-"));
    try {
      ensureWorkspaceDir(root);
      for (const dir of ["projects", "data", "outputs", "uploads", "skills"]) {
        assert.equal(existsSync(join(root, dir)), true, dir);
      }
      mkdirSync(join(root, "projects", "demo"));
      mkdirSync(join(root, "projects", ".hidden"));
      writeFileSync(join(root, "projects", "note.txt"), "x");
      const fs = new LocalWorkspaceFs(root);
      const listed = await fs.list("projects");
      assert.deepEqual(projectSlugsFromList(listed.entries), ["demo"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
