import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { tenantMemberships } from "../src/db/schema.js";
import { zakurabotHarness } from "./helpers/zakurabot.js";

describe("Zakura Bot workspace exec", () => {
  let h: Awaited<ReturnType<typeof zakurabotHarness>>;
  let containerStatus = "running";
  let output = { stdout: "", stderr: "", exitCode: 0 };
  const calls: Array<{ agentId: string; command: string[] }> = [];
  before(async () => { h = await zakurabotHarness({ agentComputer: false, workspace: {
    async getDesktopInfo() { return { enabled: false, supported: false, containerStatus, width: 1, height: 1,
      coordinateSpace: "desktop pixels, origin top-left", dockerId: "PRIVATE_CONTAINER" } as never; },
    async ensureStarted() { return {} as never; },
    async execInWorkspace(agent: { id: string }, command: string[]) {
      calls.push({ agentId: agent.id, command });
      return output;
    },
  } }); });
  after(async () => { await h?.close(); });
  const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  const exec = (agentId: string, token: string, body: unknown) =>
    fetch(`${h.url}/api/zakurabot/agents/${agentId}/exec`, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
  const suspend = (ctx: { tenantId: string; userId: string }) => h.db.update(tenantMemberships)
    .set({ status: "suspended" }).where(and(eq(tenantMemberships.tenantId, ctx.tenantId), eq(tenantMemberships.userId, ctx.userId)));

  it("runs a command in the agent workspace and returns merged output, exit code and timestamp", async () => {
    const ctx = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    output = { stdout: "hello\n", stderr: "warn\n", exitCode: 0 };
    const response = await exec(agentId, ctx.token, { command: "echo hello" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as { output: string; exitCode: number; finishedAt: string };
    assert.equal(body.output, "hello\nwarn\n");
    assert.equal(body.exitCode, 0);
    assert.ok(Number.isFinite(Date.parse(body.finishedAt)));
    assert.deepEqual(calls.at(-1), { agentId, command: ["bash", "-lc", "echo hello"] });
    output = { stdout: "boom\n", stderr: "", exitCode: 1 };
    const failed = await exec(agentId, ctx.token, { command: "false" });
    assert.equal(failed.status, 200);
    assert.equal((await failed.json() as { exitCode: number }).exitCode, 1);
  });

  it("rejects execution when the workspace is not running", async () => {
    const ctx = await h.access();
    const before = calls.length;
    containerStatus = "exited";
    try {
      const response = await exec(ctx.bindings[0]!.agentId, ctx.token, { command: "echo hi" });
      assert.equal(response.status, 409);
      assert.equal(calls.length, before);
    } finally { containerStatus = "running"; }
  });

  it("scopes by tenant and roster and rejects suspended members", async () => {
    const ctx = await h.access(), other = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    const foreign = await exec(other.bindings[0]!.agentId, ctx.token, { command: "ls" });
    assert.equal(foreign.status, 403);
    assert.equal((await exec(agentId, other.token, { command: "ls" })).status, 403);
    assert.equal((await exec(agentId, h.adminToken(ctx.tenantId), { command: "ls" })).status, 200);
    const peer = await h.addUser(ctx.tenantId);
    await suspend({ tenantId: ctx.tenantId, userId: peer.userId });
    h.gateway.disconnectUser(ctx.tenantId, peer.userId);
    assert.equal((await exec(agentId, peer.token, { command: "ls" })).status, 401);
    assert.equal((await fetch(`${h.url}/api/zakurabot/agents/${agentId}/exec`, { method: "POST",
      headers: headers(ctx.token) })).status, 400);
  });

  it("validates the command body", async () => {
    const ctx = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    const before = calls.length;
    for (const body of [{}, { command: "" }, { command: "x".repeat(2001) }, { command: 5 }, { command: null }]) {
      assert.equal((await exec(agentId, ctx.token, body)).status, 400);
    }
    assert.equal(calls.length, before);
  });

  it("caps oversized output instead of buffering it unbounded", async () => {
    const ctx = await h.access();
    output = { stdout: "a".repeat(300 * 1024), stderr: "", exitCode: 0 };
    const body = await (await exec(ctx.bindings[0]!.agentId, ctx.token, { command: "yes" }))
      .json() as { output: string; truncated: boolean };
    assert.equal(body.truncated, true);
    assert.ok(Buffer.byteLength(body.output) <= 256 * 1024);
  });
});
