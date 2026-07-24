import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getAgentNativePrompt,
  listAgentNativePrompts,
  listAgentNativeResourceTemplates,
  listAgentNativeResources,
  parseWorkspaceFsUri,
  readAgentNativeResource,
} from "../src/services/agent-mcp-primitives.js";
import type { Agent } from "../src/db/schema.js";

function fakeAgent(over: Partial<Agent> & { configJson?: string } = {}): Agent {
  const { configJson, ...rest } = over;
  return {
    id: "agt_1",
    tenantId: "ten_1",
    name: "Demo",
    slug: "demo",
    description: "",
    status: "ready",
    workspaceProfile: "files",
    enableFs: false,
    enableShell: false,
    enableComputer: false,
    enableBrowser: false,
    enableMemory: false,
    memoryProviderId: null,
    workspaceImage: null,
    runtimeNodeId: null,
    configJson: configJson ?? "{}",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...rest,
  } as Agent;
}

describe("agent native MCP primitives", () => {
  it("lists platform resources and prompts", () => {
    const a = fakeAgent();
    const resources = listAgentNativeResources(a);
    const prompts = listAgentNativePrompts(a);
    assert.ok(resources.some((r) => r.uri === "zakura://agent/info"));
    assert.ok(prompts.some((p) => p.name === "re_agent_briefing"));
    // 默认开启云端 FS → 带 fs template
    assert.equal(listAgentNativeResourceTemplates(a).length, 1);
  });

  it("exposes fs template by default and hides when disabled", () => {
    const on = fakeAgent();
    assert.equal(listAgentNativeResourceTemplates(on).length, 1);
    assert.equal(
      listAgentNativeResourceTemplates(on)[0]!.uriTemplate,
      "zakura://agent/fs/{+path}",
    );

    const off = fakeAgent({
      configJson: JSON.stringify({
        providers: { mcp: { exposeWorkspaceFs: false } },
      }),
    });
    assert.equal(listAgentNativeResourceTemplates(off).length, 0);
  });

  it("parses workspace fs URIs", () => {
    assert.equal(parseWorkspaceFsUri("zakura://agent/fs/"), "/");
    assert.equal(parseWorkspaceFsUri("zakura://agent/fs/src/app.ts"), "/src/app.ts");
    assert.equal(parseWorkspaceFsUri("zakura://agent/fs/a%2Fb"), "/a/b");
  });

  it("reads agent info JSON", () => {
    const a = fakeAgent({ slug: "alpha" });
    const result = readAgentNativeResource(a, "zakura://agent/info");
    assert.ok(result);
    const text = result!.contents[0]?.text ?? "";
    assert.match(text, /"slug": "alpha"/);
  });

  it("renders tool_plan prompt with goal", () => {
    const a = fakeAgent();
    const p = getAgentNativePrompt(a, "re_tool_plan", { goal: "列出文件" });
    assert.ok(p);
    const text = (p!.messages[0]!.content as { text: string }).text;
    assert.match(text, /列出文件/);
  });
});
