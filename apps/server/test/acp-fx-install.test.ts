import assert from "node:assert/strict";
import test from "node:test";
import {
  acpAgents,
  applyAcpRegistryIndex,
  resetAcpRegistry,
} from "@zakura/shared";

import { AcpRegistryService } from "../src/services/acp/registry.js";
import { AcpSessionService } from "../src/services/acp/session.js";

test("fx installs and updates its registry image even with legacy preinstalled metadata", async (t) => {
  t.after(() => resetAcpRegistry());
  const agents = structuredClone(acpAgents());
  const fx = agents.find((agent) => agent.profileId === "fx")!;
  fx.integration = { ...fx.integration, preinstalled: true };
  assert.equal(applyAcpRegistryIndex({
    schemaVersion: 1, imagePrefix: "ghcr.io/moonrend/acp-registry", agents, digest: "legacy-fx",
  }).ok, true);

  const pulls: Array<{ image: string; forcePull?: boolean }> = [];
  const workspace = {
    ensureAcpAdapterImage: async (_agent: unknown, image: string, _progress: unknown, opts: { forcePull?: boolean }) => {
      pulls.push({ image, forcePull: opts.forcePull });
      return true;
    },
    ensureStarted: async () => assert.fail("fx must not probe or install a workspace binary"),
    removeAcpAdapterContainers: async () => 0,
  };
  const registry = new AcpRegistryService(workspace as never);
  const sessions = new AcpSessionService({
    workspace: workspace as never,
    agentService: {} as never,
    store: {} as never,
    acpRegistry: registry,
  });
  const agent = {
    id: "agent-fx",
    tenantId: "tenant-fx",
    configJson: JSON.stringify({ acp: { agents: { fx: { enabled: true, setupMode: "self" } } } }),
  } as never;

  assert.equal((await sessions.install(agent, "fx")).ok, true);
  assert.equal((await sessions.install(agent, "fx", { version: "9.9.9", forcePull: true })).ok, true);
  assert.deepEqual(pulls, [
    { image: fx.image, forcePull: undefined },
    { image: "ghcr.io/moonrend/acp-registry/fx-acp:9.9.9", forcePull: true },
  ]);
});
