import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  bundlePaths,
  discoverFallbackManifests,
  discoverManifests,
  manifestDir,
} from "../src/services/skills/discover.js";
import { matchesRequested } from "../src/services/skills/fetch.js";

/** yetone/kill-ai-slop 的真实布局：技能放在 skill/（单数） */
const KILL_AI_SLOP = [
  ".github/workflows/deploy.yml",
  ".gitignore",
  "LICENSE",
  "README.md",
  "skill/README.md",
  "skill/SKILL.md",
  "skill/references/detection.md",
  "skill/references/fixes.md",
  "skill/scripts/scan.mjs",
  "website/package.json",
  "website/src/pages/index.astro",
];

const ANTHROPIC = [
  "README.md",
  "skills/docx/SKILL.md",
  "skills/docx/scripts/convert.py",
  "skills/pdf/SKILL.md",
  "skills/pdf/references/api.md",
];

describe("技能发现：目录布局", () => {
  it("skill/（单数）也能发现 SKILL.md", () => {
    assert.deepEqual(discoverManifests(KILL_AI_SLOP), ["skill/SKILL.md"]);
  });

  it("skills/ 下的多技能仓库全部发现", () => {
    assert.deepEqual(discoverManifests(ANTHROPIC), [
      "skills/docx/SKILL.md",
      "skills/pdf/SKILL.md",
    ]);
  });

  it("任意目录名都算数（不再依赖白名单）", () => {
    const paths = ["packages/agent/toolkit/SKILL.md", "docs/index.md"];
    assert.deepEqual(discoverManifests(paths), ["packages/agent/toolkit/SKILL.md"]);
  });

  it("仓库根 SKILL.md", () => {
    assert.deepEqual(discoverManifests(["SKILL.md", "README.md"]), ["SKILL.md"]);
    assert.equal(manifestDir("SKILL.md"), "");
  });

  it("大小写不敏感", () => {
    assert.deepEqual(discoverManifests(["my-skill/skill.md"]), ["my-skill/skill.md"]);
  });

  it("跳过依赖与构建产物", () => {
    const paths = [
      "node_modules/foo/SKILL.md",
      "dist/SKILL.md",
      ".venv/lib/SKILL.md",
      "skills/real/SKILL.md",
    ];
    assert.deepEqual(discoverManifests(paths), ["skills/real/SKILL.md"]);
  });

  it("技能内部的示例不算独立技能", () => {
    const paths = ["skills/a/SKILL.md", "skills/a/examples/nested/SKILL.md"];
    assert.deepEqual(discoverManifests(paths), ["skills/a/SKILL.md"]);
  });

  it("正规容器目录排在前面", () => {
    const paths = ["misc/tools/SKILL.md", "skills/first/SKILL.md"];
    assert.deepEqual(discoverManifests(paths), [
      "skills/first/SKILL.md",
      "misc/tools/SKILL.md",
    ]);
  });

  it("显式子路径只取该目录下的", () => {
    assert.deepEqual(discoverManifests(ANTHROPIC, "skills/pdf"), ["skills/pdf/SKILL.md"]);
    assert.deepEqual(discoverManifests(ANTHROPIC, "/skills/docx/"), ["skills/docx/SKILL.md"]);
    assert.deepEqual(discoverManifests(ANTHROPIC, "skills/none"), []);
  });

  it("显式指到某个 SKILL.md 文件", () => {
    assert.deepEqual(discoverManifests(ANTHROPIC, "skills/pdf/SKILL.md"), [
      "skills/pdf/SKILL.md",
    ]);
    assert.deepEqual(discoverManifests(ANTHROPIC, "skills/pdf/README.md"), []);
  });
});

describe("技能发现：单文件兜底", () => {
  it("skills/<name>.md 作为候选，并带上同名资源目录", () => {
    const paths = ["skills/writing.md", "skills/writing/references/style.md", "README.md"];
    const found = discoverFallbackManifests(paths);
    assert.deepEqual(found[0], {
      path: "skills/writing.md",
      fallbackName: "writing",
      bundleDir: "skills/writing",
    });
  });

  it("没有同名目录时不收捆绑资源", () => {
    const found = discoverFallbackManifests(["skills/writing.md"]);
    assert.equal(found[0]?.bundleDir, null);
  });

  it("skill/README.md 作为候选，技能名取目录名", () => {
    const found = discoverFallbackManifests(["skill/README.md", "README.md"]);
    assert.equal(found[0]?.path, "skill/README.md");
    assert.equal(found[0]?.fallbackName, "skill");
    assert.equal(found[0]?.bundleDir, "skill");
  });

  it("仓库根 README.md 兜底在最后", () => {
    const found = discoverFallbackManifests(["README.md"]);
    assert.deepEqual(found, [{ path: "README.md", fallbackName: "", bundleDir: "" }]);
  });

  it("显式指到 .md 文件时只认它", () => {
    const found = discoverFallbackManifests(["docs/guide.md", "README.md"], "docs/guide.md");
    assert.deepEqual(found, [
      { path: "docs/guide.md", fallbackName: "guide", bundleDir: null },
    ]);
  });

  it("不把 CHANGELOG/LICENSE 当技能", () => {
    const found = discoverFallbackManifests(["skills/CHANGELOG.md", "skills/LICENSE.md"]);
    assert.deepEqual(found, []);
  });
});

describe("-s/--skill 过滤", () => {
  const stitch = [
    "stitch::generate-design",
    "generate-design",
    "generate-design",
    "plugins/stitch-design/skills/generate-design",
    "plugins",
    "stitch-design",
    "skills",
    "generate-design",
  ];

  it("没有指定时全都要", () => {
    assert.equal(matchesRequested(undefined, "anything"), true);
    assert.equal(matchesRequested(["*"], "anything"), true);
  });

  it("按 frontmatter 名命中", () => {
    assert.equal(matchesRequested(["stitch::generate-design"], ...stitch), true);
  });

  it("按目录名命中", () => {
    assert.equal(matchesRequested(["generate-design"], ...stitch), true);
  });

  it("归一化后命中（冒号视作连字符）", () => {
    assert.equal(matchesRequested(["react:components"], "react-components"), true);
  });

  it("按路径中的插件目录整组命中", () => {
    assert.equal(matchesRequested(["stitch-design"], ...stitch), true);
  });

  it("不相干的名字不命中", () => {
    assert.equal(matchesRequested(["remotion"], ...stitch), false);
  });
});

describe("技能发现：捆绑文件", () => {  it("只收本技能目录下的文件", () => {
    const files = bundlePaths("skill", KILL_AI_SLOP, "skill/SKILL.md", ["skill"]);
    assert.deepEqual(files, [
      "skill/README.md",
      "skill/references/detection.md",
      "skill/references/fixes.md",
      "skill/scripts/scan.mjs",
    ]);
  });

  it("不吃掉嵌套的其他技能", () => {
    const paths = ["a/SKILL.md", "a/notes.md", "a/inner/SKILL.md", "a/inner/x.md"];
    const files = bundlePaths("a", paths, "a/SKILL.md", ["a", "a/inner"]);
    assert.deepEqual(files, ["a/notes.md"]);
  });

  it("根级技能只收公认的资源目录", () => {
    const paths = ["SKILL.md", "references/a.md", "scripts/b.sh", "src/app.ts", "README.md"];
    const files = bundlePaths("", paths, "SKILL.md", [""]);
    assert.deepEqual(files, ["references/a.md", "scripts/b.sh"]);
  });

  it("bundleDir 为 null 时不收任何文件", () => {
    assert.deepEqual(bundlePaths(null, KILL_AI_SLOP, "skills/x.md", []), []);
  });
});
