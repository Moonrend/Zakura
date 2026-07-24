import { and, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
  TUNNEL_PROVIDER_META,
  type PortExposureDto,
  type PortExposureProtocol,
  type TunnelProviderId,
} from "@zakura/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  agents,
  newId,
  portExposures,
  runtimeNodes,
  type PortExposure,
} from "../db/schema.js";
import type { DockerRuntime } from "../runtime/docker.js";
import type { AgentWorkspaceService } from "./agent-workspace.js";
import type { NetworkAuditService, AuditActor } from "./network-audit.js";
import type { NetworkSettingsService } from "./network-settings.js";
import type { SecurityPolicyService } from "./network-security.js";
import {
  startCloudflareQuickTunnel,
  type QuickTunnelHandle,
} from "../tunnel/cloudflare-quick.js";
import {
  probeTailscaleBackend,
  startTailscaleServe,
} from "../tunnel/tailscale-serve.js";

type LiveTunnel = {
  relayClose: () => void;
  tunnelStop: () => Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
};

const liveTunnels = new Map<string, LiveTunnel>();

/** Providers with a working local tunnel runtime on the Server today. */
const READY_TUNNEL_PROVIDERS = new Set<TunnelProviderId>([
  "cloudflare-quick",
  "tailscale-serve",
]);

export function isTunnelProviderRuntimeReady(provider: TunnelProviderId): boolean {
  return READY_TUNNEL_PROVIDERS.has(provider);
}

export function serializeExposure(
  row: PortExposure,
  agent?: { name: string; slug: string } | null,
): PortExposureDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    agentId: row.agentId,
    agentName: agent?.name ?? null,
    agentSlug: agent?.slug ?? null,
    runtimeNodeId: row.runtimeNodeId,
    name: row.name,
    port: row.port,
    protocol: row.protocol as PortExposureProtocol,
    provider: row.provider as TunnelProviderId,
    status: row.status as PortExposureDto["status"],
    publicUrl: row.publicUrl,
    relayHost: row.relayHost,
    relayPort: row.relayPort,
    ttlMinutes: row.ttlMinutes,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdByType: row.createdByType,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    stoppedAt: row.stoppedAt?.toISOString() ?? null,
  };
}

export type CreateExposureInput = {
  port: number;
  provider?: string;
  name?: string;
  ttlMinutes?: number;
  protocol?: PortExposureProtocol;
};

export class ExposureService {
  private nodes: import("./runtime-nodes.js").RuntimeNodeService | null = null;

  constructor(
    private readonly db: Db,
    _config: AppConfig,
    private readonly runtime: DockerRuntime,
    private readonly workspace: AgentWorkspaceService,
    private readonly settings: NetworkSettingsService,
    private readonly security: SecurityPolicyService,
    private readonly audit: NetworkAuditService,
  ) {
    void _config;
  }

  setRuntimeNodes(nodes: import("./runtime-nodes.js").RuntimeNodeService) {
    this.nodes = nodes;
  }

