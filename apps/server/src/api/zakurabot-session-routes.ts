import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppVariables } from "./routes.js";
import { ZakurabotAccessError, type ZakurabotIdentity } from "../services/zakurabot-channel.js";
import type { ZakurabotGateway } from "../services/zakurabot-gateway.js";

export function registerZakurabotSessionRoutes(app: Hono<{ Variables: AppVariables }>, gateway: ZakurabotGateway) {
  const api = new Hono<{ Variables: AppVariables }>();
  api.use("*", bodyLimit({ maxSize: 1024 }));
  api.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  api.onError((error, c) => error instanceof ZakurabotAccessError
    ? c.json({ error: error.message }, error.closeCode === 4401 ? 401 : 403)
    : c.json({ error: "Could not update this session. Please retry." }, 503));
  const identity = (c: { get: (key: "session") => AppVariables["session"] }): ZakurabotIdentity => {
    const session = c.get("session")!;
    return { tenantId: session.tenantId, userId: session.userId, displayName: session.email };
  };
  api.get("/:agentId", async (c) => c.json({ session: await gateway.channel.manageSession(identity(c), c.req.param("agentId"), "status") }));
  api.post("/:agentId", async (c) => {
    const input = z.object({ action: z.enum(["start", "stop", "new"]) }).safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "Choose start, stop or new" }, 400);
    const session = await gateway.channel.manageSession(identity(c), c.req.param("agentId"), input.data.action);
    await gateway.refresh();
    return c.json({ session });
  });
  app.route("/api/zakurabot/sessions", api);
}
