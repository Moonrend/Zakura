import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "../src/db/schema.js";
import {
  expandDisabledGroups,
  groupComposerTools,
  instanceSlugFromName,
  toComposerCapabilities,
} from "../src/services/cloud-agent/composer-capabilities.js";
import { buildSystemPrompt } from "../src/services/cloud-agent/prompts.js";

describe("instanceSlugFromName", () => {
  it("strips re_ prefix and local suffix", () => {
    assert.equal(instanceSlugFromName("re_gmail__send_email", "send_email"), "gmail");
    assert.equal(instanceSlugFromName("re_kitesurf__click", "click"), "kitesurf");
  });
});

describe("groupComposerTools", () => {
  it("buckets native computer / browser / memory tools", () => {
    const groups = groupComposerTools([
      { qualifiedName: "re_fs_read", providerId: "zakura-agent", localName: "fs_read" },
      { qualifiedName: "re_shell_exec", providerId: "zakura-agent", localName: "shell_exec" },
      { qualifiedName: "re_browser_observe", providerId: "zakura-agent", localName: "browser_observe" },
      { qualifiedName: "re_search_memory", providerId: "zakura-agent", localName: "search_memory" },
      { qualifiedName: "re_agent_info", providerId: "zakura-agent", localName: "agent_info" },
    ]);
    const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
    assert.deepEqual(byId["builtin:computer"]?.tools, ["re_fs_read", "re_shell_exec"]);
    assert.deepEqual(byId["builtin:browser"]?.tools, ["re_browser_observe"]);
    assert.deepEqual(byId["builtin:memory"]?.tools, ["re_search_memory"]);
    assert.equal(byId["builtin:computer"]?.kind, "builtin");
    assert.ok(!byId["builtin:other"]);
  });

  it("groups connectors by ref and MCP by instance", () => {
    const groups = groupComposerTools([
      {
        qualifiedName: "re_gmail__send",
        providerId: "zakura-connector",
        localName: "send",
        _meta: { connectorRef: "gmail", connectorName: "Gmail" },
      },
      {
        qualifiedName: "re_gmail__list",
        providerId: "zakura-connector",
        localName: "list",
        _meta: { connectorRef: "gmail", connectorName: "Gmail" },
      },
      {
        qualifiedName: "re_kitesurf__click",
        providerId: "generic-mcp",
        instanceId: "inst-1",
        localName: "click",
        description: "[kitesurf] Click",
      },
    ]);
    const gmail = groups.find((g) => g.id === "connector:gmail");
    const mcp = groups.find((g) => g.id === "mcp:inst-1");
    assert.equal(gmail?.kind, "connector");
    assert.equal(gmail?.label, "Gmail");
    assert.deepEqual(gmail?.tools, ["re_gmail__send", "re_gmail__list"]);
    assert.equal(mcp?.kind, "mcp");
    assert.equal(mcp?.label, "kitesurf");
    assert.deepEqual(mcp?.tools, ["re_kitesurf__click"]);
  });

  it("always includes chat extras and skips crisis support", () => {
    const groups = groupComposerTools([
      { qualifiedName: "send_crisis_support_resources", providerId: "zakura-agent" },
    ]);
    assert.ok(groups.some((g) => g.id === "builtin:sessions"));
    assert.ok(groups.some((g) => g.id === "builtin:automation"));
    assert.ok(groups.some((g) => g.id === "builtin:delegate"));
    assert.ok(!groups.some((g) => g.tools.includes("send_crisis_support_resources")));
  });
});

describe("expandDisabledGroups / toComposerCapabilities", () => {
  it("expands selected groups into unique tool names", () => {
    const groups = groupComposerTools([
      { qualifiedName: "re_fs_read", providerId: "zakura-agent", localName: "fs_read" },
    ]);
    const names = expandDisabledGroups(groups, ["builtin:computer", "builtin:sessions"]);
    assert.ok(names.includes("re_fs_read"));
    assert.ok(names.includes("list_chat_sessions"));
    assert.equal(new Set(names).size, names.length);
  });

  it("drops disabled or errored skills", () => {
    const cap = toComposerCapabilities({
      tools: [],
      skills: [
        { name: "ok", title: "OK", description: "d", enabled: true, status: "installed" },
        { name: "off", title: "Off", enabled: false, status: "installed" },
        { name: "bad", title: "Bad", enabled: true, status: "error" },
      ],
    });
    assert.deepEqual(
      cap.skills.map((s) => s.name),
      ["ok"],
    );
  });
});

describe("buildSystemPrompt requestedSkills", () => {
  it("asks the model to read the selected skill", () => {
    const agent = {
      name: "助手",
      slug: "helper",
      enableComputer: false,
      enableBrowser: false,
      enableMemory: false,
      configJson: "{}",
    } as Agent;
    const prompt = buildSystemPrompt(agent, {}, { requestedSkills: ["frontend-design"] });
    assert.match(prompt, /本回合指定技能/);
    assert.match(prompt, /frontend-design/);
    assert.match(prompt, /re_read_skill/);
  });
});
