import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeNode } from "./runners.ts";
import { diskUnavailableReason, diskUsageIsStale, type WorkspaceDisk } from "./workspace-disks.ts";

const node: RuntimeNode = {
  id: "node", tenantId: "tenant", name: "Server", slug: "server", kind: "server", status: "online",
  capabilities: { docker: true, dockerCreateReceipts: true, workspaceProtocolV2: true }, hostInfo: {}, labels: {},
  endpoint: null, storageRoot: "/workspace-data", agentVersion: "test", lastSeenAt: null, createdAt: "", updatedAt: "",
};
const disk: WorkspaceDisk = {
  id: "disk", name: "Data", nodeId: "node", nodeIncarnation: "incarnation", state: "available", attachedInstanceId: null,
  usedBytes: 42, sampledAt: "2026-10-25T12:00:00Z", verifiedAt: "2026-10-25T12:00:00Z", lastError: null,
};
test("only verified released disks on capable original nodes can be selected", () => {
  assert.equal(diskUnavailableReason(disk, node), null);
  for (const state of ["pending", "attached", "release_pending", "delete_pending", "unknown", "error"]) {
    assert.ok(diskUnavailableReason({ ...disk, state }, node));
  }
  assert.ok(diskUnavailableReason({ ...disk, attachedInstanceId: "old" }, node));
  assert.ok(diskUnavailableReason({ ...disk, verifiedAt: null }, node));
  assert.equal(diskUnavailableReason({ ...disk, nodeRemovedAt: "2026-10-25T12:00:00Z" }, node), "原节点已删除，已停止同步");
  assert.ok(diskUnavailableReason(disk, undefined));
  assert.ok(diskUnavailableReason(disk, { ...node, status: "offline" }));
  assert.ok(diskUnavailableReason(disk, { ...node, capabilities: { docker: true, dockerCreateReceipts: true } }));
});
test("offline and old disk samples are visibly stale", () => {
  const now = Date.parse("2026-10-25T12:01:00Z");
  assert.equal(diskUsageIsStale(disk, true, now), false);
  assert.equal(diskUsageIsStale(disk, false, now), true);
  assert.equal(diskUsageIsStale(disk, true, now + 20 * 60_000), true);
  assert.equal(diskUsageIsStale({ ...disk, sampledAt: null }, true, now), true);
});
