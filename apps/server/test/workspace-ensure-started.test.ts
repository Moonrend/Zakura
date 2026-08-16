/**
 * ACP / exec 热路径必须复用已在跑的工作区；`start()` 会拆掉重建容器。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "../src/db/schema.js";
import type { AppConfig } from "../src/config.js";
import type { DockerRuntime } from "../src/runtime/docker.js";
import { AgentWorkspaceService } from "../src/services/agent-workspace.js";

function fakeDb(rows: Array<{ dockerId: string; status: string; purpose: string; agentId: string }>) {
  return {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
  };
}

describe("workspace.ensureStarted", () => {
  it("reuses a running container instead of recreating it", async () => {
    let createCalls = 0;
    const runtime = {
      inspect: async (id: string) =>
        id === "ctr-running"
          ? {
              id,
              name: "ws",
              image: "zakura-workspace:test",
              status: "running",
              ports: [],
              labels: {},
              mounts: [],
            }
          : null,
      createAndStart: async () => {
        createCalls += 1;
        throw new Error("ensureStarted must not recreate a running workspace");
      },
    };

    const workspace = new AgentWorkspaceService(
      fakeDb([
        {
          dockerId: "ctr-running",
          status: "running",
          purpose: "workspace",
          agentId: "agent-1",
        },
      ]) as never,
      runtime as unknown as DockerRuntime,
      { dataDir: "/tmp" } as AppConfig,
    );
    const agent = { id: "agent-1", tenantId: "t1", runtimeNodeId: null } as Agent;

    assert.equal(await workspace.isWorkspaceRunning(agent), true);
    const out = await workspace.ensureStarted(agent);
    assert.equal(out.id, "agent-1");
    assert.equal(createCalls, 0);
  });
});
