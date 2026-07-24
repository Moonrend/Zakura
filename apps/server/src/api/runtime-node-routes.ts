import type { Hono } from "hono";
import type { RuntimeNodeService } from "../services/runtime-nodes.js";
import {
  cacheRunnerToken,
  mapRuntimeNode,
} from "../services/runtime-nodes.js";
import type { NetworkSettingsService } from "../services/network-settings.js";
import type { Orchestrator } from "../services/orchestrator.js";
import type { DockerRuntime } from "../runtime/docker.js";
import { hashRunnerToken } from "@zakura/core";
import type { RunnerHostInfo, RunnerInstallPackage } from "@zakura/shared";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { agents, managedContainers, runtimeNodes } from "../db/schema.js";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { agentWorkspaceHostPath } from "../services/agent-workspace.js";
import {
  assertSharedRunnerOperationAllowed,
  isForeignSharedAccess,
  userCanUseLocalRunner,
  RunnerAccessError,
} from "../services/runner-access.js";

type SessionVars = {
  session?: {
    userId: string;
    tenantId: string;
    email: string;
    role: string;
    isPlatformAdmin?: boolean;
  };
};

function attachRunnerInstallCommands(
  install: RunnerInstallPackage & {
    hasAuthKey?: boolean;
    meshConnected?: boolean;
    tags?: string[];
  },
  opts: { publicBaseUrl: string; nodeId: string; token: string },
) {
  const base = opts.publicBaseUrl.replace(/\/$/, "");
  const tsFlag = install.enableTailscale ? "1" : "0";
  const bootstrapUrl = `${base}/api/runtime-nodes/${opts.nodeId}/bootstrap.sh?token=${encodeURIComponent(opts.token)}&tailscale=${tsFlag}`;
  return {
    ...install,
    /** curl | sudo bash — pulls the install script from this server */
    installCurl: `curl -fsSL ${JSON.stringify(bootstrapUrl)} | sudo bash`,
    bootstrapUrl,
  };
}

async function listContainersForNode(
  db: Db,
  runtime: DockerRuntime | undefined,
  tenantId: string,
  node: { id: string; kind: string },
  opts?: { syncLive?: boolean },
) {
  const where =
    node.kind === "local"
      ? and(
          eq(managedContainers.tenantId, tenantId),
          or(
            eq(managedContainers.runtimeNodeId, node.id),
            isNull(managedContainers.runtimeNodeId),
          ),
        )
      : and(
          eq(managedContainers.tenantId, tenantId),
          eq(managedContainers.runtimeNodeId, node.id),
        );

  const rows = await db
    .select()
    .from(managedContainers)
    .where(where)
    .orderBy(desc(managedContainers.createdAt));

  // Default: serve DB state. Live Docker inspect only when explicitly requested
  // and not recently synced for this node.
  if (!runtime || node.kind !== "local" || !opts?.syncLive) {
    return rows;
  }

  const syncKey = `${tenantId}:${node.id}`;
  const last = containerSyncAt.get(syncKey) ?? 0;
  if (Date.now() - last < CONTAINER_SYNC_TTL_MS) {
    return rows;
  }
  containerSyncAt.set(syncKey, Date.now());

  const synced = [];
  for (const row of rows) {
    if (!row.dockerId || row.status === "removed") {
      synced.push(row);
      continue;
    }
    try {
      const live = await runtime.inspect(row.dockerId);
      if (!live) {
        const [updated] = await db
          .update(managedContainers)
          .set({ status: "exited", dockerId: null, updatedAt: new Date() })
          .where(eq(managedContainers.id, row.id))
          .returning();
        synced.push(updated ?? { ...row, status: "exited", dockerId: null });
      } else if (live.status !== row.status) {
        const [updated] = await db
          .update(managedContainers)
          .set({
            status: live.status,
            portsJson: JSON.stringify(live.ports),
            updatedAt: new Date(),
          })
          .where(eq(managedContainers.id, row.id))
          .returning();
        synced.push(updated ?? { ...row, status: live.status });
      } else {
        synced.push(row);
      }
    } catch {
      synced.push(row);
    }
  }
  return synced;
}

const CONTAINER_SYNC_TTL_MS = 15_000;
const containerSyncAt = new Map<string, number>();

