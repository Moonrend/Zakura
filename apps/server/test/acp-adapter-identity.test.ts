/**
 * The ACP UI keys everything off the *profile* id (`claude-code`), while the
 * registry keys adapters by their own id (`claude-code-acp`). For 12 of 42
 * agents these differ.
 *
 * When adapter status omitted `profileId`, the UI matched on `id`, missed, and
 * fell back to rendering a workspace-style install button whose POST targeted a
 * registry id that does not exist — the "点了安装没反应" report.
 *
 * These tests pin the invariants that make that class of bug impossible:
 *  1. the two id namespaces really do diverge (so the mapping matters), and
 *  2. every container adapter status carries a `profileId` that resolves back
 *     to a real profile.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { acpAgentByProfile, acpContainerAgents, acpRegistryIndex } from "@zakura/shared";
import { AcpRegistryService } from "../src/services/acp/registry.js";

test("registry id and profile id genuinely diverge", () => {
  const agents = acpContainerAgents();
  assert.ok(agents.length > 0, "expected container agents");

  const diverging = agents.filter((a) => a.id !== a.profileId);
  assert.ok(
    diverging.length > 0,
    "expected at least one agent whose registry id differs from its profile id; " +
      "if this ever becomes empty the id-mapping code is dead and should be removed",
  );
});

test("every container agent's profileId resolves back to itself", () => {
  for (const agent of acpContainerAgents()) {
    const resolved = acpAgentByProfile(agent.profileId);
    assert.ok(resolved, `${agent.id} has an unresolvable profileId ${agent.profileId}`);
    assert.equal(
      resolved.id,
      agent.id,
      `profileId ${agent.profileId} must map back to ${agent.id}`,
    );
  }
});

test("looking up a diverging agent by registry id fails, by profile id succeeds", () => {
  // This is the exact lookup the UI performs. Encoded as a test so that a
  // regression shows up here rather than as a dead button in the dashboard.
  const agent = acpContainerAgents().find((a) => a.id !== a.profileId);
  assert.ok(agent, "expected a diverging agent");

  assert.equal(
    acpAgentByProfile(agent.id),
    undefined,
    `${agent.id} must not be reachable via acpAgentByProfile — that lookup takes a profile id`,
  );
  assert.equal(acpAgentByProfile(agent.profileId)?.id, agent.id);
});

test("container status does not require a running workspace", async () => {
  let workspaceExecs = 0;
  const workspace = {
    execInWorkspace: async () => {
      workspaceExecs += 1;
      throw new Error("workspace container is not running");
    },
    acpAdapterImagePresence: async (_agent: unknown, images: string[]) =>
      new Map(images.map((image) => [image, false])),
  };
  const fetchRegistry: typeof fetch = async () =>
    new Response(JSON.stringify(acpRegistryIndex()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const service = new AcpRegistryService(workspace as never, fetchRegistry);
  const statuses = await service.status({
    id: "test-agent",
    tenantId: "test-tenant",
    configJson: {},
  } as never, { force: true });

  assert.equal(workspaceExecs, 0, "status tried to execute inside a stopped workspace");
  assert.equal(statuses.length, acpContainerAgents().length);
  assert.ok(statuses.every((entry) => entry.source === "container"));
});
