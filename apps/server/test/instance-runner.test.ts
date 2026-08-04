/**
 * Orchestrator Runner 分支判定 + InstanceMigration 本地节点判定自检。
 */
import assert from "node:assert/strict";
import { LOCAL_RUNTIME_NODE_ID } from "@zakura/shared";

function isLocalRuntimeNodeId(id: string | null | undefined): boolean {
  return !id || id === LOCAL_RUNTIME_NODE_ID || id === "local";
}

assert.equal(isLocalRuntimeNodeId(null), true);
assert.equal(isLocalRuntimeNodeId(undefined), true);
assert.equal(isLocalRuntimeNodeId("local"), true);
assert.equal(isLocalRuntimeNodeId(LOCAL_RUNTIME_NODE_ID), true);
assert.equal(isLocalRuntimeNodeId("runner-abc"), false);

function shouldUseRunner(runtimeNodeId: string | null, providerId: string): boolean {
  return !isLocalRuntimeNodeId(runtimeNodeId) && providerId === "stdio-mcp";
}

assert.equal(shouldUseRunner(null, "stdio-mcp"), false);
assert.equal(shouldUseRunner("runner-1", "stdio-mcp"), true);
assert.equal(shouldUseRunner("runner-1", "generic-mcp"), false);

console.log("instance-runner self-check ok");
