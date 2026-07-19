import type { Hono } from "hono";
import type { MigrationService } from "../services/migration-service.js";
import { mapMigration } from "../services/migration-service.js";
import type { AgentService } from "../services/agents.js";

type SessionVars = {
  session?: { userId: string; tenantId: string; email: string; role: string };
};

export function registerMigrationRoutes(
  app: Hono<{ Variables: SessionVars }>,
  deps: {
    migrations: MigrationService;
    agentService: AgentService;
  },
) {
  const { migrations, agentService } = deps;

  app.post("/api/agents/:id/migrations", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      targetNodeId?: string;
      excludePatterns?: string[];
    };
    if (!body.targetNodeId) return c.json({ error: "targetNodeId is required" }, 400);
    try {
      const job = await migrations.start(session.tenantId, agent.id, {
        targetNodeId: body.targetNodeId,
        excludePatterns: body.excludePatterns,
      });
      return c.json({ migration: mapMigration(job) }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/agents/:id/migrations", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const list = await migrations.listForAgent(session.tenantId, agent.id);
    return c.json({ migrations: list.map(mapMigration) });
  });

  app.get("/api/migrations/:jobId", async (c) => {
    const session = c.get("session")!;
    const job = await migrations.get(session.tenantId, c.req.param("jobId"));
    if (!job) return c.json({ error: "Not found" }, 404);
    return c.json({ migration: mapMigration(job) });
  });

  app.get("/api/migrations/:jobId/events", async (c) => {
    const session = c.get("session")!;
    const jobId = c.req.param("jobId");
    const job = await migrations.get(session.tenantId, jobId);
    if (!job) return c.json({ error: "Not found" }, 404);

    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: unknown) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };
        send(mapMigration(job));
        // Poll until terminal
        for (let i = 0; i < 120 && !closed; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const cur = await migrations.get(session.tenantId, jobId);
          if (!cur) break;
          send(mapMigration(cur));
          if (["completed", "failed", "cancelled"].includes(cur.status)) break;
        }
        closed = true;
        controller.close();
      },
      cancel() {
        closed = true;
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });
}
