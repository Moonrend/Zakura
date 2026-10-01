import { test } from "node:test";
import assert from "node:assert/strict";
import { callPeerTool, listPeerToolDefinitions } from "../src/services/cloud-agent/peer-tools.js";
import type { Agent } from "../src/db/schema.js";

function fakeAgent(over: Partial<Agent>): Agent {
  return {
    id: "ag_x",
    tenantId: "t1",
    spaceId: "sp1",
    name: "A",
    slug: "a",
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
    workspaceKind: "container",
    workspaceStatus: "ready",
    workspaceRevision: null,
    lastMigrationId: null,
    configJson: "{}",
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as Agent;
}

const caller = fakeAgent({ id: "ag_self", slug: "self" });
const sameSpace = fakeAgent({ id: "ag_peer", slug: "peer" });
const crossSpace = fakeAgent({ id: "ag_far", slug: "far", spaceId: "sp2" });

function makeDeps(peer: Agent | null) {
  return {
    agentService: { get: async () => peer },
    memoryStore: { search: async () => [{ id: "m1", text: "hello" }] },
    sessionStore: {
      listSessions: async () => [{ id: "s1", title: "t", kind: "chat", updatedAt: new Date() }],
      getSession: async () => ({ id: "s1" }),
      listEvents: async () => [{ type: "user_message" }],
    },
  } as any;
}

test("peer tools: 同 space 放行", async () => {
  const out = await callPeerTool(makeDeps(sameSpace), caller, "search_peer_memory", {
    agentSlug: "peer",
    query: "hello",
  });
  assert.equal(out.isError, undefined);
  assert.ok(out.text.includes("hello"));
});

test("peer tools: 跨 space 拒绝", async () => {
  const out = await callPeerTool(makeDeps(crossSpace), caller, "search_peer_memory", {
    agentSlug: "far",
    query: "hello",
  });
  assert.equal(out.isError, true);
  assert.match(out.text, /Space/);
});

test("peer tools: 不存在的 agent 拒绝", async () => {
  const out = await callPeerTool(makeDeps(null), caller, "list_peer_sessions", {
    agentSlug: "ghost",
  });
  assert.equal(out.isError, true);
});

test("peer tools: 定义齐全", () => {
  const defs = listPeerToolDefinitions([sameSpace]);
  assert.deepEqual(
    defs.map((d) => d.function.name).sort(),
    ["get_peer_messages", "list_peer_sessions", "search_peer_memory"],
  );
});