  async listForAgent(tenantId: string, agentId: string): Promise<PortExposureDto[]> {
    await this.expireDue(tenantId);
    const rows = await this.db
      .select()
      .from(portExposures)
      .where(and(eq(portExposures.tenantId, tenantId), eq(portExposures.agentId, agentId)))
      .orderBy(desc(portExposures.createdAt));
    const agent = await this.db.query.agents.findFirst({
      where: and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)),
    });
    return rows.map((r) =>
      serializeExposure(r, agent ? { name: agent.name, slug: agent.slug } : null),
    );
  }

  async listActive(tenantId: string): Promise<PortExposureDto[]> {
    await this.expireDue(tenantId);
    const rows = await this.db
      .select()
      .from(portExposures)
      .where(
        and(
          eq(portExposures.tenantId, tenantId),
          inArray(portExposures.status, ["active", "starting"]),
        ),
      )
      .orderBy(desc(portExposures.createdAt));

    const agentIds = [...new Set(rows.map((r) => r.agentId))];
    const agentRows =
      agentIds.length > 0
        ? await this.db.select().from(agents).where(inArray(agents.id, agentIds))
        : [];
    const byId = new Map(agentRows.map((a) => [a.id, a]));
    return rows.map((r) => {
      const a = byId.get(r.agentId);
      return serializeExposure(r, a ? { name: a.name, slug: a.slug } : null);
    });
  }

  /**
   * Providers the agent may use for expose_port (filtered by enablement + security policy).
   * `ready` means the runtime path is implemented on this server.
   */
  async listExposers(tenantId: string): Promise<{
    defaultProvider: TunnelProviderId | null;
    exposureEnabled: boolean;
    agentsCanExpose: boolean;
    exposers: Array<{
      id: TunnelProviderId;
      name: string;
      description: string;
      enabled: boolean;
      isDefault: boolean;
      publicExposure: boolean;
      requiresConfig: boolean;
      ready: boolean;
      usable: boolean;
      reason: string | null;
    }>;
  }> {
    await this.settings.ensureTenantDefaults(tenantId);
    const policy = await this.security.getRow(tenantId);
    const providers = await this.settings.listProviders(tenantId);
    const defaultProvider =
      providers.find((p) => p.isDefault && p.enabled)?.provider ??
      providers.find((p) => p.enabled)?.provider ??
      null;

    const exposers: Array<{
      id: TunnelProviderId;
      name: string;
      description: string;
      enabled: boolean;
      isDefault: boolean;
      publicExposure: boolean;
      requiresConfig: boolean;
      ready: boolean;
      usable: boolean;
      reason: string | null;
    }> = [];
    for (const p of providers) {
      const ready = isTunnelProviderRuntimeReady(p.provider);
      let usable = true;
      let reason: string | null = null;

      if (!policy.enabled || !policy.exposureEnabled) {
        usable = false;
        reason = "端口暴露已被安全策略禁用";
      } else if (!policy.agentsCanExpose) {
        usable = false;
        reason = "Agent 自助暴露已被管理员禁用";
      } else if (!p.enabled) {
        usable = false;
        reason = "管理员未启用该暴露器";
      } else if (p.meta.publicExposure && !policy.allowPublicExposure) {
        usable = false;
        reason = "公网暴露已被安全策略禁用";
      } else if (p.meta.requiresConfig && !p.hasConfig) {
        usable = false;
        reason = "缺少必需配置（Token / Server 等）";
      } else if (!ready) {
        usable = false;
        reason = "运行时尚未实现，暂不可用";
      } else if (p.provider === "tailscale-serve") {
        const probe = await probeTailscaleBackend();
        if (!probe.ok) {
          usable = false;
          reason = probe.message;
        }
      }

      exposers.push({
        id: p.provider,
        name: p.meta.name,
        description: p.meta.description,
        enabled: p.enabled,
        isDefault: p.isDefault,
        publicExposure: p.meta.publicExposure,
        requiresConfig: p.meta.requiresConfig,
        ready,
        usable,
        reason,
      });
    }

    return {
      defaultProvider,
      exposureEnabled: policy.enabled && policy.exposureEnabled,
      agentsCanExpose: policy.agentsCanExpose,
      exposers,
    };
  }

  async create(
    tenantId: string,
    agentId: string,
    input: CreateExposureInput,
    actor: AuditActor,
  ): Promise<PortExposureDto> {
    await this.settings.ensureTenantDefaults(tenantId);
    const policy = await this.security.getRow(tenantId);

    if (!policy.enabled || !policy.exposureEnabled) {
      throw new Error("端口暴露已被安全策略禁用");
    }
    if (actor.type === "agent" && !policy.agentsCanExpose) {
      throw new Error("Agent 自助暴露已被管理员禁用");
    }

    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Invalid port");
    }
    this.security.assertPortAllowed(policy, port);

    const protocol: PortExposureProtocol = input.protocol ?? "http";
    if (protocol === "tcp" && !policy.allowTcpExposure) {
      throw new Error("TCP 暴露已被安全策略禁用");
    }

    const providerId =
      (input.provider as TunnelProviderId | undefined) ??
      (await this.settings.getDefaultProviderId(tenantId));

    const providerSetting = await this.settings.getProvider(tenantId, providerId);
    if (!providerSetting?.enabled) {
      throw new Error(`Provider ${providerId} 未启用`);
    }

    const meta = TUNNEL_PROVIDER_META[providerId];
    if (meta.publicExposure && !policy.allowPublicExposure) {
      throw new Error("公网暴露已被安全策略禁用");
    }

    let ttl = input.ttlMinutes ?? policy.defaultTtlMinutes;
    ttl = Math.max(1, Math.min(ttl, policy.maxTtlMinutes));

    const [activeAgent] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(portExposures)
      .where(
        and(
          eq(portExposures.tenantId, tenantId),
          eq(portExposures.agentId, agentId),
          inArray(portExposures.status, ["active", "starting"]),
        ),
      );
    if ((activeAgent?.count ?? 0) >= policy.maxActivePerAgent) {
      throw new Error(`该 Agent 活跃隧道数已达上限（${policy.maxActivePerAgent}）`);
    }

    const [activeTenant] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(portExposures)
      .where(
        and(
          eq(portExposures.tenantId, tenantId),
          inArray(portExposures.status, ["active", "starting"]),
        ),
      );
    if ((activeTenant?.count ?? 0) >= policy.maxActivePerTenant) {
      throw new Error(`租户活跃隧道数已达上限（${policy.maxActivePerTenant}）`);
    }

    const agent = await this.db.query.agents.findFirst({
      where: and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)),
    });
    if (!agent) throw new Error("Agent not found");

    const node =
      agent.runtimeNodeId && this.nodes
        ? await this.nodes.getAccessible(tenantId, agent.runtimeNodeId)
        : agent.runtimeNodeId
          ? await this.db.query.runtimeNodes.findFirst({
              where: eq(runtimeNodes.id, agent.runtimeNodeId),
            })
          : null;

    const isRemote = Boolean(node && node.kind === "runner");

    // 本机：需 workspace 容器在 Server Docker；远程：由 Runner 侧校验容器状态
    if (!isRemote) {
      const container = await this.workspace.getWorkspaceContainer(agentId);
      if (!container?.dockerId || container.status !== "running") {
        throw new Error("Workspace 容器未运行，无法暴露端口");
      }
    } else {
      const container = await this.workspace.getWorkspaceContainer(agentId);
      if (!container || (container.status !== "running" && container.status !== "starting")) {
        throw new Error("远程工作区未运行，无法暴露端口");
      }
      if (providerId !== "cloudflare-quick") {
        throw new Error("远程 Runner 目前仅支持 Cloudflare Quick Tunnel");
      }
      if (!this.nodes) {
        throw new Error("Runtime nodes 服务不可用");
      }
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 60_000);
    const [row] = await this.db
      .insert(portExposures)
      .values({
        id: newId(),
        tenantId,
        agentId,
        runtimeNodeId: agent.runtimeNodeId,
        name: input.name?.trim() || `port-${port}`,
        port,
        protocol,
        provider: providerId,
        status: "starting",
        ttlMinutes: ttl,
        expiresAt,
        createdByType: actor.type,
        createdById: actor.id ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    try {
      if (!isTunnelProviderRuntimeReady(providerId)) {
        throw new Error(
          `Provider ${providerId} 运行时尚未实现；请用 list_exposers 查看 usable=true 的暴露器`,
        );
      }

      let publicUrl: string;
      let relayHost: string | null = null;
      let relayPort: number | null = null;
      let tunnelStop: () => Promise<void>;
      let relayClose: () => void = () => undefined;

      if (isRemote) {
        const { client } = await this.nodes!.requireRunnerClient(tenantId, node!.id);
        const remote = await client.startExposure({
          exposureId: row!.id,
          agentId,
          port,
          provider: providerId,
          protocol,
          ttlMinutes: ttl,
        });
        publicUrl = remote.publicUrl;
        relayHost = remote.relayHost;
        relayPort = remote.relayPort;
        tunnelStop = async () => {
          await client.stopExposure(row!.id).catch(() => undefined);
        };
      } else {
        const container = await this.workspace.getWorkspaceContainer(agentId);
        const relay = await this.runtime.openTcpTunnel(container!.dockerId!, port);
        relayClose = relay.close;
        relayHost = relay.host;
        relayPort = relay.port;
        const targetUrl = `http://127.0.0.1:${relay.port}`;

        try {
          if (providerId === "cloudflare-quick") {
            const tunnel = await startCloudflareQuickTunnel(targetUrl);
            publicUrl = tunnel.publicUrl;
            tunnelStop = tunnel.stop;
          } else if (providerId === "tailscale-serve") {
            const mountPath = `/zakura/${row!.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || row!.id.slice(0, 8)}`;
            const tunnel = await startTailscaleServe({
              targetUrl,
              mountPath,
            });
            publicUrl = tunnel.publicUrl;
            tunnelStop = tunnel.stop;
          } else {
            throw new Error(`Provider ${providerId} 未接线`);
          }
        } catch (startErr) {
          try {
            relay.close();
          } catch {
            /* ignore */
          }
          throw startErr;
        }
      }

      const [updated] = await this.db
        .update(portExposures)
        .set({
          status: "active",
          publicUrl,
          relayHost,
          relayPort,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(portExposures.id, row!.id))
        .returning();

      const timer = setTimeout(
        () => {
          void this.stop(tenantId, row!.id, { type: "system", id: "ttl" }).catch(() => undefined);
        },
        ttl * 60_000,
      );

      liveTunnels.set(row!.id, {
        relayClose,
        tunnelStop,
        timer,
      });

      await this.audit.append(tenantId, "exposure.create", {
        actor,
        targetType: "port_exposure",
        targetId: row!.id,
        detail: {
          port,
          provider: providerId,
          publicUrl,
          agentId,
          remote: isRemote,
        },
      });

      return serializeExposure(updated, { name: agent.name, slug: agent.slug });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const [failed] = await this.db
        .update(portExposures)
        .set({
          status: "error",
          lastError: message,
          updatedAt: new Date(),
          stoppedAt: new Date(),
        })
        .where(eq(portExposures.id, row!.id))
        .returning();
      await this.audit.append(tenantId, "exposure.create", {
        actor,
        targetType: "port_exposure",
        targetId: row!.id,
        detail: { port, provider: providerId, error: message },
      });
      throw Object.assign(new Error(message), { exposure: serializeExposure(failed, agent) });
    }
  }

  async stop(
    tenantId: string,
    exposureId: string,
    actor: AuditActor,
  ): Promise<PortExposureDto | null> {
    const row = await this.db.query.portExposures.findFirst({
      where: and(eq(portExposures.id, exposureId), eq(portExposures.tenantId, tenantId)),
    });
    if (!row) return null;

    const live = liveTunnels.get(exposureId);
    if (live) {
      if (live.timer) clearTimeout(live.timer);
      try {
        live.relayClose();
      } catch {
        /* ignore */
      }
      try {
        await live.tunnelStop();
      } catch {
        /* ignore */
      }
      liveTunnels.delete(exposureId);
    } else if (row.runtimeNodeId && this.nodes) {
      // Server 重启后内存隧道丢失：尽量通知远程 Runner 停掉 cloudflared
      try {
        const { client } = await this.nodes.requireRunnerClient(tenantId, row.runtimeNodeId, {
          allowOffline: true,
        });
        await client.stopExposure(exposureId);
      } catch {
        /* ignore */
      }
    }

    const now = new Date();
    const nextStatus =
      row.status === "active" || row.status === "starting"
        ? actor.type === "system" && actor.id === "ttl"
          ? "expired"
          : "stopped"
        : row.status;

    const [updated] = await this.db
      .update(portExposures)
      .set({
        status: nextStatus,
        stoppedAt: now,
        updatedAt: now,
      })
      .where(eq(portExposures.id, exposureId))
      .returning();

    await this.audit.append(tenantId, nextStatus === "expired" ? "exposure.expire" : "exposure.stop", {
      actor,
      targetType: "port_exposure",
      targetId: exposureId,
      detail: { port: row.port, publicUrl: row.publicUrl },
    });

    const agent = await this.db.query.agents.findFirst({
      where: eq(agents.id, row.agentId),
    });
    return serializeExposure(updated, agent ? { name: agent.name, slug: agent.slug } : null);
  }

  async stopByPort(
    tenantId: string,
    agentId: string,
    port: number,
    actor: AuditActor,
  ): Promise<PortExposureDto | null> {
    const row = await this.db.query.portExposures.findFirst({
      where: and(
        eq(portExposures.tenantId, tenantId),
        eq(portExposures.agentId, agentId),
        eq(portExposures.port, port),
        inArray(portExposures.status, ["active", "starting"]),
      ),
    });
    if (!row) return null;
    return this.stop(tenantId, row.id, actor);
  }

  async stopAllActive(tenantId: string, actor: AuditActor): Promise<number> {
    const rows = await this.db
      .select()
      .from(portExposures)
      .where(
        and(
          eq(portExposures.tenantId, tenantId),
          inArray(portExposures.status, ["active", "starting"]),
        ),
      );
    for (const row of rows) {
      await this.stop(tenantId, row.id, actor);
    }
    return rows.length;
  }

  async expireDue(tenantId?: string): Promise<number> {
    const now = new Date();
    // 勿用 sql`... ${Date}`：postgres.js 会拒收 Date，导致 active-exposures 500
    const conds = [
      inArray(portExposures.status, ["active", "starting"]),
      isNotNull(portExposures.expiresAt),
      lte(portExposures.expiresAt, now),
    ];
    if (tenantId) conds.push(eq(portExposures.tenantId, tenantId));

    const due = await this.db.select().from(portExposures).where(and(...conds));
    for (const row of due) {
      await this.stop(row.tenantId, row.id, { type: "system", id: "ttl" });
    }
    return due.length;
  }
}

/** Re-attach TTL timers after process restart is not possible for live tunnels;
 * mark orphaned active rows as error on boot. */
export async function reconcileOrphanExposures(db: Db): Promise<number> {
  const now = new Date();
  const orphans = await db
    .select()
    .from(portExposures)
    .where(inArray(portExposures.status, ["active", "starting"]));
  let n = 0;
  for (const row of orphans) {
    if (liveTunnels.has(row.id)) continue;
    await db
      .update(portExposures)
      .set({
        status: "error",
        lastError: "Server restarted; tunnel process lost",
        stoppedAt: now,
        updatedAt: now,
      })
      .where(eq(portExposures.id, row.id));
    n += 1;
  }
  return n;
}

export type { QuickTunnelHandle };
