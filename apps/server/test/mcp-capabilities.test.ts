import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAgentMcpCapabilities,
  buildAgentMcpInstructions,
  buildDiscoverResult,
  EXT_APPS,
  EXT_TASKS,
  toolNeedsHostedConfirm,
} from "../src/mcp/agent-capabilities.js";
import {
  parseProxyTaskId,
  qualifyProxyTaskId,
} from "../src/services/mcp-task-store.js";

describe("agent MCP capabilities / discover", () => {
  it("advertises 2025 tasks + 2026 extensions map", () => {
    const caps = buildAgentMcpCapabilities();
    assert.ok(caps.tasks?.requests?.tools?.call);
    assert.ok(caps.resources);
    assert.ok(caps.prompts);
    assert.ok(caps.logging);
    assert.deepEqual(caps.extensions?.[EXT_TASKS], {});
    assert.deepEqual(caps.extensions?.[EXT_APPS], {});
  });

  it("server/discover payload includes supportedVersions", () => {
    const d = buildDiscoverResult({ pathSlug: "demo" });
    assert.ok(d.supportedVersions.includes("2025-11-25"));
    assert.ok(d.supportedVersions.includes("2026-07-28"));
    assert.equal(d.resultType, "complete");
    assert.equal(
      (d._meta["io.modelcontextprotocol/serverInfo"] as { name: string }).name,
      "zakura-agent",
    );
  });

  it("instructions tell host AI to call this MCP and re_spawn_subagent", () => {
    const text = buildAgentMcpInstructions({ pathSlug: "demo", detail: "brief" });
    assert.match(text, /may call/i);
    assert.match(text, /re_spawn_subagent/);
    assert.match(text, /tools\/call/);
    assert.match(text, /do not claim/i);

    const discover = buildDiscoverResult({ pathSlug: "research" });
    assert.match(discover.instructions, /research/);
    assert.match(discover.instructions, /re_spawn_subagent/);

    const full = buildAgentMcpInstructions({
      pathSlug: "demo",
      agentName: "Demo",
      enableComputer: true,
      enableMemory: false,
      mcpMode: "all",
      exposeWorkspaceFs: true,
      detail: "full",
    });
    assert.match(full, /Computer \/ FS \/ Shell: on/);
    assert.match(full, /Memory: off/);
  });

  it("toolNeedsHostedConfirm for destructive / shell", () => {
    assert.equal(
      toolNeedsHostedConfirm({ localName: "shell_exec", annotations: null }),
      true,
    );
    assert.equal(
      toolNeedsHostedConfirm({
        localName: "fs_read",
        annotations: { destructiveHint: false },
      }),
      false,
    );
    assert.equal(
      toolNeedsHostedConfirm({
        localName: "fs_delete",
        annotations: { destructiveHint: true },
      }),
      true,
    );
  });
});

describe("proxy task id", () => {
  it("round-trips slug and local id", () => {
    const id = qualifyProxyTaskId("my-mcp", "abc-123");
    assert.equal(id, "zp_my-mcp__abc-123");
    assert.deepEqual(parseProxyTaskId(id), {
      slug: "my-mcp",
      localTaskId: "abc-123",
    });
  });
});
