import assert from "node:assert/strict";
import test from "node:test";

import { AgentWorkspaceService } from "../src/services/agent-workspace.js";
import { AcpSessionService } from "../src/services/acp/session.js";

test("ACP rebuild cleanup removes only containers for the requested agent/profile", async () => {
  const removed: string[] = [];
  let receivedFilters: unknown;
  const service = Object.create(AgentWorkspaceService.prototype) as AgentWorkspaceService;
  Object.assign(service, {
    runtime: {
      list: async (filters: unknown) => {
        receivedFilters = filters;
        return [
          {
            id: "target",
            labels: {
              "zakura.acp_adapter": "pi",
              "zakura.agent": "agent-a",
            },
          },
          {
            id: "other-profile",
            labels: {
              "zakura.acp_adapter": "hermes",
              "zakura.agent": "agent-a",
            },
          },
          {
            id: "other-agent",
            labels: {
              "zakura.acp_adapter": "pi",
              "zakura.agent": "agent-b",
            },
          },
        ];
      },
      remove: async (id: string) => {
        removed.push(id);
      },
    },
  });

  const count = await service.removeAcpAdapterContainers(
    { id: "agent-a", tenantId: "tenant-a", runtimeNodeId: null } as never,
    "pi",
  );

  assert.equal(count, 1);
  assert.deepEqual(removed, ["target"]);
  assert.deepEqual(receivedFilters, {
    tenantId: "tenant-a",
    purpose: "acp-adapter",
  });
});

test("ACP rebuild cleanup never touches local runtime for a remote agent", async () => {
  const service = Object.create(AgentWorkspaceService.prototype) as AgentWorkspaceService;
  Object.assign(service, {
    runtime: {
      list: async () => {
        throw new Error("local runtime must not be queried");
      },
    },
  });

  const count = await service.removeAcpAdapterContainers(
    { id: "agent-a", tenantId: "tenant-a", runtimeNodeId: "runner-a" } as never,
    "pi",
  );

  assert.equal(count, 0);
});

test("forced ACP install invalidates live runtimes and removes orphaned containers", async () => {
  const calls: string[] = [];
  const workspace = {
    removeAcpAdapterContainers: async () => {
      calls.push("remove-orphans");
      return 1;
    },
  };
  const service = new AcpSessionService({
    agentService: {} as never,
    store: {} as never,
    workspace: workspace as never,
    acpRegistry: {
      setInUseVersionsProvider: () => undefined,
      ensureInstalled: async () => {
        calls.push("pull-image");
        return { command: "", args: [], version: "0.0.33", installed: true };
      },
    } as never,
  });
  Object.assign(service, {
    probe: async () => ({ available: true, profile: { preinstalled: false } }),
    invalidateAgentRuntimes: async () => {
      calls.push("invalidate-runtime");
    },
  });

  await service.install(
    {
      id: "agent-a",
      tenantId: "tenant-a",
      configJson: JSON.stringify({
        acp: { agents: { pi: { enabled: true, setupMode: "self" } } },
      }),
    } as never,
    "pi",
    { forcePull: true },
  );

  assert.deepEqual(calls, ["pull-image", "invalidate-runtime", "remove-orphans"]);
});
