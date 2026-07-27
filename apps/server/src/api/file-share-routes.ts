import type { Hono } from "hono";
import { PathJailError } from "@zakura/core";
import type { AgentService } from "../services/agents.js";
import type { FileShareService } from "../services/file-shares.js";
import type { ServerWorkspaceFsProvider } from "../services/workspace-fs-provider.js";

type SessionVars = {
  session?: { userId: string; tenantId: string; email: string; role: string };
};

/**
 * Public (token-gated) file share download — no session required.
 * Registered under /api/files/shared/:token (auth middleware must allow this path).
 */
export function registerFileShareRoutes(
  app: Hono<{ Variables: SessionVars }>,
  fileShares: FileShareService,
  agentService: AgentService,
  fsProvider: ServerWorkspaceFsProvider,
) {
  app.get("/api/files/shared/:token", async (c) => {
    const token = c.req.param("token");
    const share = await fileShares.resolveByToken(token);
    if (!share) {
      return c.json({ error: "Share not found or expired" }, 404);
    }

    const agent = await agentService.get(share.tenantId, share.agentId);
    if (!agent || !agent.enableFs) {
      return c.json({ error: "Share unavailable" }, 404);
    }

    try {
      const fs = await fsProvider.forAgentBinding({
        id: agent.id,
        tenantId: agent.tenantId,
        runtimeNodeId: agent.runtimeNodeId,
      });
      const file = await fs.readBytes(share.path);
      await fileShares.recordDownload(share.id).catch(() => undefined);

      const mime = share.mimeType || "application/octet-stream";
      const disposition = share.disposition === "inline" ? "inline" : "attachment";
      const safeName = share.fileName.replace(/["\r\n]/g, "_");

      return new Response(file.data, {
        headers: {
          "Content-Type": mime,
          "Content-Length": String(file.size),
          "Content-Disposition": `${disposition}; filename="${encodeURIComponent(safeName)}"`,
          "Cache-Control": "private, max-age=60",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (err) {
      if (err instanceof PathJailError) {
        return c.json({ error: "Forbidden" }, 403);
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ENOENT") || message.includes("no such file")) {
        return c.json({ error: "File no longer exists in workspace" }, 404);
      }
      return c.json({ error: message }, 400);
    }
  });
}
