import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  matchExcludePattern,
  shouldExcludePath,
  mergeExcludePatterns,
  exportWorkspace,
  importWorkspace,
  walkWorkspaceFiles,
} from "../src/migration-archive.js";
import { DEFAULT_MIGRATION_EXCLUDE_PATTERNS } from "@zakura/shared";

describe("exclude patterns", () => {
  it("matches node_modules directory tree", () => {
    assert.equal(matchExcludePattern("node_modules", "**/node_modules/"), true);
    assert.equal(matchExcludePattern("node_modules/pkg/index.js", "**/node_modules/"), true);
    assert.equal(matchExcludePattern("apps/web/node_modules/x", "**/node_modules/"), true);
    assert.equal(matchExcludePattern("src/index.ts", "**/node_modules/"), false);
  });

  it("matches .cache and dist", () => {
    assert.equal(matchExcludePattern(".cache/foo", ".cache/"), true);
    assert.equal(matchExcludePattern("pkg/dist/out.js", "**/dist/"), true);
  });

  it("mergeExcludePatterns includes defaults", () => {
    const merged = mergeExcludePatterns(["**/custom/"]);
    assert.ok(merged.includes("**/node_modules/"));
    assert.ok(merged.includes("**/custom/"));
    assert.ok(DEFAULT_MIGRATION_EXCLUDE_PATTERNS.every((p) => merged.includes(p)));
  });

  it("shouldExcludePath respects defaults", () => {
    const ex = mergeExcludePatterns();
    assert.equal(shouldExcludePath("node_modules/a/b.js", ex), true);
    assert.equal(shouldExcludePath("README.md", ex), false);
  });
});

describe("exportWorkspace → importWorkspace round-trip", () => {
  it("exports kept files, excludes node_modules, imports to new root, keeps source", async () => {
    const base = mkdtempSync(join(tmpdir(), "zakura-mig-"));
    const source = join(base, "source");
    const target = join(base, "target");
    mkdirSync(join(source, "src"), { recursive: true });
    mkdirSync(join(source, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(source, "README.md"), "# hello workspace\n", "utf8");
    writeFileSync(join(source, "src", "main.ts"), "export const n = 42;\n", "utf8");
    writeFileSync(
      join(source, "node_modules", "left-pad", "index.js"),
      "module.exports = () => {};\n",
      "utf8",
    );

    const walked = walkWorkspaceFiles(source, mergeExcludePatterns());
    const rels = walked.map((w) => w.relPath);
    assert.ok(rels.includes("README.md"));
    assert.ok(rels.includes("src/main.ts") || rels.includes(join("src", "main.ts").replace(/\\/g, "/")));
    assert.ok(!rels.some((r) => r.includes("node_modules")));

    const { archive, manifest, archiveSha256 } = await exportWorkspace({
      agentId: "agent_test_1",
      sourceNodeId: "node_a",
      workspaceRoot: source,
    });

    assert.ok(archive.length > 0);
    assert.equal(typeof archiveSha256, "string");
    assert.equal(archiveSha256.length, 64);
    assert.ok(manifest.files.some((f) => f.path === "README.md"));
    assert.ok(manifest.files.some((f) => f.path === "src/main.ts" || f.path.endsWith("main.ts")));
    assert.ok(!manifest.files.some((f) => f.path.includes("node_modules")));
    assert.ok(manifest.excludePatterns.includes("**/node_modules/"));

    // Source still present
    assert.equal(readFileSync(join(source, "README.md"), "utf8"), "# hello workspace\n");
    assert.ok(existsSync(join(source, "node_modules", "left-pad", "index.js")));

    const result = await importWorkspace({
      archive,
      targetWorkspaceRoot: target,
      atomic: true,
      expectedSha256: archiveSha256,
    });

    assert.equal(result.fileCount, manifest.fileCount);
    assert.equal(readFileSync(join(target, "README.md"), "utf8"), "# hello workspace\n");
    assert.equal(readFileSync(join(target, "src", "main.ts"), "utf8"), "export const n = 42;\n");
    assert.equal(existsSync(join(target, "node_modules")), false);

    // Source retained after successful import
    assert.equal(readFileSync(join(source, "README.md"), "utf8"), "# hello workspace\n");

    rmSync(base, { recursive: true, force: true });
  });

  it("rejects corrupt archive sha256", async () => {
    const base = mkdtempSync(join(tmpdir(), "zakura-mig-bad-"));
    const source = join(base, "source");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "a.txt"), "x", "utf8");
    const { archive } = await exportWorkspace({
      agentId: "a",
      sourceNodeId: "n",
      workspaceRoot: source,
    });
    await assert.rejects(
      () =>
        importWorkspace({
          archive,
          targetWorkspaceRoot: join(base, "t"),
          expectedSha256: "0".repeat(64),
        }),
      /sha256 mismatch/i,
    );
    rmSync(base, { recursive: true, force: true });
  });
});
