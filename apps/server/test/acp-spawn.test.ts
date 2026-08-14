import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "../src/db/schema.js";
import { callAcpTool } from "../src/services/cloud-agent/acp-tools.js";
import type { AcpSessionService } from "../src/services/acp/session.js";

function fakeAgent(config: Record<string, unknown>): Agent {
  return {
    id: "agent-1",
    tenantId: "t1",
    configJson: JSON.stringify(config),
  } as Agent;
}

describe("spawn_acp_agent", () => {
  it("creates a child session and returns childSessionId via link", async () => {
    const spawned: unknown[] = [];
    const acp = {
      spawn: async (input: unknown) => {
        spawned.push(input);
        return { sessionId: "child-acp-1", text: "fixed the bug" };
      },
    } as Pick<AcpSessionService, "spawn"> as AcpSessionService;

    const agent = fakeAgent({
      acp: {
        agents: {
          codex: { enabled: true, setupMode: "self", managed: {} },
        },
      },
    });
    const out = await callAcpTool(
      acp,
      agent,
      "t1",
      "spawn_acp_agent",
      { profile_id: "codex", task: "fix the login bug" },
      { parentSessionId: "parent-1", parentToolCallId: "tool-9" },
    );
    assert.equal(out.link?.sessionId, "child-acp-1");
    assert.equal(out.link?.agentId, "agent-1");
    assert.match(out.text, /fixed the bug/);
    const input = spawned[0] as {
      profileId: string;
      origin?: { parentSessionId?: string; parentToolCallId?: string };
    };
    assert.equal(input.profileId, "codex");
    assert.equal(input.origin?.parentSessionId, "parent-1");
    assert.equal(input.origin?.parentToolCallId, "tool-9");
  });

  it("lists enabled ACP profiles", async () => {
    const agent = fakeAgent({
      acp: {
        agents: {
          "claude-code": { enabled: true, setupMode: "self", managed: {} },
          dormant: { enabled: false, setupMode: "self", managed: {} },
        },
      },
    });
    const out = await callAcpTool(
      {} as AcpSessionService,
      agent,
      "t1",
      "list_acp_agents",
      {},
    );
    const parsed = JSON.parse(out.text) as {
      agents: Array<{
        profile_id: string;
        setup_mode?: string;
        command?: string;
        session_mode?: string;
      }>;
      count: number;
    };
    assert.equal(parsed.count, 1);
    assert.equal(parsed.agents[0]?.profile_id, "claude-code");
    assert.equal(parsed.agents[0]?.setup_mode, "self");
    assert.equal(parsed.agents[0]?.command, "claude-agent-acp");
    assert.equal(parsed.agents[0]?.session_mode, "default");
    assert.equal(out.link, undefined);
  });
});
