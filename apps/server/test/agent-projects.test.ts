/**
 * 项目说明：DB 与目录 AGENTS.md 叠加
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mergeProjectInstructions,
  toProjectDto,
} from "../src/services/agent-projects.js";

describe("agent project instructions", () => {
  it("merges db copy above filesystem AGENTS.md", () => {
    assert.equal(mergeProjectInstructions("", undefined), undefined);
    assert.equal(mergeProjectInstructions("  ", "  "), undefined);
    assert.equal(
      mergeProjectInstructions("用中文回复", undefined),
      "# 项目说明\n用中文回复",
    );
    assert.equal(
      mergeProjectInstructions("", "# 项目指令（AGENTS.md）\nfoo"),
      "# 项目指令（AGENTS.md）\nfoo",
    );
    assert.equal(
      mergeProjectInstructions("分组", "# 项目指令（AGENTS.md）\nfoo"),
      "# 项目说明\n分组\n\n# 项目指令（AGENTS.md）\nfoo",
    );
  });

  it("omits workspace path when the project has no directory", () => {
    const base = {
      id: "1",
      tenantId: "t",
      agentId: "a",
      slug: "demo",
      name: "演示",
      description: "",
      instructions: "",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    assert.equal(toProjectDto({ ...base, hasWorkspace: false }).path, null);
    assert.equal(
      toProjectDto({ ...base, hasWorkspace: true }).path,
      "/workspace/projects/demo",
    );
  });
});
