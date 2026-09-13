import assert from "node:assert/strict";
import { LOCAL_RUNTIME_NODE_ID } from "@zakura/shared";

/** stdio MCP 必须跟当前 Agent 所选 runner 走，不再读 instance 节点。 */
function pickStdioRuntimeNodeId(
  agentRuntimeNodeId: string | null | undefined,
  instanceRuntimeNodeId: string | null | undefined,
): string | null {
  void instanceRuntimeNodeId;
  const isLocal = (id: string | null | undefined) =>
    !id || id === LOCAL_RUNTIME_NODE_ID || id === "local";
  if (agentRuntimeNodeId && !isLocal(agentRuntimeNodeId)) return agentRuntimeNodeId;
  return null;
}

assert.equal(pickStdioRuntimeNodeId("runner-a", "runner-b"), "runner-a");
assert.equal(pickStdioRuntimeNodeId(null, "runner-b"), null);
assert.equal(pickStdioRuntimeNodeId("local", "runner-b"), null);
assert.equal(pickStdioRuntimeNodeId(null, null), null);
assert.equal(pickStdioRuntimeNodeId(LOCAL_RUNTIME_NODE_ID, null), null);
