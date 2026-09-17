import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { zakurabotAuthorizations, zakurabotDevices, tenants } from "../src/db/schema.js";
import { zakurabotHarness } from "./helpers/zakurabot.js";

describe("Zakura Bot device authorization", () => {
  let h: Awaited<ReturnType<typeof zakurabotHarness>>;
  before(async () => { h = await zakurabotHarness(); });
  after(async () => { await h?.close(); });
  const post = (path: string, body: unknown, token?: string) => fetch(`${h.url}/api/zakurabot/${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  const begin = async () => {
    const response = await post("oauth/device-code", { name: "Test phone" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.status, 200);
    return await response.json() as { device_code: string; user_code: string; verification_uri_complete: string };
  };
  it("requires tenant consent, redeems once, rotates refresh tokens without replacing the device, and revokes", async () => {
    const ctx = await h.access(2), other = await h.access();
    const grant = await begin();
    assert.match(grant.verification_uri_complete, /console\/zakurabot\/authorize\?user_code=/);
    const poll = () => post("oauth/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: grant.device_code });
    assert.equal((await (await poll()).json()).error, "authorization_pending");
    const consent = { user_code: grant.user_code, approve: true, bindingIds: ctx.bindings.map((b) => b.id) };
    assert.equal((await post("authorization", consent)).status, 401);
    assert.equal((await post("authorization", consent, ctx.token)).status, 401);
    assert.equal((await post("authorization", consent, h.adminToken(ctx.tenantId, "member"))).status, 403);
    assert.equal((await post("authorization", consent, h.adminToken(other.tenantId))).status, 400);
    const info = await fetch(`${h.url}/api/zakurabot/authorization?user_code=${grant.user_code}`, {
      headers: { authorization: `Bearer ${h.adminToken(ctx.tenantId)}` },
    });
    const body = await info.text();
    assert.equal(body.includes(other.bindings[0]!.id), false);
    assert.equal(body.includes(grant.device_code), false);
    assert.equal((await post("authorization", consent, h.adminToken(ctx.tenantId))).status, 200);
    const response = await poll();
    assert.equal(response.status, 200);
    const tokens = await response.json() as { access_token: string; refresh_token: string; device: { id: string } };
    const device = await h.store.authenticate(tokens.access_token);
    assert.equal(device?.id, tokens.device.id);
    assert.equal(device?.tenantId, ctx.tenantId);
    assert.notEqual(device?.refreshTokenHash, tokens.refresh_token);
    assert.equal((await (await poll()).json()).error, "invalid_grant");
    const socket = await h.connect(tokens.access_token);
    assert.equal((await socket.wait("ready")).agents.length, 2);
    socket.send({ type: "send", agentId: ctx.bindings[0]!.agentId, clientMessageId: "before-refresh", text: "Remember me" });
    await socket.wait("message");
    const refresh = () => post("oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    const rotated = await (await refresh()).json() as typeof tokens;
    assert.equal(rotated.device.id, tokens.device.id);
    assert.notEqual(rotated.access_token, tokens.access_token);
    assert.equal(await h.store.authenticate(tokens.access_token), null);
    assert.equal((await refresh()).status, 400);
    const nextSocket = await h.connect(rotated.access_token);
    await nextSocket.wait("ready");
    assert.equal((await nextSocket.wait("message")).message.text, "Remember me");
    assert.equal((await post("oauth/revoke", { token: rotated.refresh_token })).status, 200);
    assert.equal(await nextSocket.closed, 4401);
    assert.equal(await h.store.authenticate(rotated.access_token), null);
    assert.equal((await post("oauth/token", { grant_type: "refresh_token", refresh_token: rotated.refresh_token })).status, 400);
  });
  it("rejects denied, expired and suspended grants, and accepts only one simultaneous refresh", async () => {
    const ctx = await h.access();
    const denied = await begin();
    await post("authorization", { user_code: denied.user_code, approve: false }, h.adminToken(ctx.tenantId));
    const poll = (code: string) => post("oauth/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code });
    assert.equal((await (await poll(denied.device_code)).json()).error, "access_denied");
    const expired = await begin();
    await h.db.update(zakurabotAuthorizations).set({ expiresAt: new Date(0) });
    assert.equal((await (await poll(expired.device_code)).json()).error, "expired_token");
    const grant = await begin();
    await post("authorization", { user_code: grant.user_code, approve: true, bindingIds: [ctx.bindings[0]!.id] }, h.adminToken(ctx.tenantId));
    const token = await (await poll(grant.device_code)).json() as { refresh_token: string; device: { id: string } };
    // Refresh continues after the short access token expires.
    await h.db.update(zakurabotDevices).set({ expiresAt: new Date(0) }).where(eq(zakurabotDevices.id, token.device.id));
    const refresh = () => post("oauth/token", { grant_type: "refresh_token", refresh_token: token.refresh_token });
    const responses = await Promise.all([refresh(), refresh()]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400]);
    const rotated = await responses.find((r) => r.status === 200)!.json() as { refresh_token: string };
    await h.db.update(tenants).set({ suspendedAt: new Date() }).where(eq(tenants.id, ctx.tenantId));
    assert.equal((await post("oauth/token", { grant_type: "refresh_token", refresh_token: rotated.refresh_token })).status, 400);
  });
});
