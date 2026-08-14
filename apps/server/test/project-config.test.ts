/**
 * 项目配置：AGENTS.md 优先、技能目录扫描、hooks 合并
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PROJECT_HOOKS_WRITE_FILE,
  PROJECT_INSTRUCTION_FILES,
  PROJECT_SKILL_DIRS,
  PROJECT_SKILLS_WRITE_DIR,
} from "@zakura/shared";
import { LocalWorkspaceFs, ensureWorkspaceDir } from "@zakura/core";
import {
  loadProjectConfig,
  loadProjectContext,
  saveProjectHooks,
  saveProjectInstructions,
  createProjectSkill,
  renameProject,
  deleteProject,
  ProjectFsError,
} from "../src/services/project-config.js";

describe("project config files", () => {
  it("exposes canonical write paths", () => {
    assert.deepEqual([...PROJECT_INSTRUCTION_FILES], ["AGENTS.md", "CLAUDE.md"]);
    assert.equal(PROJECT_SKILLS_WRITE_DIR, ".agents/skills");
    assert.ok(PROJECT_SKILL_DIRS.includes(".claude/skills"));
    assert.equal(PROJECT_HOOKS_WRITE_FILE, ".agents/hooks.json");
  });

  it("prefers AGENTS.md over CLAUDE.md and scans project skills + hooks", async () => {
    const root = mkdtempSync(join(tmpdir(), "zakura-pcfg-"));
    try {
      ensureWorkspaceDir(root);
      const fs = new LocalWorkspaceFs(root);
      await fs.mkdir("projects/demo/.agents/skills/ship");
      await fs.write(
        "projects/demo/CLAUDE.md",
        "# Claude\nonly claude",
      );
      await fs.write(
        "projects/demo/AGENTS.md",
        "# Agents\nprefer this",
      );
      await fs.write(
        "projects/demo/.agents/skills/ship/SKILL.md",
        ["---", "name: ship", "description: Ship the demo", "---", "", "# Ship", ""].join("\n"),
      );
      await fs.write(
        "projects/demo/.claude/skills/legacy/SKILL.md",
        ["---", "name: legacy", "description: From claude dir", "---", "", "hi", ""].join("\n"),
      );
      await fs.write(
        "projects/demo/.agents/hooks.json",
        JSON.stringify({
          hooks: {
            SessionStart: [{ hooks: [{ type: "prompt", prompt: "Use the project README." }] }],
          },
        }),
      );
      await fs.write(
        "projects/demo/.claude/settings.json",
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: "re_shell_exec", hooks: [{ type: "command", command: "echo pre" }] }],
          },
        }),
      );

      const cfg = await loadProjectConfig(fs, "demo");
      assert.equal(cfg.exists, true);
      assert.equal(cfg.instructions.file, "AGENTS.md");
      assert.ok(cfg.instructions.content.includes("prefer this"));
      assert.deepEqual(
        cfg.skills.map((s) => s.name).sort(),
        ["legacy", "ship"],
      );
      assert.equal(cfg.hooks.sources.length, 2);
      assert.ok(cfg.hooks.events.SessionStart?.length);
      assert.ok(cfg.hooks.events.PreToolUse?.length);

      const ctx = await loadProjectContext(fs, "demo");
      assert.ok(ctx.instructions?.includes("AGENTS.md"));
      assert.ok(ctx.skillsSummary.includes("ship"));
      assert.equal(ctx.hookPackages.length, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("saves AGENTS.md and creates a project skill under .agents/skills", async () => {
    const root = mkdtempSync(join(tmpdir(), "zakura-pcfg-w-"));
    try {
      ensureWorkspaceDir(root);
      const fs = new LocalWorkspaceFs(root);
      await fs.mkdir("projects/app");
      await saveProjectInstructions(fs, "app", "hello agents");
      const skill = await createProjectSkill(fs, "app", {
        name: "lint",
        description: "Run the linter",
      });
      await saveProjectHooks(fs, "app", {
        UserPromptSubmit: [{ hooks: [{ type: "prompt", prompt: "Be terse." }] }],
      });
      const cfg = await loadProjectConfig(fs, "app");
      assert.equal(cfg.instructions.file, "AGENTS.md");
      assert.equal(cfg.instructions.content, "hello agents");
      assert.equal(skill.name, "lint");
      assert.ok(skill.path.includes(".agents/skills/lint"));
      assert.equal(cfg.skills[0]?.name, "lint");
      assert.equal(cfg.hooks.file, ".agents/hooks.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads .agents/hooks/hooks.json and flat hook actions", async () => {
    const root = mkdtempSync(join(tmpdir(), "zakura-pcfg-hooks-"));
    try {
      ensureWorkspaceDir(root);
      const fs = new LocalWorkspaceFs(root);
      await fs.mkdir("projects/demo/.agents/hooks");
      await fs.write(
        "projects/demo/.agents/hooks/hooks.json",
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [{ type: "prompt", prompt: "Be terse." }],
          },
        }),
      );
      const cfg = await loadProjectConfig(fs, "demo");
      assert.equal(cfg.hooks.file, ".agents/hooks/hooks.json");
      assert.equal(cfg.hooks.events.UserPromptSubmit?.[0]?.hooks[0]?.prompt, "Be terse.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renames and deletes the real projects/<slug> directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "zakura-pcfg-mv-"));
    try {
      ensureWorkspaceDir(root);
      const fs = new LocalWorkspaceFs(root);
      await fs.mkdir("projects/old");
      await fs.write("projects/old/AGENTS.md", "# keep me");
      const moved = await renameProject(fs, "old", "new");
      assert.equal(moved.name, "new");
      assert.equal(await fs.exists("projects/old"), false);
      const cfg = await loadProjectConfig(fs, "new");
      assert.ok(cfg.instructions.content.includes("keep me"));
      await fs.mkdir("projects/taken");
      await assert.rejects(() => renameProject(fs, "new", "taken"), (err: unknown) => {
        assert.ok(err instanceof ProjectFsError);
        assert.equal(err.status, 409);
        return true;
      });
      assert.equal(await deleteProject(fs, "new"), true);
      assert.equal(await fs.exists("projects/new"), false);
      assert.equal(await deleteProject(fs, "new"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
