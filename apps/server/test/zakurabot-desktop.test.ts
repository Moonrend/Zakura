import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { agents } from "../src/db/schema.js";
import { MAX_SCREENSHOT_BYTES } from "../src/services/agent-screenshot.js";
import { zakurabotHarness } from "./helpers/zakurabot.js";

describe("Zakura Bot desktop frames", () => {
  let h: Awaited<ReturnType<typeof zakurabotHarness>>;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=", "base64");
  let afterCapture: (() => Promise<void>) | undefined;
  let supported = true;
  let capture = () => ({ stdout: png.toString("base64"), stderr: "", exitCode: 0 });
  before(async () => { h = await zakurabotHarness({ workspace: {
    async getDesktopInfo() { return { enabled: supported, supported, containerStatus: "running", width: 1, height: 1,
      coordinateSpace: "desktop pixels, origin top-left", cdpUrl: "http://private-runner:9222", novncUrl: "http://private-runner:6080",
      dockerId: "PRIVATE_CONTAINER" } as never; },
    async ensureStarted(_agent, options) { assert.equal(options?.require, "display"); return {} as never; },
    async execInWorkspace() { await afterCapture?.(); return capture(); },
  } }); });
  after(async () => { await h?.close(); });
  const headers = (token: string) => ({ authorization: `Bearer ${token}` });
  const get = (path: string, token: string) => fetch(`${h.url}/api/zakurabot/${path}`, { headers: headers(token) });

  it("serves complete PNGs behind device authorization and advertises the client contract", async () => {
    const ctx = await h.access(), other = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    const path = `agents/${agentId}/desktop`;
    assert.equal((await get(path, ctx.token)).status, 409);
    assert.equal((await get(`${path}/frame`, ctx.token)).status, 409);
    await h.db.update(agents).set({ enableComputer: true }).where(eq(agents.id, agentId));
    assert.equal((await (await get("me", ctx.token)).json()).capabilities.includes("desktop_frames"), true);
    assert.equal((await (await get(`agents/${agentId}`, ctx.token)).json()).agent.capabilities.desktop, true);
    const response = await get(path, ctx.token);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const info = await response.json();
    assert.equal(info.enabled, true);
    assert.equal(info.supported, true);
    assert.equal(info.status, "running");
    assert.equal(info.suggestedIntervalMs, 2000);
    assert.equal(info.maxFrameBytes, MAX_SCREENSHOT_BYTES);
    assert.equal(info.frameUrl, `${h.url}/api/zakurabot/${path}/frame`);
    assert.equal(info.frameAuthorization, "Bearer");
    assert.equal(JSON.stringify(info).includes("private-runner"), false);
    assert.equal(JSON.stringify(info).includes("PRIVATE_CONTAINER"), false);
    assert.equal((await fetch(info.frameUrl)).status, 401);
    assert.equal((await fetch(info.frameUrl, { headers: headers(h.adminToken(ctx.tenantId)) })).status, 401);
    assert.equal((await fetch(info.frameUrl, { headers: headers(other.token) })).status, 403);
    const frame = await fetch(info.frameUrl, { headers: headers(ctx.token) });
    assert.equal(frame.status, 200);
    assert.equal(frame.headers.get("content-type"), "image/png");
    assert.equal(frame.headers.get("content-length"), String(png.length));
    assert.equal(frame.headers.get("x-frame-width"), "1");
    assert.equal(frame.headers.get("x-frame-height"), "1");
    assert.ok(Number.isFinite(Date.parse(frame.headers.get("x-frame-captured-at")!)));
    assert.equal(frame.headers.get("cache-control"), "no-store");
    assert.equal(frame.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await frame.arrayBuffer()), png);
  });

  it("rechecks revocation and Computer access after a slow capture", async () => {
    const ctx = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    await h.db.update(agents).set({ enableComputer: true }).where(eq(agents.id, agentId));
    afterCapture = async () => { await h.db.update(agents).set({ enableComputer: false }).where(eq(agents.id, agentId)); };
    try {
      const disabled = await get(`agents/${agentId}/desktop/frame`, ctx.token);
      assert.equal(disabled.status, 409);
      assert.match(disabled.headers.get("content-type")!, /application\/json/);
      await h.db.update(agents).set({ enableComputer: true }).where(eq(agents.id, agentId));
      afterCapture = async () => { await h.store.revokeDevice(ctx.tenantId, ctx.device.id); };
      const revoked = await get(`agents/${agentId}/desktop/frame`, ctx.token);
      assert.equal(revoked.status, 401);
      assert.match(revoked.headers.get("content-type")!, /application\/json/);
    } finally { afterCapture = undefined; }
  });

  it("reports unsupported workspaces and sanitizes capture failures or incomplete images", async () => {
    const ctx = await h.access();
    const agentId = ctx.bindings[0]!.agentId;
    await h.db.update(agents).set({ enableComputer: true }).where(eq(agents.id, agentId));
    supported = false;
    try {
      const info = await (await get(`agents/${agentId}/desktop`, ctx.token)).json();
      assert.equal(info.supported, false);
      assert.equal(info.frameUrl, null);
      assert.equal((await get(`agents/${agentId}/desktop/frame`, ctx.token)).status, 409);
    } finally { supported = true; }
    const original = capture;
    try {
      for (const stdout of [png.subarray(0, -12).toString("base64"), "PRIVATE_RUNNER_ERROR",
        Buffer.alloc(MAX_SCREENSHOT_BYTES + 3).toString("base64")]) {
        capture = () => ({ stdout, stderr: "PRIVATE_RUNNER_ERROR", exitCode: 0 });
        const result = await get(`agents/${agentId}/desktop/frame`, ctx.token);
        assert.equal(result.status, 503);
        assert.equal((await result.text()).includes("PRIVATE_RUNNER_ERROR"), false);
      }
      capture = () => ({ stdout: "", stderr: "PRIVATE_RUNNER_ERROR", exitCode: 1 });
      const result = await get(`agents/${agentId}/desktop/frame`, ctx.token);
      assert.equal(result.status, 503);
      assert.equal((await result.text()).includes("PRIVATE_RUNNER_ERROR"), false);
    } finally { capture = original; }
  });
});
