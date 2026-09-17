import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppVariables } from "./routes.js";
import type { ZakurabotDevice } from "../db/schema.js";
import { ZakurabotAccessError } from "../services/zakurabot-channel.js";
import type { ZakurabotGateway } from "../services/zakurabot-gateway.js";

export function registerZakurabotSessionRoutes(app: Hono<{ Variables: AppVariables }>, gateway: ZakurabotGateway) {
  const api = new Hono<{ Variables: { device: ZakurabotDevice } }>();
  api.use("*", bodyLimit({ maxSize: 1024 }));
  api.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const token = c.req.header("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
    const device = token ? await gateway.channel.deps.store.authenticate(token) : null;
    if (!device) return c.json({ error: "Sign in to Zakura again" }, 401);
    c.set("device", device);
    await next();
  });
  api.onError((error, c) => error instanceof ZakurabotAccessError
    ? c.json({ error: error.message }, error.closeCode === 4401 ? 401 : 403)
    : c.json({ error: "Could not update this session. Please retry." }, 503));
  api.get("/:agentId", async (c) => c.json({ session: await gateway.channel.manageSession(c.get("device"), c.req.param("agentId"), "status") }));
  api.post("/:agentId", async (c) => {
    const input = z.object({ action: z.enum(["start", "stop", "new"]) }).safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "Choose start, stop or new" }, 400);
    const session = await gateway.channel.manageSession(c.get("device"), c.req.param("agentId"), input.data.action);
    await gateway.refresh();
    return c.json({ session });
  });
  app.route("/api/zakurabot/sessions", api);
}
