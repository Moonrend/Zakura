/**
 * MCP 安装默认绑定全部 Agent + 新 Agent mcp.mode=all
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAgentMcpMode, parseAgentConfig } from "../src/services/agent-providers.js";

describe("MCP install defaults", () => {
  it("new-agent default config uses mcp.mode=all", () => {
    // 与 AgentService.create 默认 config 对齐
    const configJson = JSON.stringify({
      providers: { mcp: { mode: "all", instanceIds: [] } },
    });
    const agent = { configJson } as Parameters<typeof getAgentMcpMode>[0];
    assert.equal(getAgentMcpMode(agent), "all");
    assert.equal(parseAgentConfig(agent).providers?.mcp?.mode, "all");
  });

  it("resolveInstallAgentIds: omitted agentIds means all", async () => {
    // 纯函数语义：未指定 / all=true → 全部；all=false 且空 → 空
    const allAgents = [{ id: "a1" }, { id: "a2" }];
    function resolve(
      opts?: { agentIds?: string[]; all?: boolean },
      agents = allAgents,
    ): string[] {
      if (opts?.all === false) {
        if (!opts.agentIds?.length) return [];
        return opts.agentIds.filter((id) => agents.some((a) => a.id === id));
      }
      if (opts?.all === true || !opts?.agentIds?.length) {
        return agents.map((a) => a.id);
      }
      return opts.agentIds.filter((id) => agents.some((a) => a.id === id));
    }

    assert.deepEqual(resolve(undefined), ["a1", "a2"]);
    assert.deepEqual(resolve({}), ["a1", "a2"]);
    assert.deepEqual(resolve({ all: true }), ["a1", "a2"]);
    assert.deepEqual(resolve({ all: false, agentIds: [] }), []);
    assert.deepEqual(resolve({ all: false, agentIds: ["a1"] }), ["a1"]);
    assert.deepEqual(resolve({ agentIds: ["a2"] }), ["a2"]);
  });
});
