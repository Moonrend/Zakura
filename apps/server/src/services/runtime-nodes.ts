import { and, eq, inArray, isNull, lt, or, ne, notInArray } from "drizzle-orm";
import {
  decryptJson,
  encryptJson,
  generateRunnerToken,
  hashRunnerToken,
  RunnerClient,
} from "@zakura/core";
import { LOCAL_RUNTIME_NODE_ID, type RunnerHostInfo } from "@zakura/shared";
import type { RunnerHub } from "./runner-hub.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  agents,
  componentInstances,
  managedContainers,
  portExposures,
  runtimeNodes,
  users,
  workspaceMigrations,
  type RuntimeNode,
} from "../db/schema.js";
import {
  listSharedRunnerNodes,
  resolveAccessibleNode,
} from "./runner-access.js";
import { platformEvents } from "./platform-events.js";

const TOKEN_ENC_LABEL = "_tokenEnc";

export function mapRuntimeNode(
  row: RuntimeNode,
  opts?: { access?: "owned" | "shared" },
) {
  const labels = JSON.parse(row.labelsJson || "{}") as Record<string, unknown>;
  // Never expose encrypted token material to API clients
  const { [TOKEN_ENC_LABEL]: _hidden, ...publicLabels } = labels;
  void _hidden;
  const access =
    opts?.access ?? "owned";
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
    isShared: Boolean(row.isShared),
    createdByUserId: row.createdByUserId ?? null,
    /** owned = 本租户节点；shared = 跨租户共享池（只读使用） */
    access,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    needsReinstall: row.kind === "local" || row.kind === "runner",
  };
}

export class RuntimeNodeService {
  hub: RunnerHub | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {}

  bindHub(hub: RunnerHub) {
    this.hub = hub;
  }

  private withLiveStatus<T extends RuntimeNode>(node: T): T {
    // DB heartbeats can outlive a server restart or come from a legacy HTTP
    // runner. Only a ready Hub session can execute work on this control plane.
    if (node.status === "draining") return node;
    return { ...node, status: this.hub?.get(node.id) ? "online" : "offline" };
  }

  /** @deprecated 隐式 local 节点已删除，调用方应改为选择在线 Go 代理 */
  async ensureLocalNode(_tenantId?: string): Promise<RuntimeNode> {
    throw new Error("隐式本机节点已移除。请安装 zakura-agent 并绑定电脑或服务器。");
  }

  async list(tenantId: string): Promise<RuntimeNode[]> {
    const rows = await this.db.query.runtimeNodes.findMany({
      where: eq(runtimeNodes.tenantId, tenantId),
    });
    return rows.map((node) => this.withLiveStatus(node));
  }

  /**
   * 本租户节点 + 跨租户共享远程 Runner。
   * Local 是否返回由调用方按 canUseLocalRunner 过滤。
   */
  async listAccessible(tenantId: string): Promise<Array<RuntimeNode & { access: "owned" | "shared" }>> {
    const owned = await this.list(tenantId);
    const shared = await listSharedRunnerNodes(this.db, tenantId);
    return [
      ...owned.map((n) => ({ ...n, access: "owned" as const })),
      ...shared.map((n) => ({ ...this.withLiveStatus(n), access: "shared" as const })),
    ];
  }

  async get(tenantId: string, id: string): Promise<RuntimeNode | null> {
    const node = await this.db.query.runtimeNodes.findFirst({
      where: and(eq(runtimeNodes.tenantId, tenantId), eq(runtimeNodes.id, id)),
    });
    return node ? this.withLiveStatus(node) : null;
  }

  /** 本租户或共享节点 */
  async getAccessible(tenantId: string, id: string): Promise<RuntimeNode | null> {
    const node = await resolveAccessibleNode(this.db, tenantId, id);
    return node ? this.withLiveStatus(node) : null;
  }

