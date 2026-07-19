import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalWorkspaceFs, PathJailError } from "../src/local-workspace-fs.js";

describe("LocalWorkspaceFs", () => {
  it("write/read/list/mkdir/delete round-trip", async () => {
    const root = mkdtempSync(join(tmpdir(), "zakura-lfs-"));
    const fs = new LocalWorkspaceFs(root);

    await fs.mkdir("src");
    await fs.write("src/hello.txt", "world");
    const read = await fs.readText("src/hello.txt");
    assert.equal(read.content, "world");
    assert.ok(read.revision.startsWith("sha256:"));

    const listed = await fs.listDetailed("src");
    assert.ok(listed.entries.some((e) => e.name === "hello.txt"));

    await fs.deleteApi("src/hello.txt");
    assert.equal(await fs.exists("src/hello.txt"), false);

    await assert.rejects(() => fs.readText("../escape"), PathJailError);

    rmSync(root, { recursive: true, force: true });
  });
});
