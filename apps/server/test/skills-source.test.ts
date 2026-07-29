import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildSkillMarkdown,
  normalizeSkillName,
  parseSkillMarkdown,
  parseSkillSource,
  skillSourceToSpec,
} from "../src/services/skills/source.ts";
import { SkillSourceError } from "../src/services/skills/source.ts";
import { BUILTIN_SKILLS, builtinToPackage } from "../src/services/skills/builtin.ts";

describe("skill source: npx 命令解析", () => {
  it("解析基础 npx skills add", () => {
    const s = parseSkillSource("npx skills add vercel-labs/agent-skills");
    assert.equal(s.kind, "github");
    assert.equal(s.owner, "vercel-labs");
    assert.equal(s.repo, "agent-skills");
    assert.equal(s.skills, undefined);
  });

  it("解析 --skill 多值与重复 flag", () => {
    const s = parseSkillSource(
      "npx skills add vercel-labs/agent-skills --skill frontend-design --skill skill-creator",
    );
    assert.deepEqual(s.skills, ["frontend-design", "skill-creator"]);
    assert.equal(s.repo, "agent-skills");
  });

  it("解析变长 -s a b 形式", () => {
    const s = parseSkillSource("npx skills add owner/repo -s alpha beta");
    assert.deepEqual(s.skills, ["alpha", "beta"]);
    assert.equal(s.owner, "owner");
  });

  it("来源被变长 flag 吞掉时能救回来", () => {
    const s = parseSkillSource("npx skills add --skill alpha owner/repo");
    assert.equal(s.owner, "owner");
    assert.equal(s.repo, "repo");
    assert.deepEqual(s.skills, ["alpha"]);
  });

  it("忽略布尔 flag 与 agent 选择", () => {
    const s = parseSkillSource("npx skills add owner/repo -g -y --copy -a claude-code -a codex");
    assert.equal(s.owner, "owner");
    assert.equal(s.skills, undefined);
  });

  it("--all 等价于全部技能", () => {
    const s = parseSkillSource("npx skills add owner/repo --all");
    assert.deepEqual(s.skills, ["*"]);
  });

  it("支持 --skill=value 写法", () => {
    const s = parseSkillSource("npx skills add owner/repo --skill=alpha");
    assert.deepEqual(s.skills, ["alpha"]);
  });

  it("支持 npx -y skills@latest 与 pnpm dlx / bunx", () => {
    for (const cmd of [
      "npx -y skills@latest add owner/repo",
      "pnpm dlx skills add owner/repo",
      "bunx skills add owner/repo",
      "yarn dlx skills add owner/repo",
    ]) {
      const s = parseSkillSource(cmd);
      assert.equal(s.owner, "owner", cmd);
      assert.equal(s.repo, "repo", cmd);
    }
  });

  it("skills use + 管道到 claude", () => {
    const s = parseSkillSource(
      "npx skills use vercel-labs/agent-skills@web-design-guidelines | claude",
    );
    assert.equal(s.repo, "agent-skills");
    assert.deepEqual(s.skills, ["web-design-guidelines"]);
  });

  it("多行粘贴取第一条有效命令", () => {
    const s = parseSkillSource("# 安装方式\n\n$ npx skills add owner/repo\n\n然后重启");
    assert.equal(s.owner, "owner");
  });
});

