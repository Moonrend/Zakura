import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { PathJailError } from "@zakura/core";
import type { AppVariables } from "./routes.js";
import type { ZakurabotDevice } from "../db/schema.js";
import type { ZakurabotGateway } from "../services/zakurabot-gateway.js";
import { ZakurabotAccessError, ZakurabotInputError } from "../services/zakurabot-channel.js";
import { ZakurabotFileError } from "../services/zakurabot-files.js";
import { zakurabotDeviceView } from "../services/zakurabot-store.js";
import { ZAKURABOT_MAX_FILE_BYTES } from "../services/zakurabot-protocol.js";

/** These endpoints authenticate their own device bearer. Never promote it to a tenant session. */
export function isZakurabotAppPath(path: string): boolean {
  return /^\/api\/zakurabot\/(me|bots|agents)$/.test(path) ||
    /^\/api\/zakurabot\/agents\/[^/]+(?:\/(?:history|files(?:\/[^/]+)?))?$/.test(path);
}

export function registerZakurabotAppRoutes(
  app: Hono<{ Variables: AppVariables }>, gateway: ZakurabotGateway, baseUrl: string,
) {
  const channel = gateway.channel;
  const api = new Hono<{ Variables: { device: ZakurabotDevice } }>();
  api.use("*", async (c, next) => {
    if (!isZakurabotAppPath(c.req.path)) return next();
    c.header("Cache-Control", "no-store");
    const bearer = c.req.header("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
    const device = bearer ? await channel.deps.store.authenticate(bearer) : null;
    if (!device) return c.json({ error: "Invalid, expired, or revoked device token" }, 401);
    c.set("device", device);
    await next();
  });
  api.onError((error, c) => {
    if (error instanceof ZakurabotAccessError) return c.json({ error: error.message }, error.closeCode === 4401 ? 401 : 403);
    if (error instanceof ZakurabotInputError) return c.json({ error: error.message }, 400);
    if (error instanceof ZakurabotFileError) return c.json({ error: error.message }, error.status);
    if (error instanceof PathJailError) return c.json({ error: "Forbidden workspace path" }, 403);
    if ("code" in error && error.code === "ENOENT") return c.json({ error: "File not found" }, 404);
    // Workspace/runner errors can include local paths or credentials.
    return c.json({ error: "Zakura Bot operation is temporarily unavailable" }, 503);
  });

  api.get("/me", (c) => c.json({ device: zakurabotDeviceView(c.get("device")),
    baseUrl: baseUrl.replace(/\/+$/, ""), capabilities: channel.capabilities(), groups: "client" }));
  api.delete("/me", async (c) => {
    const device = c.get("device");
    await channel.deps.store.revokeDevice(device.tenantId, device.id);
    await gateway.disconnectDevice(device.tenantId, device.id);
    return c.json({ ok: true });
  });
  api.get("/agents", async (c) => c.json({ agents: (await channel.roster(c.get("device"))).agents }));
  api.get("/bots", async (c) => c.json({ bots: (await channel.roster(c.get("device"))).agents }));
  api.get("/agents/:id", async (c) => {
    const { agents } = await channel.roster(c.get("device"));
    const agent = agents.find((item) => item.id === c.req.param("id"));
    return agent ? c.json({ agent }) : c.json({ error: "Agent not authorized" }, 403);
  });
  api.get("/agents/:id/history", async (c) => {
    const parsed = z.coerce.number().int().min(1).max(100).safeParse(c.req.query("limit") ?? 100);
    if (!parsed.success) return c.json({ error: "limit must be between 1 and 100" }, 400);
    const { conversation } = await channel.resolveConversation(c.get("device"), c.req.param("id"));
    return c.json({ messages: await channel.history(conversation, parsed.data) });
  });
  api.post("/agents/:id/files", bodyLimit({ maxSize: ZAKURABOT_MAX_FILE_BYTES + 64 * 1024,
    onError: (c) => c.json({ error: "File upload is too large" }, 413) }), async (c) => {
    const { conversation } = await channel.resolveConversation(c.get("device"), c.req.param("id"));
    if (!channel.deps.files) return c.json({ error: "File uploads are unavailable" }, 503);
    const form = await c.req.parseBody({ all: true }).catch(() => null);
    const file = form?.file;
    if (!file || typeof file === "string" || Array.isArray(file)) return c.json({ error: "multipart file is required" }, 400);
    if (!file.size || file.size > ZAKURABOT_MAX_FILE_BYTES) return c.json({ error: "Files must be nonempty and at most 16 MiB" }, 413);
    const data = Buffer.from(await file.arrayBuffer());
    // Recheck after receiving a potentially slow upload.
    await channel.resolveConversation(c.get("device"), c.req.param("id"));
    const uploaded = await channel.deps.files.upload(conversation, { name: file.name, type: file.type, data });
    await channel.resolveConversation(c.get("device"), c.req.param("id"));
    return c.json({ file: uploaded }, 201);
  });
  api.get("/agents/:id/files/:fileId", async (c) => {
    const { conversation } = await channel.resolveConversation(c.get("device"), c.req.param("id"));
    if (!channel.deps.files) return c.json({ error: "File downloads are unavailable" }, 503);
    const { file, data } = await channel.deps.files.download(conversation, c.req.param("fileId"));
    await channel.resolveConversation(c.get("device"), c.req.param("id"));
    return new Response(data, { headers: {
      "Content-Type": file.mime, "Content-Length": String(data.length), "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
    } });
  });
  app.route("/api/zakurabot", api);
}
