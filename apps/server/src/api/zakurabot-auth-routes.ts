import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { isSessionAdmin } from "../services/auth.js";
import type { ZakurabotGateway } from "../services/zakurabot-gateway.js";
import { channelIdSchema } from "../services/zakurabot-protocol.js";
import type { AppVariables } from "./routes.js";

const consentSchema = z.object({
  user_code: z.string().min(1).max(32), approve: z.boolean(),
  bindingIds: z.array(channelIdSchema).max(16).default([]),
});

export function registerZakurabotAuthRoutes(app: Hono<{ Variables: AppVariables }>, gateway: ZakurabotGateway, baseUrl: string) {
  const { store, ingress, agents } = gateway.channel.deps;
  // Bound anonymous grant creation and polling, without trusting proxy-supplied IP headers.
  let windowStart = Date.now(), starts = 0, polls = 0;
  app.use("/api/zakurabot/oauth/*", bodyLimit({ maxSize: 4096 }));
  app.use("/api/zakurabot/oauth/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); starts = polls = 0; }
    if (c.req.path.endsWith("/device-code") ? ++starts > 120 : ++polls > 4000) {
      c.header("Retry-After", "60");
      return c.json({ error: "slow_down" }, 429);
    }
    await next();
  });
  app.post("/api/zakurabot/oauth/device-code", async (c) => {
    const input = z.object({ name: z.string().trim().min(1).max(128) }).safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_request" }, 400);
    const grant = await store.beginAuthorization(input.data.name);
    const verification = `${baseUrl.replace(/\/+$/, "")}/console/zakurabot/authorize`;
    return c.json({ ...grant, verification_uri: verification,
      verification_uri_complete: `${verification}?user_code=${encodeURIComponent(grant.user_code)}` });
  });
  app.post("/api/zakurabot/oauth/token", async (c) => {
    const input = z.discriminatedUnion("grant_type", [
      z.object({ grant_type: z.literal("urn:ietf:params:oauth:grant-type:device_code"), device_code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
      z.object({ grant_type: z.literal("refresh_token"), refresh_token: z.string().max(256) }),
    ]).safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_request" }, 400);
    if (input.data.grant_type === "refresh_token") {
      const credentials = await store.refreshCredentials(input.data.refresh_token);
      return credentials ? c.json(credentials) : c.json({ error: "invalid_grant" }, 400);
    }
    const result = await store.redeemAuthorization(input.data.device_code);
    return result.credentials ? c.json(result.credentials) : c.json({ error: result.error }, 400);
  });
  app.post("/api/zakurabot/oauth/revoke", async (c) => {
    const input = z.object({ token: z.string().max(256) }).safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_request" }, 400);
    const device = await store.revokeCredential(input.data.token);
    if (device) await gateway.disconnectDevice(device.tenantId, device.id);
    return c.json({ ok: true });
  });
  app.use("/api/zakurabot/authorization", bodyLimit({ maxSize: 8192 }));
  app.use("/api/zakurabot/authorization", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    if (!isSessionAdmin(session)) return c.json({ error: "需要租户管理员权限来授权设备" }, 403);
    await next();
  });
  app.get("/api/zakurabot/authorization", async (c) => {
    const info = await store.authorizationInfo(c.req.query("user_code") ?? "");
    if (!info) return c.json({ error: "授权码无效、已使用或已过期，请在 App 中重试" }, 404);
    const tenantId = c.get("session")!.tenantId;
    const bindings = await Promise.all((await ingress.listBindings(tenantId, "zakurabot"))
      .filter((binding) => binding.enabled).map(async (binding) => ({ id: binding.id, agentId: binding.agentId,
        name: (await agents.get(tenantId, binding.agentId))?.name ?? binding.label, label: binding.label })));
    return c.json({ ...info, bindings });
  });
  app.post("/api/zakurabot/authorization", async (c) => {
    const parsed = consentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "授权信息无效" }, 400);
    const input = parsed.data;
    const info = await store.authorizationInfo(input.user_code);
    if (!info) return c.json({ error: "授权码已过期或已使用" }, 409);
    if (!input.approve) {
      return await store.decideAuthorization(input.user_code, null) ? c.json({ ok: true }) : c.json({ error: "授权码已使用" }, 409);
    }
    if (!input.bindingIds.length || new Set(input.bindingIds).size !== input.bindingIds.length) {
      return c.json({ error: "请选择 1–16 个不重复的绑定" }, 400);
    }
    try {
      const { device } = await gateway.channel.issueDevice(c.get("session")!.tenantId,
        { name: info.name, bindingIds: input.bindingIds, expiresInDays: 90 });
      if (!await store.decideAuthorization(input.user_code, device.id)) {
        await store.revokeDevice(device.tenantId, device.id);
        return c.json({ error: "授权码已使用" }, 409);
      }
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "授权失败" }, 400);
    }
  });
}