describe("skill source: URL 与简写", () => {
  it("owner/repo@skill", () => {
    const s = parseSkillSource("vercel-labs/agent-skills@frontend-design");
    assert.deepEqual(s.skills, ["frontend-design"]);
    assert.equal(s.repo, "agent-skills");
  });

  it("owner/repo#ref", () => {
    const s = parseSkillSource("owner/repo#next");
    assert.equal(s.ref, "next");
    assert.equal(s.repo, "repo");
  });

  it("技能名含冒号（skills.sh 的命名空间写法）", () => {
    const s = parseSkillSource("google-labs-code/stitch-skills@react:components");
    assert.equal(s.repo, "stitch-skills");
    assert.deepEqual(s.skills, ["react:components"]);
    assert.equal(normalizeSkillName("react:components"), "react-components");
  });

  it("scp 地址不会被误当成 owner/repo@skill", () => {
    const s = parseSkillSource("git@github.com:owner/repo.git");
    assert.equal(s.owner, "owner");
    assert.equal(s.repo, "repo");
    assert.equal(s.skills, undefined);
  });

  it("域名托管的技能给出可操作的报错", () => {
    assert.throws(
      () => parseSkillSource("uizze.com@anti-ui-slop"),
      /域名托管/,
    );
  });

  it("GitHub tree URL 带分支与子路径", () => {
    const s = parseSkillSource(
      "https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines",
    );
    assert.equal(s.ref, "main");
    assert.equal(s.path, "skills/web-design-guidelines");
  });

  it("GitHub blob 指向 SKILL.md 时取其目录", () => {
    const s = parseSkillSource(
      "https://github.com/owner/repo/blob/main/skills/foo/SKILL.md",
    );
    assert.equal(s.path, "skills/foo");
  });

  it("raw.githubusercontent SKILL.md", () => {
    const s = parseSkillSource(
      "https://raw.githubusercontent.com/owner/repo/abc123/skills/foo/SKILL.md",
    );
    assert.equal(s.kind, "github");
    assert.equal(s.ref, "abc123");
    assert.equal(s.path, "skills/foo");
  });

  it("scp 形式的 git 地址", () => {
    const s = parseSkillSource("git@github.com:vercel-labs/agent-skills.git");
    assert.equal(s.kind, "github");
    assert.equal(s.repo, "agent-skills");
  });

  it("GitLab 项目与子路径", () => {
    const s = parseSkillSource("https://gitlab.com/org/repo/-/tree/main/skills");
    assert.equal(s.kind, "gitlab");
    assert.equal(s.owner, "org");
    assert.equal(s.repo, "repo");
    assert.equal(s.ref, "main");
    assert.equal(s.path, "skills");
  });

  it("skills.sh 详情页", () => {
    const s = parseSkillSource("https://skills.sh/vercel-labs/agent-skills/frontend-design");
    assert.equal(s.kind, "github");
    assert.equal(s.store, "skills-sh");
    assert.deepEqual(s.skills, ["frontend-design"]);
  });

  it("任意 Markdown 直链", () => {
    const s = parseSkillSource("https://example.com/docs/my-skill.md");
    assert.equal(s.kind, "url");
    assert.equal(s.url, "https://example.com/docs/my-skill.md");
  });

  it("内置技能", () => {
    const s = parseSkillSource("builtin:find-skills");
    assert.equal(s.kind, "builtin");
    assert.equal(s.builtinId, "find-skills");
  });

  it("无法识别时抛 SkillSourceError", () => {
    assert.throws(() => parseSkillSource("这是一句话"), SkillSourceError);
    assert.throws(() => parseSkillSource(""), SkillSourceError);
  });

  it("规范串可回环解析", () => {
    const s = parseSkillSource("https://github.com/owner/repo/tree/dev/skills/foo");
    const spec = skillSourceToSpec(s, "foo");
    const round = parseSkillSource(spec);
    assert.equal(round.owner, "owner");
    assert.equal(round.repo, "repo");
    assert.equal(round.ref, "dev");
    assert.deepEqual(round.skills, ["foo"]);
  });
});

