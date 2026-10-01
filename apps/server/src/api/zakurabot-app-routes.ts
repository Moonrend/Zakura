import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { PathJailError, log } from "@zakura/core";
import type { AppVariables } from "./routes.js";
import type { ZakurabotGateway } from "../services/zakurabot-gateway.js";
import { ZakurabotAccessError, ZakurabotInputError, type ZakurabotIdentity } from "../services/zakurabot-channel.js";
import { ZakurabotFileError } from "../services/zakurabot-files.js";
import { ZAKURABOT_MAX_FILE_BYTES } from "../services/zakurabot-protocol.js";

import { captureDesktop } from "../services/agent-desktop.js";
import { MAX_SCREENSHOT_BYTES } from "../services/agent-screenshot.js";
import type { AgentWorkspaceService } from "../services/agent-workspace.js";
import { ZakurabotInteractionError, zakurabotAnswerSchema } from "../services/zakurabot-interactions.js";

const zakurabotExecBody = z.object({ command: z.string().min(1).max(2000) });
const ZAKURABOT_EXEC_TIMEOUT_MS = 60_000;
const ZAKURABOT_MAX_EXEC_OUTPUT_BYTES = 256 * 1024;

const zakurabotReactionBody = z.object({ emoji: z.string().trim().min(1)
  .refine((value) => [...value].length <= 16, "emoji must be at most 16 characters") });

function clipExecOutput(stdout: string, stderr: string) {
  const text = `${stdout}${stderr}`;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= ZAKURABOT_MAX_EXEC_OUTPUT_BYTES) return { output: text, truncated: false };
  return { output: bytes.subarray(0, ZAKURABOT_MAX_EXEC_OUTPUT_BYTES).toString("utf8"), truncated: true };
}

/**
 * Zakura Bot App API：与控制台共用同一套会话鉴权（OAuth access token 或控制台会话），
 * 以用户自身权限访问。除这些路由外，客户端还可直接调用 /api/agents 等标准租户 API。
 */
