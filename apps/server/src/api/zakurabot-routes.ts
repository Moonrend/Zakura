import type { Hono } from "hono";
import { z } from "zod";
import { isSessionAdmin } from "../services/auth.js";
import type { AppVariables } from "./routes.js";
import type { ZakurabotGateway } from "../services/zakurabot-gateway.js";
import { channelIdSchema } from "../services/zakurabot-protocol.js";
import { zakurabotDeviceView } from "../services/zakurabot-store.js";

const issueSchema = z.object({
  name: z.string().trim().min(1).max(128),
  bindingIds: z.array(channelIdSchema).min(1).max(16).refine((ids) => new Set(ids).size === ids.length),
  expiresInDays: z.number().int().min(1).max(365).default(90),
});

export function registerZakurabotRoutes(
  app: Hono<{ Variables: AppVariables }>,
  gateway: ZakurabotGateway,
  publicBaseUrl: string,
) {
  const store = gateway.channel.deps.store;
  app.use("/api/zakurabot/devices", async (c, next) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    if (!isSessionAdmin(session)) return c.json({ error: "需要租户管理员权限" }, 403);
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use("/api/zakurabot/devices/*", async (c, next) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    if (!isSessionAdmin(session)) return c.json({ error: "需要租户管理员权限" }, 403);
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/api/zakurabot/devices", async (c) => {
    const devices = await store.listDevices(c.get("session")!.tenantId);
    return c.json({ devices: devices.map(zakurabotDeviceView), baseUrl: publicBaseUrl.replace(/\/+$/, "") });
  });
  app.post("/api/zakurabot/devices", async (c) => {
    const parsed = issueSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "name、bindingIds 必填；有效期须为 1–365 天" }, 400);
    try {
      const { device, token } = await gateway.channel.issueDevice(c.get("session")!.tenantId, parsed.data);
      return c.json({ device: zakurabotDeviceView(device), token, baseUrl: publicBaseUrl.replace(/\/+$/, "") }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "创建设备失败" }, 400);
    }
  });
  app.delete("/api/zakurabot/devices/:id", async (c) => {
    const tenantId = c.get("session")!.tenantId;
    const id = c.req.param("id");
    if (!await store.revokeDevice(tenantId, id)) return c.json({ error: "设备不存在" }, 404);
    await gateway.disconnectDevice(tenantId, id);
    return c.json({ ok: true });
  });
}
