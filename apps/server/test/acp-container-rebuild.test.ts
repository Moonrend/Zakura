import assert from "node:assert/strict";
import test from "node:test";

import { AgentWorkspaceService } from "../src/services/agent-workspace.js";
import { AcpSessionService } from "../src/services/acp/session.js";

test("ACP rebuild cleanup 无绑定节点时不碰本机 docker", async () => {
  const service = Object.create(AgentWorkspaceService.prototype) as AgentWorkspaceService;
  Object.assign(service, {
    runtime: {
      list: async () => {
        throw new Error("local runtime must not be queried");
      },
      remove: async () => {
        throw new Error("local runtime must not be removed");
      },
    },
  });

  const count = await service.removeAcpAdapterContainers(
    { id: "agent-a", tenantId: "tenant-a", runtimeNodeId: null } as never,
    "pi",
  );

  assert.equal(count, 0);
});

test("ACP rebuild cleanup 在绑定电脑上删 adapter 容器", async () => {
  const stops: string[] = [];
  const service = Object.create(AgentWorkspaceService.prototype) as AgentWorkspaceService;
  Object.assign(service, {
    runtime: {
      list: async () => {
        throw new Error("local runtime must not be queried");
      },
    },
    db: {
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
    },
    requireRunnerClient: async () => ({
      client: {
        removeAcpAdapterContainers: async (agentId: string, adapterId: string) => {
          stops.push(`${agentId}:${adapterId}`);
          return 2;
        },
      },
      node: { id: "runner-a" },
    }),
  });

  const count = await service.removeAcpAdapterContainers(
    { id: "agent-a", tenantId: "tenant-a", runtimeNodeId: "runner-a" } as never,
    "pi",
  );

  assert.equal(count, 2);
  assert.deepEqual(stops, ["agent-a:pi"]);
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

test("ACP 镜像安装走绑定电脑的 docker.pull", async () => {
  const pulls: string[] = [];
  const service = Object.create(AgentWorkspaceService.prototype) as AgentWorkspaceService;
  Object.assign(service, {
    requireRunnerClient: async () => ({
      client: {
        checkImageUpdates: async () => ({
          images: [{ image: "ghcr.io/acp:1", localId: null, error: "missing" }],
        }),
        pullImage: async (image: string) => {
          pulls.push(image);
        },
      },
      node: { id: "runner-a" },
    }),
  });

  const pulled = await service.ensureAcpAdapterImage(
    { id: "agent-a", tenantId: "tenant-a", runtimeNodeId: "runner-a" } as never,
    "ghcr.io/acp:1",
  );

  assert.equal(pulled, true);
  assert.deepEqual(pulls, ["ghcr.io/acp:1"]);
});

test("ACP 镜像已在绑定电脑则跳过拉取", async () => {
  const pulls: string[] = [];
  const service = Object.create(AgentWorkspaceService.prototype) as AgentWorkspaceService;
  Object.assign(service, {
    requireRunnerClient: async () => ({
      client: {
        checkImageUpdates: async () => ({
          images: [{ image: "ghcr.io/acp:1", localId: "sha256:abc", error: null }],
        }),
        pullImage: async (image: string) => {
          pulls.push(image);
        },
      },
      node: { id: "runner-a" },
    }),
  });

  const pulled = await service.ensureAcpAdapterImage(
    { id: "agent-a", tenantId: "tenant-a", runtimeNodeId: "runner-a" } as never,
    "ghcr.io/acp:1",
  );

  assert.equal(pulled, false);
  assert.deepEqual(pulls, []);
});