describe("SKILL.md frontmatter", () => {
  it("解析标量与正文", () => {
    const { frontmatter, body } = parseSkillMarkdown(
      "---\nname: my-skill\ndescription: 做某事时使用\n---\n\n# 标题\n\n正文",
    );
    assert.equal(frontmatter.name, "my-skill");
    assert.equal(frontmatter.description, "做某事时使用");
    assert.match(body, /^# 标题/);
  });

  it("解析块级列表", () => {
    const { frontmatter } = parseSkillMarkdown(
      "---\nname: x\ndescription: d\nallowed-tools:\n  - Read\n  - Write\n---\n正文",
    );
    assert.deepEqual(frontmatter["allowed-tools"], ["Read", "Write"]);
  });

  it("解析块标量：| 保留换行", () => {
    const { frontmatter, body } = parseSkillMarkdown(
      [
        "---",
        "name: demo",
        "description: |-",
        "  第一行",
        "  第二行",
        "version: v1.0",
        "---",
        "正文",
      ].join("\n"),
    );
    assert.equal(frontmatter.description, "第一行\n第二行");
    assert.equal(frontmatter.version, "v1.0");
    assert.equal(body.trim(), "正文");
  });

  it("解析块标量：> 折叠成空格，空行分段", () => {
    const { frontmatter } = parseSkillMarkdown(
      [
        "---",
        "name: demo",
        "description: >-",
        "  Find and remove AI slop from a web",
        "  project. Use when the user asks.",
        "",
        "  第二段。",
        "license: MIT",
        "---",
        "",
      ].join("\n"),
    );
    assert.equal(
      frontmatter.description,
      "Find and remove AI slop from a web project. Use when the user asks.\n\n第二段。",
    );
    assert.equal(frontmatter.license, "MIT");
  });

  it("块标量不会吞掉后续顶层字段", () => {
    const { frontmatter } = parseSkillMarkdown(
      ["---", "description: |", "  内容", "name: after-block", "---", ""].join("\n"),
    );
    assert.equal(frontmatter.name, "after-block");
    assert.equal(frontmatter.description, "内容");
  });

  it("解析嵌套 metadata", () => {    const { frontmatter } = parseSkillMarkdown(
      "---\nname: x\ndescription: d\nmetadata:\n  internal: true\n  owner: team\n---\n正文",
    );
    assert.deepEqual(frontmatter.metadata, { internal: true, owner: "team" });
  });

  it("引号包裹与含冒号的描述", () => {
    const { frontmatter } = parseSkillMarkdown(
      '---\nname: x\ndescription: "用于：处理 A/B 测试"\n---\n正文',
    );
    assert.equal(frontmatter.description, "用于：处理 A/B 测试");
  });

  it("无 frontmatter 时整体作为正文", () => {
    const { frontmatter, body } = parseSkillMarkdown("# 只是一篇文档");
    assert.deepEqual(frontmatter, {});
    assert.equal(body, "# 只是一篇文档");
  });

  it("生成的 SKILL.md 可被解析回来", () => {
    const md = buildSkillMarkdown(
      { name: "demo", description: "示例：包含冒号" },
      "# Demo\n\n内容",
    );
    const parsed = parseSkillMarkdown(md);
    assert.equal(parsed.frontmatter.name, "demo");
    assert.equal(parsed.frontmatter.description, "示例：包含冒号");
    assert.match(parsed.body, /# Demo/);
  });
});

describe("技能名归一", () => {
  it("小写并替换非法字符", () => {
    assert.equal(normalizeSkillName("Convex Best Practices"), "convex-best-practices");
    assert.equal(normalizeSkillName("React/Next"), "react-next");
    assert.equal(normalizeSkillName("  -weird-  "), "weird");
  });
});

describe("内置技能", () => {
  it("每个内置技能都能转成合法技能包", () => {
    assert.ok(BUILTIN_SKILLS.length >= 5);
    for (const def of BUILTIN_SKILLS) {
      const pkg = builtinToPackage(def);
      assert.equal(pkg.name, def.name, def.name);
      assert.ok(pkg.description.length > 20, `${def.name} 描述过短`);
      const manifest = pkg.files.find((f) => f.path === "SKILL.md");
      assert.ok(manifest, `${def.name} 缺 SKILL.md`);
      const parsed = parseSkillMarkdown(manifest!.content);
      assert.equal(parsed.frontmatter.name, def.name);
      assert.equal(parsed.frontmatter.description, def.description);
      assert.ok(parsed.body.trim().length > 200, `${def.name} 正文过短`);
      assert.ok(pkg.sizeBytes > 0);
    }
  });

  it("技能名唯一且符合目录命名", () => {
    const names = BUILTIN_SKILLS.map((s) => s.name);
    assert.equal(new Set(names).size, names.length);
    for (const name of names) assert.equal(normalizeSkillName(name), name);
  });
});
