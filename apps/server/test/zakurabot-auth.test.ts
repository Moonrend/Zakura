import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { zakurabotAuthorizations, zakurabotDevices, tenantMemberships, tenants, users } from "../src/db/schema.js";
import { zakurabotHarness } from "./helpers/zakurabot.js";

describe("Zakura Bot device authorization", () => {
  let h: Awaited<ReturnType<typeof zakurabotHarness>>;
  before(async () => { h = await zakurabotHarness(); });
  after(async () => { await h?.close(); });
  const post = (path: string, body: unknown, token?: string) => fetch(`${h.url}/api/zakurabot/${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  const begin = async () => {
    const verifier = randomBytes(32).toString("base64url");
    const response = await post("oauth/device-code", { name: "Test phone", code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url") });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.status, 200);
    return { ...await response.json() as { device_code: string; user_code: string; verification_uri_complete: string }, verifier };
  };
  const poll = (grant: { device_code: string; verifier: string }) => post("oauth/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: grant.device_code, code_verifier: grant.verifier,
  });
  const allowPoll = (grant: { device_code: string }) => h.db.update(zakurabotAuthorizations).set({ lastPolledAt: new Date(0) })
    .where(eq(zakurabotAuthorizations.codeHash, createHash("sha256").update(grant.device_code).digest("hex")));
  it("requires tenant consent, redeems once, rotates refresh tokens without replacing the device, and revokes", async () => {
    const ctx = await h.access(2), other = await h.access();
    const grant = await begin();
    assert.match(grant.verification_uri_complete, /console\/zakurabot\/authorize\?user_code=/);
    assert.equal((await (await poll(grant)).json()).error, "authorization_pending");
    const consent = { user_code: grant.user_code, approve: true, bindingIds: ctx.bindings.map((b) => b.id) };
    assert.equal((await post("authorization", consent)).status, 401);
    assert.equal((await post("authorization", consent, ctx.token)).status, 401);
    await h.db.update(tenantMemberships).set({ role: "member" }).where(eq(tenantMemberships.tenantId, ctx.tenantId));
    assert.equal((await post("authorization", consent, h.adminToken(ctx.tenantId, "member"))).status, 403);
    await h.db.update(tenantMemberships).set({ role: "owner" }).where(eq(tenantMemberships.tenantId, ctx.tenantId));
    assert.equal((await post("authorization", consent, h.adminToken(other.tenantId))).status, 403);
    const info = await fetch(`${h.url}/api/zakurabot/authorization?user_code=${grant.user_code}`, {
      headers: { authorization: `Bearer ${h.adminToken(ctx.tenantId)}` },
    });
    const body = await info.text();
    assert.equal(body.includes(other.bindings[0]!.id), false);
    assert.equal(body.includes(grant.device_code), false);
    assert.equal((await post("authorization", consent, h.adminToken(ctx.tenantId))).status, 200);
    await allowPoll(grant);
    const response = await poll(grant);
    assert.equal(response.status, 200);
    const tokens = await response.json() as { access_token: string; refresh_token: string; device: { id: string } };
    const device = await h.store.authenticate(tokens.access_token);
    assert.equal(device?.id, tokens.device.id);
    assert.equal(device?.tenantId, ctx.tenantId);
    assert.equal(device?.userId, ctx.tenantId);
    assert.notEqual(device?.refreshTokenHash, tokens.refresh_token);
    assert.equal((await (await poll(grant)).json()).error, "invalid_grant");
    const socket = await h.connect(tokens.access_token);
    assert.equal((await socket.wait("ready")).agents.length, 2);
    socket.send({ type: "send", agentId: ctx.bindings[0]!.agentId, clientMessageId: "before-refresh", text: "Remember me" });
    await socket.wait("message");
    const refresh = () => post("oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    const rotated = await (await refresh()).json() as typeof tokens;
    assert.equal(rotated.device.id, tokens.device.id);
    assert.notEqual(rotated.access_token, tokens.access_token);
    assert.equal(await h.store.authenticate(tokens.access_token), null);
    // The old socket must not report an authentication failure: the App reconnects with the rotated token.
    assert.equal(await socket.closed, 1012);
    const rotationError = socket.frames.findLast((frame) => frame.type === "error");
    assert.equal(rotationError?.type === "error" && rotationError.fatal, false);
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
    assert.equal((await (await poll(denied)).json()).error, "access_denied");
    const expired = await begin();
    await h.db.update(zakurabotAuthorizations).set({ expiresAt: new Date(0) });
    assert.equal((await (await poll(expired)).json()).error, "expired_token");
    const grant = await begin();
    await post("authorization", { user_code: grant.user_code, approve: true, bindingIds: [ctx.bindings[0]!.id] }, h.adminToken(ctx.tenantId));
    const token = await (await poll(grant)).json() as { refresh_token: string; device: { id: string } };
    // Refresh continues after the short access token expires.
    await h.db.update(zakurabotDevices).set({ expiresAt: new Date(0) }).where(eq(zakurabotDevices.id, token.device.id));
    const refresh = () => post("oauth/token", { grant_type: "refresh_token", refresh_token: token.refresh_token });
    const responses = await Promise.all([refresh(), refresh()]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400]);
    const rotated = await responses.find((r) => r.status === 200)!.json() as { refresh_token: string };
    await h.db.update(tenants).set({ suspendedAt: new Date() }).where(eq(tenants.id, ctx.tenantId));
    assert.equal((await post("oauth/token", { grant_type: "refresh_token", refresh_token: rotated.refresh_token })).status, 400);
  });

  it("requires S256 proof, persists polling backoff, and permits one concurrent redemption", async () => {
    const ctx = await h.access();
    assert.equal((await post("oauth/device-code", { name: "Missing challenge", code_challenge_method: "S256" })).status, 400);
    assert.equal((await post("oauth/device-code", { name: "Plain", code_challenge_method: "plain", code_challenge: "x".repeat(43) })).status, 400);
    const grant = await begin();
    assert.equal((await (await poll(grant)).json()).error, "authorization_pending");
    const fast = await poll(grant);
    assert.equal(fast.headers.get("retry-after"), "10");
    assert.equal((await fast.json()).error, "slow_down");
    await allowPoll(grant);
    await post("authorization", { user_code: grant.user_code, approve: true, bindingIds: [ctx.bindings[0]!.id] }, h.adminToken(ctx.tenantId));
    assert.equal((await (await post("oauth/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: grant.device_code,
    })).json()).error, "invalid_grant");
    assert.equal((await (await poll({ ...grant, verifier: "wrong".repeat(10) })).json()).error, "invalid_grant");
    const responses = await Promise.all([poll(grant), poll(grant)]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
    const row = await h.db.query.zakurabotAuthorizations.findFirst({ where: eq(zakurabotAuthorizations.codeHash,
      createHash("sha256").update(grant.device_code).digest("hex")) });
    assert.equal(row?.intervalSeconds, 10);
    assert.equal(row?.status, "consumed");
    assert.equal(JSON.stringify(row).includes(grant.verifier), false);
    assert.equal(JSON.stringify(row).includes(grant.device_code), false);
  });

  it("preserves the existing v1 client device-code login without PKCE", async () => {
    const ctx = await h.access();
    const response = await post("oauth/device-code", { name: "Existing app" });
    assert.equal(response.status, 200);
    const grant = await response.json() as { device_code: string; user_code: string };
    assert.equal((await post("authorization", { user_code: grant.user_code, approve: true,
      bindingIds: [ctx.bindings[0]!.id] }, h.adminToken(ctx.tenantId))).status, 200);
    const tokens = await post("oauth/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: grant.device_code,
    });
    assert.equal(tokens.status, 200);
    const { access_token } = await tokens.json() as { access_token: string };
    assert.equal((await (await h.connect(access_token)).wait("ready")).agents[0]?.id, ctx.bindings[0]!.agentId);
  });

  it("lets a member bind allowed agents and invalidates credentials when membership, user, or binding access is removed", async () => {
    const ctx = await h.access(2);
    await h.db.update(tenantMemberships).set({ role: "member" }).where(eq(tenantMemberships.tenantId, ctx.tenantId));
    await h.ingress.approveUser(ctx.tenantId, ctx.bindings[0]!.id, ctx.tenantId);
    const grant = await begin();
    const session = h.adminToken(ctx.tenantId, "member");
    const info = await fetch(`${h.url}/api/zakurabot/authorization?user_code=${grant.user_code}`, { headers: { authorization: `Bearer ${session}` } });
    assert.deepEqual((await info.json()).bindings.map((binding: { id: string }) => binding.id), [ctx.bindings[0]!.id]);
    assert.equal((await post("authorization", { user_code: grant.user_code, approve: true, bindingIds: [ctx.bindings[1]!.id] }, session)).status, 403);
    assert.equal((await post("authorization", { user_code: grant.user_code, approve: true, bindingIds: [ctx.bindings[0]!.id] }, session)).status, 200);
    const tokens = await (await poll(grant)).json() as { access_token: string; refresh_token: string; device: { id: string } };
    const device = await h.store.authenticate(tokens.access_token);
    assert.ok(device);
    const socket = await h.connect(tokens.access_token);
    await socket.wait("ready");
    await h.ingress.denyUser(ctx.tenantId, ctx.bindings[0]!.id, ctx.tenantId);
    assert.equal((await h.channel.authorizedBindings(device)).bindings.length, 0);
    await h.gateway.refresh();
    assert.equal(await socket.closed, 4403);
    await h.ingress.approveUser(ctx.tenantId, ctx.bindings[0]!.id, ctx.tenantId);
    await h.db.update(tenantMemberships).set({ status: "suspended" }).where(eq(tenantMemberships.tenantId, ctx.tenantId));
    assert.equal(await h.store.authenticate(tokens.access_token), null);
    assert.equal((await post("oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status, 400);
    await h.db.update(tenantMemberships).set({ status: "active" }).where(eq(tenantMemberships.tenantId, ctx.tenantId));
    await h.db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, ctx.tenantId));
    assert.equal(await h.store.authenticate(tokens.access_token), null);
    assert.equal((await post("oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status, 400);
  });

  it("rechecks grants before redemption and does not turn an open ACL into a device-only allowlist", async () => {
    const ctx = await h.access();
    await h.db.update(tenantMemberships).set({ role: "member" }).where(eq(tenantMemberships.tenantId, ctx.tenantId));
    await h.ingress.saveBinding(ctx.tenantId, { id: ctx.bindings[0]!.id, agentId: ctx.bindings[0]!.agentId,
      platform: "zakurabot", profileKey: "remote-zakurabot", settings: { allowAll: true, allowedUsers: [] } });
    const grant = await begin();
    assert.equal((await post("authorization", { user_code: grant.user_code, approve: true, bindingIds: [ctx.bindings[0]!.id] }, h.adminToken(ctx.tenantId, "member"))).status, 200);
    assert.deepEqual((await h.ingress.getSettings(ctx.tenantId, ctx.bindings[0]!.id))?.allowedUsers, []);
    assert.equal((await poll(grant)).status, 200);
    const pending = await begin();
    await post("authorization", { user_code: pending.user_code, approve: true, bindingIds: [ctx.bindings[0]!.id] }, h.adminToken(ctx.tenantId, "member"));
    await h.ingress.saveBinding(ctx.tenantId, { id: ctx.bindings[0]!.id, agentId: ctx.bindings[0]!.agentId,
      platform: "zakurabot", profileKey: "remote-zakurabot", enabled: false });
    assert.equal((await (await poll(pending)).json()).error, "invalid_grant");
  });
});
