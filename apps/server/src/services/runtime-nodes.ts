import { and, eq, isNull, lt, or } from "drizzle-orm";
import {
  decryptJson,
  encryptJson,
  generateRunnerToken,
  hashRunnerToken,
  RunnerClient,
} from "@zakura/core";
import { LOCAL_RUNTIME_NODE_ID, type RunnerHostInfo } from "@zakura/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  agents,
  newId,
  runtimeNodes,
  type RuntimeNode,
} from "../db/schema.js";
import { getDefaultTenant } from "./bootstrap.js";

const TOKEN_ENC_LABEL = "_tokenEnc";

export function mapRuntimeNode(row: RuntimeNode) {
  const labels = JSON.parse(row.labelsJson || "{}") as Record<string, unknown>;
  // Never expose encrypted token material to API clients
  const { [TOKEN_ENC_LABEL]: _hidden, ...publicLabels } = labels;
  void _hidden;
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    status: row.status,
    endpoint: row.endpoint,
    capabilities: JSON.parse(row.capabilitiesJson || "{}") as Record<string, unknown>,
    hostInfo: JSON.parse(row.hostInfoJson || "{}") as RunnerHostInfo | Record<string, unknown>,
    storageRoot: row.storageRoot,
    agentVersion: row.agentVersion,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    labels: publicLabels,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class RuntimeNodeService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {}

  /** Ensure implicit local node exists for the default tenant (and requested tenant). */
  async ensureLocalNode(tenantId?: string): Promise<RuntimeNode> {
    const tid =
      tenantId ??
      (await getDefaultTenant(this.db).then((t) => t?.id)) ??
      null;
    if (!tid) {
      throw new Error("No tenant available to seed local runtime node");
    }

    const existing = await this.db.query.runtimeNodes.findFirst({
      where: and(eq(runtimeNodes.tenantId, tid), eq(runtimeNodes.slug, "local")),
    });
    if (existing) {
      if (existing.status !== "online") {
        const now = new Date();
        await this.db
          .update(runtimeNodes)
          .set({ status: "online", lastSeenAt: now, updatedAt: now })
          .where(eq(runtimeNodes.id, existing.id));
        return { ...existing, status: "online", lastSeenAt: now, updatedAt: now };
      }
      return existing;
    }

    const now = new Date();
    // Prefer stable id "local" when free
    const idTaken = await this.db.query.runtimeNodes.findFirst({
      where: eq(runtimeNodes.id, LOCAL_RUNTIME_NODE_ID),
    });
    const id = idTaken ? newId() : LOCAL_RUNTIME_NODE_ID;

    const [row] = await this.db
      .insert(runtimeNodes)
      .values({
        id,
        tenantId: tid,
        name: "Local",
        slug: "local",
        kind: "local",
        status: "online",
        endpoint: null,
        capabilitiesJson: JSON.stringify({ docker: true, local: true }),
        hostInfoJson: "{}",
        storageRoot: this.config.dataDir,
        agentVersion: "embedded",
        lastSeenAt: now,
        tokenHash: null,
        labelsJson: "{}",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row!;
  }

  async list(tenantId: string): Promise<RuntimeNode[]> {
    await this.ensureLocalNode(tenantId);
    return this.db.query.runtimeNodes.findMany({
      where: eq(runtimeNodes.tenantId, tenantId),
    });
  }

  async get(tenantId: string, id: string): Promise<RuntimeNode | null> {
    return (
      (await this.db.query.runtimeNodes.findFirst({
        where: and(eq(runtimeNodes.tenantId, tenantId), eq(runtimeNodes.id, id)),
      })) ?? null
    );
  }

  /** Create a remote runner node; returns one-time token. */
  async create(
    tenantId: string,
    input: { name: string; labels?: Record<string, unknown> },
  ): Promise<{ node: RuntimeNode; token: string }> {
    // Internal unique handle (not shown as "slug" in UI) — also used for Tailscale hostname
    let slug = "";
    for (let i = 0; i < 12; i++) {
      const candidate = `rn${newId().replace(/[^a-z0-9]/gi, "").slice(0, 14).toLowerCase()}`;
      const existing = await this.db.query.runtimeNodes.findFirst({
        where: and(eq(runtimeNodes.tenantId, tenantId), eq(runtimeNodes.slug, candidate)),
      });
      if (!existing) {
        slug = candidate;
        break;
      }
    }
    if (!slug) {
      slug = `rn${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }

    const { raw, hash } = generateRunnerToken();
    const now = new Date();
    const labels: Record<string, unknown> = { ...(input.labels ?? {}) };
    labels[TOKEN_ENC_LABEL] = encryptJson(this.config.secret, raw);
    const [row] = await this.db
      .insert(runtimeNodes)
      .values({
        tenantId,
        name: input.name.trim(),
        slug,
        kind: "runner",
        status: "offline",
        endpoint: null,
        capabilitiesJson: "{}",
        hostInfoJson: "{}",
        storageRoot: "/var/lib/zakura",
        tokenHash: hash,
        labelsJson: JSON.stringify(labels),
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    cacheRunnerToken(row!.id, raw);
    return { node: row!, token: raw };
  }

  async register(input: {
    token: string;
    endpoint: string;
    hostInfo?: RunnerHostInfo;
    agentVersion?: string;
    storageRoot?: string;
    capabilities?: Record<string, unknown>;
  }): Promise<RuntimeNode | null> {
    const hash = hashRunnerToken(input.token);
    const node = await this.db.query.runtimeNodes.findFirst({
      where: eq(runtimeNodes.tokenHash, hash),
    });
    if (!node) return null;

    const now = new Date();
    // Keep token available across restarts
    await this.persistToken(node.id, input.token);

    const [updated] = await this.db
      .update(runtimeNodes)
      .set({
        status: "online",
        endpoint: input.endpoint.replace(/\/$/, ""),
        hostInfoJson: JSON.stringify(input.hostInfo ?? {}),
        agentVersion: input.agentVersion ?? node.agentVersion,
        storageRoot: input.storageRoot ?? node.storageRoot,
        capabilitiesJson: JSON.stringify(input.capabilities ?? JSON.parse(node.capabilitiesJson)),
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(runtimeNodes.id, node.id))
      .returning();
    return updated ?? null;
  }

  async heartbeat(
    nodeId: string,
    input: { hostInfo?: RunnerHostInfo; agentVersion?: string; token?: string },
  ): Promise<RuntimeNode | null> {
    const node = await this.db.query.runtimeNodes.findFirst({
      where: eq(runtimeNodes.id, nodeId),
    });
    if (!node) return null;
    if (input.token?.startsWith("rnr_")) {
      await this.persistToken(nodeId, input.token);
    }
    const now = new Date();
    const [updated] = await this.db
      .update(runtimeNodes)
      .set({
        status: "online",
        hostInfoJson: input.hostInfo
          ? JSON.stringify(input.hostInfo)
          : node.hostInfoJson,
        agentVersion: input.agentVersion ?? node.agentVersion,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(runtimeNodes.id, nodeId))
      .returning();
    return updated ?? null;
  }

  async patch(
    tenantId: string,
    id: string,
    input: { name?: string; labels?: Record<string, unknown> },
  ): Promise<RuntimeNode | null> {
    const node = await this.get(tenantId, id);
    if (!node) return null;
    // Status is system-managed (register / heartbeat / offline timeout) — never client-editable
    const now = new Date();
    const [updated] = await this.db
      .update(runtimeNodes)
      .set({
        name: input.name?.trim() || node.name,
        labelsJson: input.labels ? JSON.stringify(input.labels) : node.labelsJson,
        updatedAt: now,
      })
      .where(eq(runtimeNodes.id, id))
      .returning();
    return updated ?? null;
  }

  async delete(tenantId: string, id: string): Promise<{ ok: true } | { error: string }> {
    const node = await this.get(tenantId, id);
    if (!node) return { error: "Not found" };
    if (node.kind === "local" || node.slug === "local") {
      return { error: "Cannot delete local runtime node" };
    }
    const bound = await this.db.query.agents.findFirst({
      where: and(eq(agents.tenantId, tenantId), eq(agents.runtimeNodeId, id)),
    });
    if (bound) return { error: "Node still has bound agents" };

    await this.db.delete(runtimeNodes).where(eq(runtimeNodes.id, id));
    return { ok: true };
  }

  /** Build a RunnerClient for a remote node; local returns null. */
  clientFor(node: RuntimeNode, rawToken?: string): RunnerClient | null {
    if (node.kind === "local" || !node.endpoint) return null;
    const token = rawToken ?? getCachedRunnerToken(node.id);
    if (!token) return null;
    return new RunnerClient({ baseUrl: node.endpoint, token });
  }

  /**
   * Resolve raw rnr_* token: memory cache first, then encrypted labels (survives Server restart).
   */
  resolveToken(node: RuntimeNode): string | null {
    const cached = getCachedRunnerToken(node.id);
    if (cached) return cached;
    try {
      const labels = JSON.parse(node.labelsJson || "{}") as Record<string, unknown>;
      const enc = labels[TOKEN_ENC_LABEL];
      if (typeof enc === "string" && enc.length > 0) {
        const raw = decryptJson<string>(this.config.secret, enc);
        if (typeof raw === "string" && raw.startsWith("rnr_")) {
          cacheRunnerToken(node.id, raw);
          return raw;
        }
      }
    } catch {
      /* ignore corrupt enc */
    }
    return null;
  }

  /**
   * Cache + persist token (encrypted in labels) so Server restart does not lose Runner access.
   */
  async persistToken(nodeId: string, raw: string): Promise<void> {
    cacheRunnerToken(nodeId, raw);
    const node = await this.db.query.runtimeNodes.findFirst({
      where: eq(runtimeNodes.id, nodeId),
    });
    if (!node) return;
    let labels: Record<string, unknown> = {};
    try {
      labels = JSON.parse(node.labelsJson || "{}") as Record<string, unknown>;
    } catch {
      labels = {};
    }
    labels[TOKEN_ENC_LABEL] = encryptJson(this.config.secret, raw);
    await this.db
      .update(runtimeNodes)
      .set({ labelsJson: JSON.stringify(labels), updatedAt: new Date() })
      .where(eq(runtimeNodes.id, nodeId));
  }

  /** Require a usable HTTP client for a remote runner node. */
  async requireRunnerClient(
    tenantId: string,
    nodeId: string,
    opts?: { allowOffline?: boolean },
  ): Promise<{ node: RuntimeNode; client: RunnerClient }> {
    await this.refreshOfflineStatuses(this.config.runnerHeartbeatTimeoutSec);
    const node = await this.get(tenantId, nodeId);
    if (!node) {
      throw new Error("所选运行节点不存在，请重新选择。");
    }
    if (node.kind === "local" || node.slug === "local") {
      throw new Error("当前操作需要远程运行节点。");
    }
    if (!opts?.allowOffline && (node.status === "offline" || node.status === "draining")) {
      throw new Error(
        node.status === "draining"
          ? `「${node.name}」正在排空，暂不可用。请选择其他节点，或使用「迁移」。`
          : `「${node.name}」当前离线。请等待节点上线，或迁移到其他可用节点。`,
      );
    }
    if (!node.endpoint?.trim()) {
      throw new Error(
        `「${node.name}」尚未完成注册。请在该设备启动 Runner 并完成注册。`,
      );
    }
    const token = this.resolveToken(node);
    if (!token) {
      throw new Error(
        `无法连接「${node.name}」：鉴权信息失效。请在该设备重新注册 Runner，或删除节点后重新创建。`,
      );
    }
    cacheRunnerToken(node.id, token);
    return {
      node,
      client: new RunnerClient({ baseUrl: node.endpoint.replace(/\/$/, ""), token }),
    };
  }

  /** Resolve node for an agent. null runtimeNodeId → local. */
  async resolveNodeForAgent(tenantId: string, agentRuntimeNodeId: string | null): Promise<RuntimeNode> {
    if (!agentRuntimeNodeId || agentRuntimeNodeId === LOCAL_RUNTIME_NODE_ID) {
      return this.ensureLocalNode(tenantId);
    }
    const node = await this.get(tenantId, agentRuntimeNodeId);
    if (!node) {
      throw new Error("当前绑定的运行节点已不存在，请重新选择运行位置。");
    }
    return node;
  }

  /** Mark offline nodes whose heartbeat timed out. Single batch UPDATE. */
  async refreshOfflineStatuses(timeoutSec = 60, tenantId?: string): Promise<void> {
    const cutoff = new Date(Date.now() - timeoutSec * 1000);
    const conds = [
      eq(runtimeNodes.kind, "runner"),
      eq(runtimeNodes.status, "online"),
    ];
    if (tenantId) conds.push(eq(runtimeNodes.tenantId, tenantId));
    await this.db
      .update(runtimeNodes)
      .set({ status: "offline", updatedAt: new Date() })
      .where(
        and(
          ...conds,
          // lastSeenAt 缺失或早于 cutoff（勿用 sql`... ${Date}`：postgres.js 会拒收 Date）
          or(isNull(runtimeNodes.lastSeenAt), lt(runtimeNodes.lastSeenAt, cutoff)),
        ),
      );
  }
}

/** In-memory raw token cache (create/register window) for Server→Runner calls. */
const tokenCache = new Map<string, string>();

export function cacheRunnerToken(nodeId: string, raw: string): void {
  tokenCache.set(nodeId, raw);
}

export function getCachedRunnerToken(nodeId: string): string | undefined {
  return tokenCache.get(nodeId);
}

export function clearCachedRunnerToken(nodeId: string): void {
  tokenCache.delete(nodeId);
}
