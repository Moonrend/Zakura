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
    let startCalls = 0;
    const nodes = {
      requireRunnerClient: async () => ({
        client: {
          getWorkspace: async () => ({ status: "running", dockerId: "ctr-running" }),
          startWorkspace: async () => {
            startCalls += 1;
            throw new Error("ensureStarted must not recreate a running workspace");
          },
        },
        node: { id: "n1" },
      }),
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
      {} as unknown as DockerRuntime,
      { dataDir: "/tmp" } as AppConfig,
      nodes as never,
    );
    const agent = { id: "agent-1", tenantId: "t1", runtimeNodeId: "n1" } as Agent;

    assert.equal(await workspace.isWorkspaceRunning(agent), true);
    const out = await workspace.ensureStarted(agent);
    assert.equal(out.id, "agent-1");
    assert.equal(startCalls, 0);
  });

  it("checks display readiness when reusing a running workspace", async () => {
    const commands: string[][] = [];
    const workspace = new AgentWorkspaceService(fakeDb([{ agentId: "agent-1", dockerId: "ctr", status: "running", purpose: "workspace" }]) as never, {} as DockerRuntime, {} as AppConfig, {
      requireRunnerClient: async () => ({
        node: { id: "n1" },
        client: {
          getWorkspace: async () => ({ status: "running", dockerId: "ctr" }),
          execWorkspace: async (_id: string, command: string[]) => {
            commands.push(command);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
      }),
    } as never);
    const agent = { id: "agent-1", tenantId: "t1", runtimeNodeId: "n1", enableComputer: true } as Agent;
    await workspace.ensureStarted(agent, { require: "display" });
    assert.equal(commands.length, 1);
    assert.equal(commands[0]!.at(-1), "display");
  });

  it("does not report a failed display probe as ready or recreate the container", async () => {
    let starts = 0;
    const workspace = new AgentWorkspaceService(fakeDb([{ agentId: "agent-1", dockerId: "ctr", status: "running", purpose: "workspace" }]) as never, {} as DockerRuntime, {} as AppConfig, {
      requireRunnerClient: async () => ({ node: { id: "n1" }, client: {
        getWorkspace: async () => ({ status: "running", dockerId: "ctr" }),
        startWorkspace: async () => { starts++; },
        execWorkspace: async () => ({ exitCode: 1, stdout: "", stderr: "DISPLAY=:99 is unavailable; restart workspace" }),
      } }),
    } as never);
    const agent = { id: "agent-1", tenantId: "t1", runtimeNodeId: "n1", enableComputer: true } as Agent;
    await assert.rejects(workspace.ensureStarted(agent, { require: "display" }), /DISPLAY=:99/);
    assert.equal(starts, 0);
  });

  it("passes display enable flags and honors shell-only readiness on cold start", async () => {
    const agent = { id: "agent-1", slug: "agent", tenantId: "t1", runtimeNodeId: "n1", enableComputer: true } as Agent;
    let startArgs: Record<string, any> | undefined;
    const commands: string[][] = [];
    const db = {
      ...fakeDb([]),
      query: { tenants: { findFirst: async () => ({ slug: "tenant" }) } },
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [agent] }) }) }),
      insert: () => ({ values: async () => undefined }),
    };
    const client = {
      ping: async () => ({ ok: true, docker: { ok: true } }),
      getWorkspace: async () => startArgs ? ({ status: "running", dockerId: "ctr" }) : null,
      startWorkspace: async (args: Record<string, any>) => {
        startArgs = args;
        return { dockerId: "ctr", name: "test", image: "full", status: "running", endpoints: {} };
      },
      execWorkspace: async (_id: string, command: string[]) => {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const workspace = new AgentWorkspaceService(db as never, {} as DockerRuntime, {} as AppConfig, {
      requireRunnerClient: async () => ({ node: { id: "n1" }, client }),
    } as never);
    await workspace.ensureStarted(agent, { require: "shell" });
    assert.equal(startArgs?.env?.ZAKURA_ENABLE_COMPUTER, "1");
    assert.equal(startArgs?.env?.ZAKURA_ENABLE_BROWSER, "1");
    assert.equal(startArgs?.env?.DISPLAY, ":99");
    assert.equal(startArgs?.env?.ZAKURA_DESKTOP_WIDTH, "1280");
    assert.equal(commands.length, 1);
    assert.equal(commands[0]!.at(-1), "shell");
  });
});
