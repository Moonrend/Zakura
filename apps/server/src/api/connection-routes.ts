import { Hono } from "hono";
import type { AppConfig } from "../config.js";
import type { ConnectionCatalogService } from "../services/connection-catalog.js";
import type { InstanceMigrationService } from "../services/instance-migration.js";
import type { McpStoreService } from "../services/mcp-store.js";
import type { Orchestrator } from "../services/orchestrator.js";
import type { AppVariables } from "./routes.js";

export function registerConnectionRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: {
    config: AppConfig;
    connections: ConnectionCatalogService;
    mcpStore: McpStoreService;
    orchestrator: Orchestrator;
    instanceMigrations?: InstanceMigrationService | null;
  },
): void {
  const { connections, mcpStore, orchestrator, instanceMigrations } = deps;

  app.get("/api/connections", async (c) => {
    const session = c.get("session")!;
    const items = await connections.listInstalled(session.tenantId);
    return c.json({ items });
  });

  app.get("/api/connections/search", async (c) => {
    const session = c.get("session")!;
    const q = c.req.query("q") ?? "";
    const source = c.req.query("source") ?? "all";
    const limit = Number(c.req.query("limit") ?? 40);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await connections.search({
      tenantId: session.tenantId,
      q,
      source,
      limit,
      offset,
    });
    return c.json(result);
  });

  app.get("/api/connections/sources", async (c) => {
    const session = c.get("session")!;
    return c.json({ sources: await connections.listSources(session.tenantId) });
  });

  app.get("/api/connections/packages", async (c) => {
    const session = c.get("session")!;
    const source = c.req.query("source") ?? "platform";
    const q = c.req.query("q") ?? "";
    const repo = c.req.query("repo") ?? undefined;
    const limit = Number(c.req.query("limit") ?? 40);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await connections.listPackages({
      tenantId: session.tenantId,
      source,
      q,
      repo,
      limit,
      offset,
    });
    return c.json(result);
  });

  app.get("/api/connections/packages/:id", async (c) => {
    const session = c.get("session")!;
    const id = decodeURIComponent(c.req.param("id"));
    const detail = await connections.getPackage(session.tenantId, id);
    if (!detail) return c.json({ error: "Not found" }, 404);
    return c.json({ package: detail });
  });

  app.post("/api/connections/packages/:id/install", async (c) => {
    const session = c.get("session")!;
    const id = decodeURIComponent(c.req.param("id"));
    const body = await c.req.json<{
      componentIds?: string[];
      runtimeNodeId?: string | null;
      agentIds?: string[];
      config?: Record<string, unknown>;
      name?: string;
    }>();
    try {
      const result = await connections.installPackage(session.tenantId, id, {
        componentIds: body.componentIds,
        runtimeNodeId: body.runtimeNodeId,
        agentIds: body.agentIds,
        config: body.config,
        name: body.name,
      });
      return c.json({ result }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/connections/sources", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{ repository?: string }>();
    if (!body.repository?.trim()) return c.json({ error: "repository required" }, 400);
    try {
      const input = body.repository.trim();
      const source =
        /\.json(\?|#|$)/i.test(input) || /^https?:\/\//i.test(input) && input.includes("marketplace")
          ? await mcpStore.importSource(session.tenantId, { sourceUrl: input })
          : await mcpStore.importRepository(session.tenantId, input);
      return c.json({ source }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/connections/sources/:id", async (c) => {
    const session = c.get("session")!;
    const deleted = await mcpStore.deleteSource(
      session.tenantId,
      decodeURIComponent(c.req.param("id")),
    );
    return deleted ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
  });

  app.post("/api/connections/install", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      source?: string;
      ref?: string;
      kind?: string;
      runtimeNodeId?: string | null;
      agentIds?: string[];
      config?: Record<string, unknown>;
      name?: string;
      componentIds?: string[];
      packageId?: string;
    }>();
    if (!body.source?.trim() && !body.packageId?.trim()) {
      return c.json({ error: "source or packageId required" }, 400);
    }
    try {
      const result = await connections.install(session.tenantId, {
        source: body.source?.trim() || body.packageId!.trim(),
        ref: body.ref,
        kind: body.kind as never,
        runtimeNodeId: body.runtimeNodeId,
        agentIds: body.agentIds,
        config: body.config,
        name: body.name,
        componentIds: body.componentIds,
        packageId: body.packageId,
      });
      return c.json({ result }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/connections/:id/bind", async (c) => {
    const session = c.get("session")!;
    const connectionId = decodeURIComponent(c.req.param("id"));
    const body = await c.req.json<{ agentId?: string }>();
    if (!body.agentId) return c.json({ error: "agentId required" }, 400);
    try {
      await connections.bind(session.tenantId, connectionId, body.agentId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/connections/:id", async (c) => {
    const session = c.get("session")!;
    const connectionId = decodeURIComponent(c.req.param("id"));
    try {
      await connections.remove(session.tenantId, connectionId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/instances/:id/migrations", async (c) => {
    const session = c.get("session")!;
    const instanceId = c.req.param("id");
    const body = await c.req.json<{ targetRuntimeNodeId?: string }>();
    if (!body.targetRuntimeNodeId) {
      return c.json({ error: "targetRuntimeNodeId required" }, 400);
    }
    if (!instanceMigrations) {
      return c.json({ error: "实例迁移服务未启用" }, 501);
    }
    try {
      const result = await instanceMigrations.migrate(
        session.tenantId,
        instanceId,
        body.targetRuntimeNodeId,
      );
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // 启停快捷入口（连接中心用）
  app.post("/api/connections/:id/start", async (c) => {
    const session = c.get("session")!;
    const id = decodeURIComponent(c.req.param("id"));
    if (!id.startsWith("instance:")) return c.json({ error: "仅实例可启动" }, 400);
    try {
      await orchestrator.startInstance(session.tenantId, id.slice("instance:".length));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/connections/:id/stop", async (c) => {
    const session = c.get("session")!;
    const id = decodeURIComponent(c.req.param("id"));
    if (!id.startsWith("instance:")) return c.json({ error: "仅实例可停止" }, 400);
    try {
      await orchestrator.stopInstance(session.tenantId, id.slice("instance:".length));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });
}