  /** Create a remote runner node; returns one-time token. */
  async create(
    tenantId: string,
    input: {
      name: string;
      kind?: "computer" | "server";
      labels?: Record<string, unknown>;
      createdByUserId?: string | null;
    },
  ): Promise<{ node: RuntimeNode; token: string }> {
    // Derive slug from user-provided name for readable container/hostname names.
    const base = input.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "runner";
    let slug = "";
    for (let suffix = 0; suffix < 20; suffix++) {
      const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
      const existing = await this.db.query.runtimeNodes.findFirst({
        where: and(eq(runtimeNodes.tenantId, tenantId), eq(runtimeNodes.slug, candidate)),
      });
      if (!existing) {
        slug = candidate;
        break;
      }
    }
    if (!slug) {
      slug = `${base}-${Date.now().toString(36)}`;
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
        kind: input.kind === "server" ? "server" : "computer",
        status: "offline",
        endpoint: null,
        capabilitiesJson: "{}",
        hostInfoJson: "{}",
        storageRoot: "",
        tokenHash: hash,
        labelsJson: JSON.stringify(labels),
        isShared: false,
        createdByUserId: input.createdByUserId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    cacheRunnerToken(row!.id, raw);
    return { node: row!, token: raw };
  }

  /**
   * 平台管理员将远程 runner 设为共享。共享 runner 必须由平台管理员持有/创建。
   */
  async setShared(
    nodeId: string,
    isShared: boolean,
    actor: { userId: string; isPlatformAdmin: boolean },
  ): Promise<RuntimeNode> {
    if (!actor.isPlatformAdmin) {
      throw new Error("仅平台管理员可配置共享 Runner");
    }
    const node = await this.db.query.runtimeNodes.findFirst({
      where: eq(runtimeNodes.id, nodeId),
    });
    if (!node) throw new Error("Runner 不存在");
    if (node.slug === "local") {
      throw new Error("旧本机节点不可设为共享");
    }

    if (isShared) {
      const ownerId = node.createdByUserId ?? actor.userId;
      const owner = await this.db.query.users.findFirst({
        where: eq(users.id, ownerId),
      });
      if (!owner?.isPlatformAdmin) {
        throw new Error("共享 Runner 必须属于平台管理员");
      }
      // 若尚无创建者，归属到当前管理员
      const [updated] = await this.db
        .update(runtimeNodes)
        .set({
          isShared: true,
          createdByUserId: ownerId,
          updatedAt: new Date(),
        })
        .where(eq(runtimeNodes.id, nodeId))
        .returning();
      return updated!;
    }

    const [updated] = await this.db
      .update(runtimeNodes)
      .set({ isShared: false, updatedAt: new Date() })
      .where(eq(runtimeNodes.id, nodeId))
      .returning();
    return updated!;
  }

  /** 平台管理：列出全部远程 runner（含共享状态） */
  async listAllRemote(): Promise<RuntimeNode[]> {
    const rows = await this.db.query.runtimeNodes.findMany({
      where: ne(runtimeNodes.slug, "local"),
    });
    return rows.map((node) => this.withLiveStatus(node));
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
        status: this.withLiveStatus(node).status,
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
        status: this.withLiveStatus(node).status,
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
    const result = await this.db.transaction(async (tx) => {
      // Serialize deletion against new FK references, including shared consumers.
      const [node] = await tx.select().from(runtimeNodes)
        .where(and(eq(runtimeNodes.id, id), eq(runtimeNodes.tenantId, tenantId)))
        .for("update");
      if (!node) return { error: "Not found" };
      if (node.kind === "local" || node.slug === "local") {
        return { error: "Cannot delete local runtime node" };
      }
      const referencesNode = or(
        eq(workspaceMigrations.sourceNodeId, id),
        eq(workspaceMigrations.targetNodeId, id),
      );
      const active = await tx.select({ id: workspaceMigrations.id }).from(workspaceMigrations)
        .where(and(referencesNode, notInArray(workspaceMigrations.status, ["completed", "failed", "cancelled"])))
        .limit(1);
      if (active.length) return { error: "节点仍有进行中的工作区迁移，请等待迁移结束后再删除。" };

      const now = new Date();
      const lastError = `运行节点「${node.name}」已删除，请重新绑定电脑或服务器。`;
      const history = await tx.delete(workspaceMigrations).where(referencesNode)
        .returning();
      if (history.length) {
        await tx.update(agents).set({ lastMigrationId: null, updatedAt: now })
          .where(inArray(agents.lastMigrationId, history.map((job) => job.id)));
      }

      // Do not scope dependencies to the owner tenant: shared nodes can have
      // consumers in other tenants. Agent data/configuration stays intact.
      const detached = await tx.update(agents)
        .set({ runtimeNodeId: null, lastError, updatedAt: now })
        .where(eq(agents.runtimeNodeId, id))
        .returning();
      await tx.update(componentInstances)
        .set({ runtimeNodeId: null, status: "stopped", endpointUrl: null, healthStatus: "unknown", healthClaimUntil: null, lastError, updatedAt: now })
        .where(or(
          eq(componentInstances.runtimeNodeId, id),
          inArray(componentInstances.id, tx.select({ id: managedContainers.instanceId })
            .from(managedContainers).where(eq(managedContainers.runtimeNodeId, id))),
        ));
      await tx.update(portExposures)
        .set({ runtimeNodeId: null, status: "stopped", publicUrl: null, relayHost: null, relayPort: null, stoppedAt: now, lastError, updatedAt: now })
        .where(eq(portExposures.runtimeNodeId, id));
      // SET NULL alone would make remote Docker IDs look like local containers.
      // Remove bookkeeping only; deleting a node must not erase remote files.
      await tx.delete(managedContainers).where(eq(managedContainers.runtimeNodeId, id));
      await tx.delete(runtimeNodes)
        .where(and(eq(runtimeNodes.id, id), eq(runtimeNodes.tenantId, tenantId)));
      return { node, detached };
    });
    if ("error" in result) return { error: result.error! };

    this.hub?.disconnect(id);
    clearCachedRunnerToken(id);
    for (const agent of result.detached) {
      platformEvents.publish(agent.tenantId, { type: "agent_config_changed", agentId: agent.id });
    }
    const event = { type: "runner_node" as const, nodeId: id };
    if (result.node.isShared) platformEvents.publishAll(event);
    else platformEvents.publish(tenantId, event);
    return { ok: true };
  }

  clientFor(node: RuntimeNode): RunnerClient | null {
    const session = this.hub?.get(node.id);
    if (!session) return null;
    return new RunnerClient({
      hub: session,
      workspaceKind: node.kind === "computer" ? "host" : "container",
    });
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

  async requireRunnerClient(
    tenantId: string,
    nodeId: string,
    opts?: {
      allowOffline?: boolean;
      skipHeartbeatRefresh?: boolean;
      workspaceKind?: "host" | "container";
    },
  ): Promise<{ node: RuntimeNode; client: RunnerClient }> {
    if (!opts?.skipHeartbeatRefresh) {
      await this.refreshOfflineStatuses(this.config.runnerHeartbeatTimeoutSec);
    }
    const node = await this.getAccessible(tenantId, nodeId);
    if (!node) {
      throw new Error("所选运行节点不存在，请重新选择。");
    }
    if (node.kind === "local" || node.slug === "local") {
      throw new Error("旧本机节点已停用。请安装 zakura-agent 并重新绑定。");
    }
    const session = this.hub?.get(node.id);
    if (!session) {
      if (node.isShared && node.tenantId !== tenantId) {
        throw new Error(`共享节点「${node.name}」当前离线，请选择其他在线节点或联系平台管理员。`);
      }
      throw new Error(`「${node.name}」的 Go 代理当前离线。请在该设备启动 zakura-agent 并检查网络连接。`);
    }
    const workspaceKind =
      opts?.workspaceKind ?? (node.kind === "computer" ? "host" : "container");
    return {
      node,
      client: new RunnerClient({ hub: session, workspaceKind }),
    };
  }

  async resolveNodeForAgent(tenantId: string, agentRuntimeNodeId: string | null): Promise<RuntimeNode> {
    if (!agentRuntimeNodeId || agentRuntimeNodeId === LOCAL_RUNTIME_NODE_ID) {
      throw new Error("请先绑定一台电脑或服务器");
    }
    const node = await this.getAccessible(tenantId, agentRuntimeNodeId);
    if (!node) {
      throw new Error("当前绑定的运行节点已不存在，请重新选择运行位置。");
    }
    return node;
  }

  /** Mark offline nodes whose heartbeat timed out. Single batch UPDATE. */
  async refreshOfflineStatuses(timeoutSec = 60, tenantId?: string): Promise<void> {
    const cutoff = new Date(Date.now() - timeoutSec * 1000);
    const conds = [
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