export function registerZakurabotAppRoutes(
  app: Hono<{ Variables: AppVariables }>, gateway: ZakurabotGateway, baseUrl: string,
  workspace?: Pick<AgentWorkspaceService, "getDesktopInfo" | "execInWorkspace" | "ensureStarted">,
) {
  const channel = gateway.channel;
  const api = new Hono<{ Variables: AppVariables }>();
  api.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  const identity = (c: { get: (key: "session") => AppVariables["session"] }): ZakurabotIdentity => {
    const session = c.get("session")!;
    return { tenantId: session.tenantId, userId: session.userId, displayName: session.email };
  };
  api.onError((error, c) => {
    if (error instanceof ZakurabotAccessError) return c.json({ error: error.message }, error.closeCode === 4401 ? 401 : 403);
    if (error instanceof ZakurabotInputError) return c.json({ error: error.message }, 400);
    if (error instanceof ZakurabotFileError) return c.json({ error: error.message }, error.status);
    if (error instanceof ZakurabotInteractionError) return c.json({ error: error.message }, error.status);
    if (error instanceof PathJailError) return c.json({ error: "Forbidden workspace path" }, 403);
    if ("code" in error && error.code === "ENOENT") return c.json({ error: "File not found" }, 404);
    // Workspace/runner errors can include local paths or credentials.
    log.error("zakurabot.app_unhandled", {
      path: c.req.path,
      err_message: error instanceof Error ? error.message : String(error),
      cause: error instanceof Error && error.cause ? String(error.cause) : undefined,
      stack: error instanceof Error ? error.stack?.split("\n").slice(0, 6).join(" | ") : undefined,
    });
    return c.json({ error: "Zakura Bot operation is temporarily unavailable" }, 503);
  });

  api.get("/agents", async (c) => c.json({ agents: (await channel.roster(identity(c))).agents }));
  api.get("/bots", async (c) => c.json({ bots: (await channel.roster(identity(c))).agents }));
  api.get("/spaces", async (c) => {
    const actor = identity(c);
    const [spaces, agentRows] = await Promise.all([
      channel.deps.agents.spaces.list(actor.tenantId),
      channel.deps.agents.list(actor.tenantId),
    ]);
    const counts = new Map<string, number>();
    for (const agent of agentRows) {
      counts.set(agent.spaceId, (counts.get(agent.spaceId) ?? 0) + 1);
    }
    return c.json({
      spaces: spaces.map((space) => ({
        id: space.id,
        name: space.name,
        slug: space.slug,
        agentCount: counts.get(space.id) ?? 0,
      })),
    });
  });
  api.get("/agents/:id", async (c) => {
    const { agents } = await channel.roster(identity(c));
    const agent = agents.find((item) => item.id === c.req.param("id"));
    return agent ? c.json({ agent }) : c.json({ error: "Agent not available" }, 404);
  });
  api.get("/agents/:id/history", async (c) => {
    const parsed = z.coerce.number().int().min(1).max(100).safeParse(c.req.query("limit") ?? 100);
    if (!parsed.success) return c.json({ error: "limit must be between 1 and 100" }, 400);
    const before = c.req.query("before") === undefined ? undefined
      : z.coerce.number().int().min(1).safeParse(c.req.query("before"));
    if (before && !before.success) return c.json({ error: "before must be a positive integer" }, 400);
    const { conversation } = await channel.resolveConversation(identity(c), c.req.param("id"));
    return c.json(await channel.history(conversation, parsed.data, before?.data));
  });
  api.post("/agents/:id/files", bodyLimit({ maxSize: ZAKURABOT_MAX_FILE_BYTES + 64 * 1024,
    onError: (c) => c.json({ error: "File upload is too large" }, 413) }), async (c) => {
    const { conversation } = await channel.resolveConversation(identity(c), c.req.param("id"));
    if (!channel.deps.files) return c.json({ error: "File uploads are unavailable" }, 503);
    const form = await c.req.parseBody({ all: true }).catch(() => null);
    const file = form?.file;
    if (!file || typeof file === "string" || Array.isArray(file)) return c.json({ error: "multipart file is required" }, 400);
    if (!file.size || file.size > ZAKURABOT_MAX_FILE_BYTES) return c.json({ error: "Files must be nonempty and at most 16 MiB" }, 413);
    const data = Buffer.from(await file.arrayBuffer());
    // Recheck after receiving a potentially slow upload.
    await channel.resolveConversation(identity(c), c.req.param("id"));
    const uploaded = await channel.deps.files.upload(conversation, { name: file.name, type: file.type, data });
    await channel.resolveConversation(identity(c), c.req.param("id"));
    return c.json({ file: uploaded }, 201);
  });
  api.get("/agents/:id/files/:fileId", async (c) => {
    const { conversation } = await channel.resolveConversation(identity(c), c.req.param("id"));
    if (!channel.deps.files) return c.json({ error: "File downloads are unavailable" }, 503);
    const { file, data } = await channel.deps.files.download(conversation, c.req.param("fileId"));
    await channel.resolveConversation(identity(c), c.req.param("id"));
    return new Response(data, { headers: {
      "Content-Type": file.mime, "Content-Length": String(data.length), "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
    } });
  });
  api.get("/agents/:id/desktop", async (c) => {
    const actor = identity(c);
    const { conversation } = await channel.resolveConversation(actor, c.req.param("id"));
    const agent = await channel.deps.agents.get(conversation.tenantId, conversation.agentId);
    if (!agent?.enableComputer) return c.json({ error: "Desktop is disabled" }, 409);
    if (!workspace) return c.json({ error: "Desktop is unavailable" }, 503);
    const info = await workspace.getDesktopInfo(agent);
    await channel.resolveConversation(actor, agent.id);
    return c.json({ enabled: info.enabled, supported: info.supported, status: info.containerStatus,
      width: info.width, height: info.height, coordinateSpace: info.coordinateSpace,
      frameUrl: info.enabled && info.supported
        ? `${baseUrl.replace(/\/+$/, "")}/api/zakurabot/agents/${encodeURIComponent(agent.id)}/desktop/frame` : null,
      frameAuthorization: "Bearer", maxFrameBytes: MAX_SCREENSHOT_BYTES, suggestedIntervalMs: 2000 });
  });
  api.get("/agents/:id/desktop/frame", async (c) => {
    const actor = identity(c);
    const { conversation } = await channel.resolveConversation(actor, c.req.param("id"));
    const agent = await channel.deps.agents.get(conversation.tenantId, conversation.agentId);
    if (!agent?.enableComputer) return c.json({ error: "Desktop is disabled" }, 409);
    if (!workspace) return c.json({ error: "Desktop is unavailable" }, 503);
    const info = await workspace.getDesktopInfo(agent);
    if (!info.enabled || !info.supported) return c.json({ error: "This workspace does not support a desktop" }, 409);
    const frame = await captureDesktop(workspace, agent);
    const bytes = Buffer.from(frame.base64Full, "base64");
    await channel.resolveConversation(actor, agent.id);
    if (!(await channel.deps.agents.get(conversation.tenantId, agent.id))?.enableComputer) {
      return c.json({ error: "Desktop is disabled" }, 409);
    }
    return new Response(bytes, { headers: {
      "Content-Type": "image/png", "Content-Length": String(bytes.length), "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff", "X-Frame-Width": String(frame.width), "X-Frame-Height": String(frame.height),
      "X-Frame-Captured-At": new Date().toISOString(),
    } });
  });
  api.post("/agents/:id/exec", bodyLimit({ maxSize: 64 * 1024,
    onError: (c) => c.json({ error: "Command is too large" }, 413) }), async (c) => {
    const input = zakurabotExecBody.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "command must be 1-2000 characters" }, 400);
    const actor = identity(c);
    const { conversation } = await channel.resolveConversation(actor, c.req.param("id"));
    const agent = await channel.deps.agents.get(conversation.tenantId, conversation.agentId);
    if (!agent) return c.json({ error: "Agent not available" }, 404);
    if (!workspace) return c.json({ error: "Terminal is unavailable" }, 503);
    const info = await workspace.getDesktopInfo(agent);
    if (info.containerStatus !== "running") {
      return c.json({ error: "Workspace is not running. Start the agent first." }, 409);
    }
    const result = await workspace.execInWorkspace(agent, ["bash", "-lc", input.data.command], {
      timeoutMs: ZAKURABOT_EXEC_TIMEOUT_MS,
    });
    const { output, truncated } = clipExecOutput(result.stdout, result.stderr);
    await channel.resolveConversation(actor, agent.id);
    return c.json({ output, exitCode: result.exitCode, finishedAt: new Date().toISOString(), truncated });
  });
  api.get("/agents/:id/interactions", async (c) => {
    if (!channel.deps.interactions) return c.json({ error: "Interactions are unavailable" }, 503);
    const { conversation, sessionId } = await channel.interactionSession(identity(c), c.req.param("id"));
    if (!sessionId) return c.json({ interactions: [] });
    await channel.deps.interactions.sync(sessionId);
    const pending = await channel.deps.interactions.pending(conversation, sessionId);
    await channel.resolveConversation(identity(c), c.req.param("id"));
    return c.json({ interactions: pending.map((row) => ({ messageId: row.id, createdAt: row.createdAt.getTime(),
      interaction: channel.deps.interactions!.payload(row) })) });
  });
  api.get("/agents/:id/interactions/:messageId", async (c) => {
    if (!channel.deps.interactions) return c.json({ error: "Interactions are unavailable" }, 503);
    const { conversation } = await channel.interactionSession(identity(c), c.req.param("id"));
    const snapshot = await channel.deps.interactions.snapshot(conversation, c.req.param("messageId"));
    await channel.resolveConversation(identity(c), c.req.param("id"));
    return c.json(snapshot);
  });
  api.post("/agents/:id/interactions/:messageId", bodyLimit({ maxSize: 64 * 1024,
    onError: (c) => c.json({ error: "Interaction response is too large" }, 413) }), async (c) => {
    if (!channel.deps.interactions) return c.json({ error: "Interactions are unavailable" }, 503);
    const input = zakurabotAnswerSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "Invalid interaction response" }, 400);
    const snapshot = await channel.respondInteraction(identity(c), c.req.param("id"), c.req.param("messageId"), input.data);
    await channel.resolveConversation(identity(c), c.req.param("id"));
    return c.json({ ok: true, ...snapshot });
  });
  api.get("/agents/:id/messages/:messageId/reactions", async (c) => {
    const reactions = await channel.reactions(identity(c), c.req.param("id"), c.req.param("messageId"));
    return c.json({ reactions: reactions.map((row) => ({ messageId: row.messageId, emoji: row.emoji,
      userId: row.userId, createdAt: row.createdAt.getTime() })) });
  });
  api.post("/agents/:id/messages/:messageId/reactions", bodyLimit({ maxSize: 8 * 1024,
    onError: (c) => c.json({ error: "Reaction is too large" }, 413) }), async (c) => {
    const input = zakurabotReactionBody.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "emoji must be 1-16 characters" }, 400);
    const reaction = await channel.addReaction(identity(c), c.req.param("id"), c.req.param("messageId"), input.data.emoji);
    return c.json({ reaction }, 201);
  });
  api.delete("/agents/:id/messages/:messageId/reactions", async (c) => {
    const body = await c.req.json().catch(() => null) as { emoji?: unknown } | null;
    const raw = body && typeof body === "object" ? body.emoji : c.req.query("emoji");
    const input = zakurabotReactionBody.safeParse({ emoji: raw });
    if (!input.success) return c.json({ error: "emoji must be 1-16 characters" }, 400);
    const removed = await channel.removeReaction(identity(c), c.req.param("id"), c.req.param("messageId"), input.data.emoji);
    return c.json({ removed });
  });
  app.route("/api/zakurabot", api);
}