export function registerRuntimeNodeRoutes(
  app: Hono<{ Variables: SessionVars }>,
  deps: {
    nodes: RuntimeNodeService;
    db: Db;
    config: AppConfig;
    network?: NetworkSettingsService;
    orchestrator?: Orchestrator;
    runtime?: DockerRuntime;
  },
) {
  const { nodes, db, config, network, orchestrator, runtime } = deps;

  // Agent self-register — authenticated by rnr_ token, not session
  app.post("/api/runtime-nodes/register", async (c) => {
    type RegisterBody = {
      token?: string;
      endpoint?: string;
      hostInfo?: RunnerHostInfo;
      agentVersion?: string;
      storageRoot?: string;
      capabilities?: Record<string, unknown>;
    };
    const body = (await c.req.json().catch(() => ({}))) as RegisterBody;
    if (!body.token?.startsWith("rnr_")) {
      return c.json({ error: "token (rnr_*) is required" }, 400);
    }
    if (!body.endpoint?.trim()) {
      return c.json({ error: "endpoint is required" }, 400);
    }
    const node = await nodes.register({
      token: body.token,
      endpoint: body.endpoint,
      hostInfo: body.hostInfo,
      agentVersion: body.agentVersion,
      storageRoot: body.storageRoot,
      capabilities: body.capabilities,
    });
    if (!node) return c.json({ error: "Invalid token" }, 401);
    // register() already persists token; keep memory cache warm
    cacheRunnerToken(node.id, body.token);
    return c.json({ node: mapRuntimeNode(node) });
  });

  app.post("/api/runtime-nodes/:id/heartbeat", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const token = m?.[1]?.trim();
    if (!token?.startsWith("rnr_")) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const nodeId = c.req.param("id");
    const node = await db.query.runtimeNodes.findFirst({
      where: eq(runtimeNodes.id, nodeId),
    });
    if (!node || !node.tokenHash || node.tokenHash !== hashRunnerToken(token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    cacheRunnerToken(node.id, token);
    const body = await c.req
      .json<{ hostInfo?: RunnerHostInfo; agentVersion?: string }>()
      .catch(() => ({} as { hostInfo?: RunnerHostInfo }));
    const updated = await nodes.heartbeat(nodeId, { ...body, token });
    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json({ node: mapRuntimeNode(updated) });
  });

  app.get("/api/runtime-nodes", async (c) => {
    const session = c.get("session")!;
    await nodes.refreshOfflineStatuses(config.runnerHeartbeatTimeoutSec, session.tenantId);
    const canLocal = await userCanUseLocalRunner(db, config, session.userId);
    const list = await nodes.listAccessible(session.tenantId);
    const filtered = list.filter((n) => {
      if (n.kind === "local" || n.slug === "local") return canLocal;
      return true;
    });
    return c.json({
      nodes: filtered.map((n) => mapRuntimeNode(n, { access: n.access })),
      canUseLocalRunner: canLocal,
    });
  });

  app.get("/api/runtime-nodes/mesh-status", async (c) => {
    const session = c.get("session")!;
    if (!network) {
      return c.json({
        meshConnected: false,
        hasAuthKey: false,
        tags: [] as string[],
        hostJoinsTailscale: !config.multiTenant,
        meshProvider: null as string | null,
      });
    }
    try {
      // 仅读 mesh 摘要，不再调用 runnerJoinHint（会拼装安装包，极慢）
      const mesh = await network.getMesh(session.tenantId);
      const platformMode = mesh.meshProvider === "headscale-platform";
      return c.json({
        meshConnected: Boolean(mesh.connected) || platformMode,
        hasAuthKey: Boolean(mesh.hasAuthKey),
        tags: mesh.oauth?.tags ?? [],
        hostJoinsTailscale: mesh.hostJoinsTailscale ?? !config.multiTenant,
        meshProvider: mesh.meshProvider ?? null,
      });
    } catch {
      const platform = await network.isPlatformHeadscaleAvailable();
      return c.json({
        meshConnected: platform,
        hasAuthKey: false,
        tags: [] as string[],
        hostJoinsTailscale: platform || !config.multiTenant,
        meshProvider: platform ? "headscale-platform" : null,
      });
    }
  });

  app.post("/api/runtime-nodes", async (c) => {
    const session = c.get("session")!;
    type CreateBody = {
      name?: string;
      labels?: Record<string, unknown>;
      enableTailscale?: boolean;
    };
    const body = (await c.req.json().catch(() => ({}))) as CreateBody;
    if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);

    const enableTailscale = Boolean(body.enableTailscale);
    if (enableTailscale && network) {
      const mesh = await network.getMesh(session.tenantId);
      if (!mesh.connected && !(await network.isPlatformHeadscaleAvailable())) {
        return c.json({ error: "请先在网络设置中连接 Tailscale 组网" }, 400);
      }
    }

    const labels = { ...(body.labels ?? {}), enableTailscale };

    const { node, token } = await nodes.create(session.tenantId, {
      name: body.name,
      labels,
      createdByUserId: session.userId === "api-key" ? null : session.userId,
    });

    let install: ReturnType<typeof attachRunnerInstallCommands> | null = null;
    let installTailscale: ReturnType<typeof attachRunnerInstallCommands> | null = null;
    let hostJoinsTailscale = !config.multiTenant;
    if (network) {
      try {
        const variants = await network.buildRunnerInstallVariants(session.tenantId, {
          token,
          slug: node.slug,
          mintAuthKeyIfMissing: true,
          actorId: session.userId,
        });
        hostJoinsTailscale = variants.hostJoinsTailscale;
        const attach = (pack: NonNullable<typeof variants.plain>) =>
          attachRunnerInstallCommands(pack, {
            publicBaseUrl: config.publicBaseUrl,
            nodeId: node.id,
            token,
          });
        const plain = attach(variants.plain);
        installTailscale = variants.withTailscale ? attach(variants.withTailscale) : null;
        if (enableTailscale) {
          if (!installTailscale) {
            return c.json(
              {
                error: variants.tailscaleError ?? "无法生成 Tailscale 安装包",
                node: mapRuntimeNode(node),
                token,
                install: plain,
                installTailscale: null,
                hostJoinsTailscale,
              },
              400,
            );
          }
          install = installTailscale;
        } else {
          install = plain;
        }
      } catch (err) {
        return c.json(
          {
            error: err instanceof Error ? err.message : String(err),
            node: mapRuntimeNode(node),
            token,
          },
          400,
        );
      }
    }

    return c.json(
      {
        node: mapRuntimeNode(node),
        token,
        install,
        installTailscale,
        hostJoinsTailscale,
      },
      201,
    );
  });

  /**
   * Host-served bootstrap script for remote runners:
   * curl -fsSL '{public}/api/runtime-nodes/:id/bootstrap.sh?token=rnr_…' | sudo bash
   */
  app.get("/api/runtime-nodes/:id/bootstrap.sh", async (c) => {
    const token = (c.req.query("token") ?? "").trim();
    if (!token.startsWith("rnr_")) {
      return c.text("token query required (rnr_*)", 401);
    }
    if (!network) return c.text("Network service unavailable", 503);

    const nodeId = c.req.param("id");
    const node = await db.query.runtimeNodes.findFirst({
      where: eq(runtimeNodes.id, nodeId),
    });
    if (!node || node.kind === "local") return c.text("Not found", 404);
    if (!node.tokenHash || node.tokenHash !== hashRunnerToken(token)) {
      return c.text("Unauthorized", 401);
    }

    let labels: Record<string, unknown> = {};
    try {
      labels = JSON.parse(node.labelsJson || "{}") as Record<string, unknown>;
    } catch {
      labels = {};
    }
    const q = (c.req.query("tailscale") ?? "").trim().toLowerCase();
    const enableTailscale =
      q === "1" || q === "true"
        ? true
        : q === "0" || q === "false"
          ? false
          : Boolean(labels.enableTailscale);

    try {
      const install = await network.buildRunnerInstallPackage(node.tenantId, {
        token,
        slug: node.slug,
        enableTailscale,
        mintAuthKeyIfMissing: enableTailscale,
      });
      const res = c.text(install.script, 200);
      res.headers.set("Content-Type", "text/x-shellscript; charset=utf-8");
      res.headers.set(
        "Content-Disposition",
        `inline; filename="zakura-runner-${node.slug}.sh"`,
      );
      res.headers.set("Cache-Control", "no-store");
      return res;
    } catch (err) {
      return c.text(err instanceof Error ? err.message : String(err), 400);
    }
  });

  /**
   * Install materials for a node. Returns both plain and Tailscale packages when
   * mesh is ready — UI toggles between them locally (no re-fetch on switch).
   */
  app.get("/api/runtime-nodes/:id/install", async (c) => {
    const session = c.get("session")!;
    if (!network) return c.json({ error: "Network service unavailable" }, 503);
    const node = await nodes.getAccessible(session.tenantId, c.req.param("id"));
    if (!node) return c.json({ error: "Not found" }, 404);
    try {
      assertSharedRunnerOperationAllowed(node, session.tenantId, "manage");
    } catch (err) {
      if (err instanceof RunnerAccessError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }
    if (node.kind === "local") return c.json({ error: "Local node has no install package" }, 400);

    const token = nodes.resolveToken(node);
    if (!token) {
      return c.json({ error: "注册密钥已丢失，请重新注册节点" }, 400);
    }

    try {
      const variants = await network.buildRunnerInstallVariants(session.tenantId, {
        token,
        slug: node.slug,
        mintAuthKeyIfMissing: true,
        actorId: session.userId,
      });
      const attach = (pack: typeof variants.plain) =>
        attachRunnerInstallCommands(pack, {
          publicBaseUrl: config.publicBaseUrl,
          nodeId: node.id,
          token,
        });
      return c.json({
        node: mapRuntimeNode(node),
        install: attach(variants.plain),
        installTailscale: variants.withTailscale ? attach(variants.withTailscale) : null,
        meshConnected: variants.meshConnected,
        hostJoinsTailscale: variants.hostJoinsTailscale,
        meshProvider: variants.meshProvider,
        tailscaleError: variants.tailscaleError,
        tokenHint: `${token.slice(0, 8)}…`,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** Runner 详情页首屏：node + containers + mesh 摘要（不含安装包拼装） */
  app.get("/api/runtime-nodes/:id/detail", async (c) => {
    const session = c.get("session")!;
    const t0 = performance.now();
    const node = await nodes.getAccessible(session.tenantId, c.req.param("id"));
    if (!node) return c.json({ error: "Not found" }, 404);
    if (node.kind === "local" || node.slug === "local") {
      const canLocal = await userCanUseLocalRunner(db, config, session.userId);
      if (!canLocal) return c.json({ error: "未授权使用本机 Local Runner" }, 403);
    }
    const access = isForeignSharedAccess(node, session.tenantId) ? "shared" : "owned";

    const syncLive = c.req.query("sync") === "1";
    const containers = await listContainersForNode(
      db,
      runtime,
      session.tenantId,
      node,
      { syncLive },
    );
    const mapped = mapRuntimeNode(node, { access });

    if (node.kind === "local" || !network) {
      return c.json({
        node: mapped,
        containers,
        install: null,
        installTailscale: null,
        meshConnected: false,
        hostJoinsTailscale: true,
        meshProvider: null,
        tailscaleError: null,
        tokenHint: null,
      });
    }

    const token = nodes.resolveToken(node);
    let meshConnected = false;
    let hostJoinsTailscale = !config.multiTenant;
    let meshProvider: string | null = null;
    let tailscaleError: string | null = null;

    try {
      const mesh = await network.getMesh(session.tenantId);
      const platformMode = mesh.meshProvider === "headscale-platform";
      meshConnected = Boolean(mesh.connected) || platformMode;
      hostJoinsTailscale =
        mesh.hostJoinsTailscale ??
        (await network.hostJoinsTailscaleForTenant(mesh.meshProvider));
      meshProvider = mesh.meshProvider ?? null;
    } catch (err) {
      tailscaleError = err instanceof Error ? err.message : String(err);
    }

    if (!token) {
      tailscaleError = tailscaleError ?? "注册密钥已丢失，请重新注册节点";
    }

    const total = performance.now() - t0;
    if (total >= 200) {
      console.warn(
        `[http] runtime-nodes/detail ${total.toFixed(0)}ms node=${node.slug}`,
      );
    }

    return c.json({
      node: mapped,
      containers,
      // Install packages are built on GET .../install — not on every detail load
      install: null,
      installTailscale: null,
      meshConnected,
      hostJoinsTailscale,
      meshProvider,
      tailscaleError,
      tokenHint: token ? `${token.slice(0, 8)}…` : null,
    });
  });

  app.get("/api/runtime-nodes/:id", async (c) => {
    const session = c.get("session")!;
    const node = await nodes.getAccessible(session.tenantId, c.req.param("id"));
    if (!node) return c.json({ error: "Not found" }, 404);
    if (node.kind === "local" || node.slug === "local") {
      const canLocal = await userCanUseLocalRunner(db, config, session.userId);
      if (!canLocal) return c.json({ error: "未授权使用本机 Local Runner" }, 403);
    }
    const access = isForeignSharedAccess(node, session.tenantId) ? "shared" : "owned";
    return c.json({ node: mapRuntimeNode(node, { access }) });
  });

  app.get("/api/runtime-nodes/:id/containers", async (c) => {
    const session = c.get("session")!;
    const node = await nodes.getAccessible(session.tenantId, c.req.param("id"));
    if (!node) return c.json({ error: "Not found" }, 404);
    const syncLive = c.req.query("sync") === "1";
    const containers = await listContainersForNode(
      db,
      runtime,
      session.tenantId,
      node,
      { syncLive },
    );
    return c.json({ containers });
  });

  app.post("/api/runtime-nodes/:id/containers/allocate", async (c) => {
    const session = c.get("session")!;
    if (!orchestrator) return c.json({ error: "Orchestrator unavailable" }, 503);
    const node = await nodes.getAccessible(session.tenantId, c.req.param("id"));
    if (!node) return c.json({ error: "Not found" }, 404);
    try {
      assertSharedRunnerOperationAllowed(node, session.tenantId, "containerAllocate");
    } catch (err) {
      if (err instanceof RunnerAccessError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }
    if (node.kind !== "local") {
      return c.json(
        { error: "仅本机节点可分配容器；远程请通过 Agent 工作区启动" },
        400,
      );
    }
    const canLocal = await userCanUseLocalRunner(db, config, session.userId);
    if (!canLocal) return c.json({ error: "未授权使用本机 Local Runner" }, 403);
    const body = await c.req.json<{
      image: string;
      name?: string;
      purpose?: "workspace" | "ephemeral";
      allocatedTo?: string;
      env?: Record<string, string>;
      command?: string[];
    }>();
    if (!body.image?.trim()) return c.json({ error: "image is required" }, 400);
    try {
      const row = await orchestrator.allocateContainer({
        tenantId: session.tenantId,
        image: body.image,
        name: body.name,
        purpose: body.purpose,
        allocatedTo: body.allocatedTo,
        env: body.env,
        command: body.command,
        runtimeNodeId: node.id,
      });
      return c.json({ container: row }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.patch("/api/runtime-nodes/:id", async (c) => {
    const session = c.get("session")!;
    const node = await nodes.getAccessible(session.tenantId, c.req.param("id"));
    if (!node) return c.json({ error: "Not found" }, 404);
    try {
      assertSharedRunnerOperationAllowed(node, session.tenantId, "manage");
    } catch (err) {
      if (err instanceof RunnerAccessError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }
    const body = await c.req
      .json<{ name?: string; labels?: Record<string, unknown> }>()
      .catch(() => ({}));
    const updated = await nodes.patch(session.tenantId, c.req.param("id"), body);
    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json({ node: mapRuntimeNode(updated) });
  });

  app.delete("/api/runtime-nodes/:id", async (c) => {
    const session = c.get("session")!;
    const node = await nodes.getAccessible(session.tenantId, c.req.param("id"));
    if (!node) return c.json({ error: "Not found" }, 404);
    try {
      assertSharedRunnerOperationAllowed(node, session.tenantId, "manage");
    } catch (err) {
      if (err instanceof RunnerAccessError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }
    const result = await nodes.delete(session.tenantId, c.req.param("id"));
    if ("error" in result) {
      const status = result.error === "Not found" ? 404 : 400;
      return c.json({ error: result.error }, status);
    }
    return c.json({ ok: true });
  });

  /** Manual cleanup of residual workspace on a node (source retained after migration). */
  app.delete("/api/runtime-nodes/:nodeId/agents/:agentId/workspace-residual", async (c) => {
    const session = c.get("session")!;
    const nodeId = c.req.param("nodeId");
    const agentId = c.req.param("agentId");
    const node = await nodes.get(session.tenantId, nodeId);
    if (!node) return c.json({ error: "Node not found" }, 404);
    const agent = await db.query.agents.findFirst({
      where: and(eq(agents.tenantId, session.tenantId), eq(agents.id, agentId)),
    });
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    // Only allow deleting residual when agent is no longer bound to this node
    if (agent.runtimeNodeId === nodeId) {
      return c.json({ error: "Agent still bound to this node; unbind or migrate first" }, 400);
    }
    if (node.kind === "local") {
      const root = agentWorkspaceHostPath(config, agentId);
      if (existsSync(root)) {
        rmSync(root, { recursive: true, force: true });
      }
      return c.json({ ok: true, deleted: root });
    }
    return c.json(
      {
        error:
          "Remote residual cleanup requires runner API",
        hint: join(node.storageRoot, "agents", agentId, "workspace"),
      },
      501,
    );
  });
}
