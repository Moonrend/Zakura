import { and, asc, eq, gte, ne, sql } from "drizzle-orm";
import {
  TUNNEL_PROVIDER_IDS,
  TUNNEL_PROVIDER_META,
  buildRunnerComposeSnippet,
  buildRunnerInstallPackage,
  type NetworkOverviewDto,
  type RunnerInstallPackage,
  type TunnelProviderId,
  type TunnelProviderSettingDto,
} from "@zakura/shared";
import { decryptJson, encryptJson } from "@zakura/core";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  networkIntegrations,
  newId,
  portExposures,
  runtimeNodes,
  tunnelProviderSettings,
  type TunnelProviderSetting,
} from "../db/schema.js";
import type { NetworkAuditService } from "./network-audit.js";
import type { SecurityPolicyService } from "./network-security.js";
import { startCloudflareQuickTunnel } from "../tunnel/cloudflare-quick.js";
import { probeTailscaleBackend } from "../tunnel/tailscale-serve.js";
import {
  TailscaleAdminClient,
  normalizeTailscaleTags,
  type TailscaleDevice,
  type TailscaleOAuthCredentials,
} from "./tailscale-admin.js";
import {
  HeadscaleAdminClient,
  headscaleTenantUserName,
  type HeadscaleNode,
} from "./headscale-admin.js";
import {
  loadPlatformHeadscaleResolved,
  persistPlatformAuthKey,
  getPlatformHeadscalePublic,
  patchPlatformHeadscale,
  type PlatformHeadscaleResolved,
  type PlatformHeadscalePublic,
  type PlatformHeadscalePatch,
} from "./platform-headscale.js";
import { CloudflareAdminClient } from "./cloudflare-admin.js";
import { HostTailscaleService } from "./host-tailscale.js";
import type { MeshProviderId } from "@zakura/shared";

const SECRET_KEYS = new Set([
  "token",
  "authtoken",
  "authToken",
  "auth_token",
  "client_secret",
  "clientSecret",
  "tunnel_token",
  "tunnelToken",
  "apiToken",
  "api_token",
  "password",
  "secret",
]);

function isProviderId(v: string): v is TunnelProviderId {
  return (TUNNEL_PROVIDER_IDS as readonly string[]).includes(v);
}

function redactConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (SECRET_KEYS.has(k) || /secret|token|password|key/i.test(k)) {
      if (typeof v === "string" && v.length > 0) out[k] = "••••••••";
      else if (v != null && v !== "") out[k] = "••••••••";
    } else {
      out[k] = v;
    }
  }
  return out;
}

function parseConfig(raw: string, secret: string): Record<string, unknown> {
  try {
    // Prefer encrypted payload; fall back to plain JSON for empty default "{}"
    if (!raw || raw === "{}") return {};
    if (raw.startsWith("{") && !raw.includes('"ciphertext"')) {
      return JSON.parse(raw) as Record<string, unknown>;
    }
    return decryptJson<Record<string, unknown>>(secret, raw);
  } catch {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

function hasSecrets(cfg: Record<string, unknown>): boolean {
  return Object.entries(cfg).some(
    ([k, v]) =>
      (SECRET_KEYS.has(k) || /secret|token|password|key/i.test(k)) &&
      typeof v === "string" &&
      v.length > 0 &&
      v !== "••••••••",
  );
}

export function serializeProviderSetting(
  row: TunnelProviderSetting,
  secret: string,
): TunnelProviderSettingDto {
  const provider = (isProviderId(row.provider) ? row.provider : "cloudflare-quick") as TunnelProviderId;
  const config = parseConfig(row.configEnc, secret);
  return {
    id: row.id,
    tenantId: row.tenantId,
    provider,
    enabled: row.enabled,
    isDefault: row.isDefault,
    config: redactConfig(config),
    hasConfig: Object.keys(config).length > 0 || hasSecrets(config),
    lastTestAt: row.lastTestAt?.toISOString() ?? null,
    lastTestOk: row.lastTestOk,
    lastError: row.lastError,
    meta: TUNNEL_PROVIDER_META[provider],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class NetworkSettingsService {
  private readonly hostTailscale: HostTailscaleService;
  /** Tenants that already have tunnel provider defaults seeded */
  private readonly defaultsReady = new Set<string>();
  /**
   * Skip Headscale refresh while mesh is connected.
   * Cleared on connect/disconnect/sync/auth-key mutations.
   */
  private readonly meshFreshUntil = new Map<string, number>();
  private static readonly MESH_FRESH_TTL_MS = 60_000;
  /** Cached platform Headscale config from DB */
  private platformHs: PlatformHeadscaleResolved | null = null;
  private platformHsAt = 0;
  private static readonly PLATFORM_HS_TTL_MS = 15_000;

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly security: SecurityPolicyService,
    private readonly audit: NetworkAuditService,
  ) {
    this.hostTailscale = new HostTailscaleService(config);
  }

  /** Invalidate cached mesh freshness so next getMesh may re-provision / refresh. */
  invalidateMeshCache(tenantId: string): void {
    this.meshFreshUntil.delete(tenantId);
  }

  private markMeshFresh(tenantId: string): void {
    this.meshFreshUntil.set(
      tenantId,
      Date.now() + NetworkSettingsService.MESH_FRESH_TTL_MS,
    );
  }

  private isMeshFresh(tenantId: string): boolean {
    const until = this.meshFreshUntil.get(tenantId);
    return until != null && until > Date.now();
  }

  /** Reload platform Headscale from DB (call after admin saves). */
  async refreshPlatformHeadscale(): Promise<PlatformHeadscaleResolved> {
    this.platformHs = await loadPlatformHeadscaleResolved(this.db, this.config.secret);
    this.platformHsAt = Date.now();
    return this.platformHs;
  }

  async getPlatformHeadscalePublic(): Promise<PlatformHeadscalePublic> {
    if (!this.config.multiTenant) {
      return {
        enabled: false,
        url: "",
        hasApiKey: false,
        hasPlatformAuthKey: false,
        ready: false,
      };
    }
    return getPlatformHeadscalePublic(this.db, this.config.secret);
  }

  async updatePlatformHeadscale(
    patch: PlatformHeadscalePatch,
  ): Promise<PlatformHeadscalePublic> {
    if (!this.config.multiTenant) {
      throw new Error("平台 Headscale 仅在 SaaS（多租户）部署下可用");
    }
    const pub = await patchPlatformHeadscale(this.db, this.config.secret, patch);
    await this.refreshPlatformHeadscale();
    return pub;
  }

  async getPlatformHeadscale(force = false): Promise<PlatformHeadscaleResolved> {
    const fresh =
      this.platformHs != null &&
      !force &&
      Date.now() - this.platformHsAt < NetworkSettingsService.PLATFORM_HS_TTL_MS;
    if (fresh) return this.platformHs!;
    return this.refreshPlatformHeadscale();
  }

  /** Platform Headscale is configured — SaaS only. */
  async isPlatformHeadscaleAvailable(): Promise<boolean> {
    if (!this.config.multiTenant) return false;
    const hs = await this.getPlatformHeadscale();
    return hs.enabled;
  }

  async getHeadscaleClient(): Promise<HeadscaleAdminClient | null> {
    const hs = await this.getPlatformHeadscale();
    if (!hs.enabled) return null;
    return new HeadscaleAdminClient({
      url: hs.url,
      apiKey: hs.apiKey,
    });
  }

  /** Deployment mesh mode — decided by ops config, not by tenants. */
  async preferredMeshProvider(): Promise<MeshProviderId> {
    return (await this.isPlatformHeadscaleAvailable())
      ? "headscale-platform"
      : "tailscale-cloud";
  }

  /** Whether the control-plane host joins the mesh for this deployment mode. */
  async hostJoinsTailscaleForTenant(
    meshProvider: MeshProviderId | null,
  ): Promise<boolean> {
    if (
      meshProvider === "headscale-platform" ||
      (await this.isPlatformHeadscaleAvailable())
    ) {
      return this.hostTailscale.hostMayJoinMesh({ platformHeadscale: true });
    }
    return !this.config.multiTenant;
  }

  private async loadPlatformIntegration(tenantId: string) {
    return this.db.query.networkIntegrations.findFirst({
      where: and(
        eq(networkIntegrations.tenantId, tenantId),
        eq(networkIntegrations.kind, "headscale-platform"),
      ),
    });
  }

  /**
   * Active mesh provider for a tenant.
   * Platform Headscale (when configured) always wins — cloud OAuth is unavailable.
   */
  async resolveMeshProvider(tenantId: string): Promise<MeshProviderId | null> {
    if (await this.isPlatformHeadscaleAvailable()) return "headscale-platform";
    const oauth = await this.db.query.networkIntegrations.findFirst({
      where: and(
        eq(networkIntegrations.tenantId, tenantId),
        eq(networkIntegrations.kind, "tailscale-oauth"),
      ),
    });
    if (oauth?.status === "connected") return "tailscale-cloud";
    const authkey = await this.db.query.networkIntegrations.findFirst({
      where: and(
        eq(networkIntegrations.tenantId, tenantId),
        eq(networkIntegrations.kind, "tailscale-authkey"),
      ),
    });
    if (authkey?.status === "connected") return "tailscale-cloud";
    return null;
  }

  /** Seed default providers + security policy for a tenant */
  async ensureTenantDefaults(tenantId: string): Promise<void> {
    if (this.defaultsReady.has(tenantId)) return;

    await this.security.ensureDefault(tenantId);
    const existing = await this.db
      .select()
      .from(tunnelProviderSettings)
      .where(eq(tunnelProviderSettings.tenantId, tenantId));
    const have = new Set(existing.map((r) => r.provider));
    const now = new Date();

    for (const provider of TUNNEL_PROVIDER_IDS) {
      if (have.has(provider)) continue;
      const isQuick = provider === "cloudflare-quick";
      await this.db
        .insert(tunnelProviderSettings)
        .values({
          id: newId(),
          tenantId,
          provider,
          enabled: isQuick,
          isDefault: isQuick,
          configEnc: "{}",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }

    // Ensure exactly one default if somehow missing
    const rows = await this.db
      .select()
      .from(tunnelProviderSettings)
      .where(eq(tunnelProviderSettings.tenantId, tenantId));
    if (!rows.some((r) => r.isDefault)) {
      const quick = rows.find((r) => r.provider === "cloudflare-quick") ?? rows[0];
      if (quick) {
        await this.db
          .update(tunnelProviderSettings)
          .set({ isDefault: true, enabled: true, updatedAt: now })
          .where(eq(tunnelProviderSettings.id, quick.id));
      }
    }
    this.defaultsReady.add(tenantId);
  }

  async overview(tenantId: string): Promise<NetworkOverviewDto> {
    await this.ensureTenantDefaults(tenantId);
    const policy = await this.security.get(tenantId);
    const providers = await this.listProviders(tenantId);
    const defaultProvider = providers.find((p) => p.isDefault)?.provider ?? null;
    const platformHs = await this.isPlatformHeadscaleAvailable();

    const meshOauth = await this.db.query.networkIntegrations.findFirst({
      where: and(
        eq(networkIntegrations.tenantId, tenantId),
        eq(networkIntegrations.kind, "tailscale-oauth"),
      ),
    });
    const meshPlatform = await this.db.query.networkIntegrations.findFirst({
      where: and(
        eq(networkIntegrations.tenantId, tenantId),
        eq(networkIntegrations.kind, "headscale-platform"),
      ),
    });
    const meshRow = platformHs
      ? meshPlatform?.status === "connected"
        ? meshPlatform
        : meshPlatform ?? meshOauth
      : meshOauth?.status === "connected"
        ? meshOauth
        : meshPlatform?.status === "connected"
          ? meshPlatform
          : meshOauth;

    // Platform mode: treat as connected when Headscale is configured
    const meshConnected = platformHs ? true : meshRow?.status === "connected";

    const nodes = await this.db
      .select()
      .from(runtimeNodes)
      .where(eq(runtimeNodes.tenantId, tenantId));
    const online = nodes.filter((n) => n.status === "online" || n.kind === "local").length;

    const [activeRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(portExposures)
      .where(
        and(
          eq(portExposures.tenantId, tenantId),
          eq(portExposures.status, "active"),
        ),
      );

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const [todayRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(portExposures)
      .where(
        and(
          eq(portExposures.tenantId, tenantId),
          gte(portExposures.createdAt, startOfDay),
        ),
      );

    const auditEventsToday = await this.audit.countSince(tenantId, startOfDay);

    return {
      mesh: {
        connected: meshConnected,
        displayName: platformHs
          ? (meshRow?.displayName ?? "平台托管网络")
          : (meshRow?.displayName ?? null),
        status: (meshConnected
          ? "connected"
          : ((meshRow?.status as NetworkOverviewDto["mesh"]["status"]) ?? "disconnected")),
      },
      defaultProvider,
      exposureEnabled: policy.exposureEnabled && policy.enabled,
      runners: { online, total: nodes.length },
      activeExposures: activeRow?.count ?? 0,
      exposuresToday: todayRow?.count ?? 0,
      auditEventsToday,
    };
  }

  async listProviders(tenantId: string): Promise<TunnelProviderSettingDto[]> {
    await this.ensureTenantDefaults(tenantId);
    const rows = await this.db
      .select()
      .from(tunnelProviderSettings)
      .where(eq(tunnelProviderSettings.tenantId, tenantId))
      .orderBy(asc(tunnelProviderSettings.createdAt));

    // Stable order matching TUNNEL_PROVIDER_IDS
    const byId = new Map(rows.map((r) => [r.provider, r]));
    return TUNNEL_PROVIDER_IDS.map((id) => {
      const row = byId.get(id);
      if (!row) {
        throw new Error(`Missing provider setting: ${id}`);
      }
      return serializeProviderSetting(row, this.config.secret);
    });
  }

  async getProvider(tenantId: string, provider: string): Promise<TunnelProviderSettingDto | null> {
    await this.ensureTenantDefaults(tenantId);
    if (!isProviderId(provider)) return null;
    const row = await this.db.query.tunnelProviderSettings.findFirst({
      where: and(
        eq(tunnelProviderSettings.tenantId, tenantId),
        eq(tunnelProviderSettings.provider, provider),
      ),
    });
    return row ? serializeProviderSetting(row, this.config.secret) : null;
  }

  async getDefaultProviderId(tenantId: string): Promise<TunnelProviderId> {
    const list = await this.listProviders(tenantId);
    const def = list.find((p) => p.isDefault && p.enabled) ?? list.find((p) => p.enabled);
    return def?.provider ?? "cloudflare-quick";
  }

  async patchProvider(
    tenantId: string,
    provider: string,
    patch: {
      enabled?: boolean;
      isDefault?: boolean;
      config?: Record<string, unknown>;
    },
    opts?: { actorId?: string; ip?: string },
  ): Promise<TunnelProviderSettingDto> {
    if (!isProviderId(provider)) throw new Error(`Unknown provider: ${provider}`);
    await this.ensureTenantDefaults(tenantId);
    const row = await this.db.query.tunnelProviderSettings.findFirst({
      where: and(
        eq(tunnelProviderSettings.tenantId, tenantId),
        eq(tunnelProviderSettings.provider, provider),
      ),
    });
    if (!row) throw new Error("Provider setting not found");

    const now = new Date();
    const set: Partial<TunnelProviderSetting> & { updatedAt: Date } = { updatedAt: now };

    if (typeof patch.enabled === "boolean") set.enabled = patch.enabled;
    if (patch.config && typeof patch.config === "object") {
      const current = parseConfig(row.configEnc, this.config.secret);
      const merged = { ...current };
      for (const [k, v] of Object.entries(patch.config)) {
        if (typeof v === "string" && (v === "••••••••" || v === "")) continue;
        merged[k] = v;
      }
      set.configEnc = encryptJson(this.config.secret, merged);
    }

    if (patch.isDefault === true) {
      await this.db
        .update(tunnelProviderSettings)
        .set({ isDefault: false, updatedAt: now })
        .where(
          and(
            eq(tunnelProviderSettings.tenantId, tenantId),
            ne(tunnelProviderSettings.id, row.id),
          ),
        );
      set.isDefault = true;
      set.enabled = true;
    } else if (patch.isDefault === false) {
      set.isDefault = false;
    }

    const [updated] = await this.db
      .update(tunnelProviderSettings)
      .set(set)
      .where(eq(tunnelProviderSettings.id, row.id))
      .returning();

    await this.audit.append(tenantId, "provider.config.update", {
      actor: { type: "user", id: opts?.actorId, ip: opts?.ip },
      targetType: "tunnel_provider",
      targetId: provider,
      detail: {
        enabled: patch.enabled,
        isDefault: patch.isDefault,
        configKeys: patch.config ? Object.keys(patch.config) : undefined,
      },
    });

    return serializeProviderSetting(updated, this.config.secret);
  }

  async testProvider(
    tenantId: string,
    provider: string,
    opts?: { actorId?: string; ip?: string },
  ): Promise<{ ok: boolean; message: string; publicUrl?: string }> {
    if (!isProviderId(provider)) throw new Error(`Unknown provider: ${provider}`);
    await this.ensureTenantDefaults(tenantId);
    const row = await this.db.query.tunnelProviderSettings.findFirst({
      where: and(
        eq(tunnelProviderSettings.tenantId, tenantId),
        eq(tunnelProviderSettings.provider, provider),
      ),
    });
    if (!row) throw new Error("Provider setting not found");

    const now = new Date();
    let result: { ok: boolean; message: string; publicUrl?: string };

    try {
      if (provider === "cloudflare-quick") {
        // Probe: tunnel to a tiny local HTTP that we don't need; use example.com via... no,
        // Quick tunnel needs a real local target. Spin a tiny listener.
        const { createServer } = await import("node:http");
        const probe = await new Promise<{ port: number; close: () => void }>((resolve, reject) => {
          const server = createServer((_req, res) => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("Zakura tunnel probe");
          });
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            if (!addr || typeof addr === "string") {
              reject(new Error("probe bind failed"));
              return;
            }
            resolve({
              port: addr.port,
              close: () => {
                try {
                  server.close();
                } catch {
                  /* ignore */
                }
              },
            });
          });
        });

        try {
          const handle = await startCloudflareQuickTunnel(`http://127.0.0.1:${probe.port}`, {
            timeoutMs: 40_000,
          });
          result = {
            ok: true,
            message: "探针隧道就绪",
            publicUrl: handle.publicUrl,
          };
          // Auto-close after brief window
          setTimeout(() => {
            void handle.stop();
            probe.close();
          }, 10_000);
        } catch (err) {
          probe.close();
          throw err;
        }
      } else if (provider === "cloudflare-named") {
        const cfg = parseConfig(row.configEnc, this.config.secret);
        const tunnelToken = String(cfg.tunnelToken ?? cfg.token ?? "");
        const apiToken = String(cfg.apiToken ?? "");
        const accountId = String(cfg.accountId ?? "");

        if (apiToken && accountId) {
          const cf = new CloudflareAdminClient({ apiToken, accountId });
          const probe = await cf.probe();
          result = {
            ok: true,
            message: `API Token 有效 · Account ${accountId.slice(0, 8)}… · ${probe.tunnelCount} 个隧道`,
          };
        } else if (tunnelToken) {
          result = {
            ok: true,
            message: "Tunnel Token 已保存（运行时 cloudflared tunnel run 尚未接线）",
          };
        } else {
          throw new Error("请配置 API Token + Account ID，或直接粘贴 Tunnel Token");
        }
      } else if (provider === "ngrok") {
        const cfg = parseConfig(row.configEnc, this.config.secret);
        const token = String(cfg.authtoken ?? cfg.authToken ?? "");
        if (!token) throw new Error("请先配置 Authtoken");
        result = { ok: true, message: "Authtoken 已配置（连通性探测尚未接线）" };
      } else if (provider === "frp") {
        const cfg = parseConfig(row.configEnc, this.config.secret);
        if (!cfg.server) throw new Error("请先配置 frp Server");
        result = { ok: true, message: "frp 配置已校验（连通性探测尚未接线）" };
      } else if (provider === "tailscale-serve") {
        const probe = await probeTailscaleBackend();
        if (!probe.ok) throw new Error(probe.message);
        result = { ok: true, message: probe.message };
      } else {
        result = { ok: false, message: "未实现" };
      }

      await this.db
        .update(tunnelProviderSettings)
        .set({
          lastTestAt: now,
          lastTestOk: result.ok,
          lastError: result.ok ? null : result.message,
          updatedAt: now,
        })
        .where(eq(tunnelProviderSettings.id, row.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .update(tunnelProviderSettings)
        .set({
          lastTestAt: now,
          lastTestOk: false,
          lastError: message,
          updatedAt: now,
        })
        .where(eq(tunnelProviderSettings.id, row.id));
      result = { ok: false, message };
    }

    await this.audit.append(tenantId, "provider.test", {
      actor: { type: "user", id: opts?.actorId, ip: opts?.ip },
      targetType: "tunnel_provider",
      targetId: provider,
      detail: result,
    });

    return result;
  }

  /** Mesh status for settings UI. Read-only by default; pass refresh to hit Headscale/Tailscale. */
  async getMesh(tenantId: string, opts?: { refresh?: boolean }) {
    const t0 = performance.now();
    await this.ensureTenantDefaults(tenantId);
    const tDefaults = performance.now();

    // Platform Headscale: auto-provision once; skip repeat Headscale calls while fresh/connected
    if (await this.isPlatformHeadscaleAvailable()) {
      if (opts?.refresh) {
        try {
          await this.enablePlatformMesh(tenantId, { refreshDevices: true });
        } catch (err) {
          console.warn(
            "[mesh] auto ensure platform failed:",
            err instanceof Error ? err.message : err,
          );
        }
      } else if (!this.isMeshFresh(tenantId)) {
        const platform = await this.loadPlatformIntegration(tenantId);
        if (platform?.status !== "connected") {
          try {
            await this.enablePlatformMesh(tenantId, { refreshDevices: false });
          } catch (err) {
            console.warn(
              "[mesh] auto ensure platform failed:",
              err instanceof Error ? err.message : err,
            );
          }
        } else {
          this.markMeshFresh(tenantId);
        }
      }
    }
    const tEnable = performance.now();
    const payload = await this.buildMeshPayload(tenantId);
    const total = performance.now() - t0;
    if (total >= 200) {
      console.warn(
        `[mesh] getMesh ${total.toFixed(0)}ms (defaults=${(tDefaults - t0).toFixed(0)} enable=${(tEnable - tDefaults).toFixed(0)} payload=${(performance.now() - tEnable).toFixed(0)} refresh=${Boolean(opts?.refresh)})`,
      );
    }
    return payload;
  }

  private async buildMeshPayload(tenantId: string) {
    const oauth = await this.db.query.networkIntegrations.findFirst({
      where: and(
        eq(networkIntegrations.tenantId, tenantId),
        eq(networkIntegrations.kind, "tailscale-oauth"),
      ),
    });
    const authkey = await this.db.query.networkIntegrations.findFirst({
      where: and(
        eq(networkIntegrations.tenantId, tenantId),
        eq(networkIntegrations.kind, "tailscale-authkey"),
      ),
    });
    const platform = await this.loadPlatformIntegration(tenantId);
    const hs = await this.getPlatformHeadscale();
    const platformMode = hs.enabled;

    let meta: Record<string, unknown> = {};
    const metaSource = platformMode
      ? platform
      : oauth?.status === "connected"
        ? oauth
        : platform ?? oauth;
    if (metaSource?.metaJson) {
      try {
        meta = JSON.parse(metaSource.metaJson) as Record<string, unknown>;
      } catch {
        /* ignore */
      }
    }

    const nodes = await this.db
      .select()
      .from(runtimeNodes)
      .where(eq(runtimeNodes.tenantId, tenantId))
      .orderBy(asc(runtimeNodes.createdAt));

    const devices = nodes.map((n) => {
      let hostInfo: Record<string, unknown> = {};
      try {
        hostInfo = JSON.parse(n.hostInfoJson) as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      const ts = hostInfo.tailscale as
        | { connected?: boolean; ip?: string; magicDnsName?: string; hostname?: string; tags?: string[] }
        | undefined;
      return {
        id: n.id,
        name: n.name,
        slug: n.slug,
        kind: n.kind,
        status: n.status,
        endpoint: n.endpoint,
        tailscale: ts
          ? {
              connected: Boolean(ts.connected),
              ip: ts.ip ?? null,
              magicDnsName: ts.magicDnsName ?? null,
              hostname: ts.hostname ?? null,
              tags: ts.tags ?? [],
            }
          : null,
      };
    });

    const tailnetDevices = Array.isArray(meta.devices)
      ? (meta.devices as TailscaleDevice[])
      : [];

    const meshProvider = await this.resolveMeshProvider(tenantId);
    const platformConnected = platformMode && platform?.status === "connected";
    const cloudConnected =
      !platformMode &&
      (oauth?.status === "connected" || authkey?.status === "connected");
    const connected = platformConnected || cloudConnected;

    return {
      connected,
      meshProvider: platformMode ? ("headscale-platform" as const) : meshProvider,
      loginServer: platformMode ? hs.url : null,
      headscaleUser: platformMode
        ? typeof meta.headscaleUser === "string"
          ? meta.headscaleUser
          : headscaleTenantUserName(tenantId)
        : null,
      oauth: platformMode
        ? null
        : oauth
          ? {
              status: oauth.status,
              displayName: oauth.displayName,
              lastSyncAt: oauth.lastSyncAt?.toISOString() ?? null,
              lastError: oauth.lastError,
              tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
              deviceCount:
                typeof meta.deviceCount === "number" ? meta.deviceCount : tailnetDevices.length,
              createClientUrl: "https://login.tailscale.com/admin/settings/oauth",
            }
          : {
              status: "disconnected" as const,
              displayName: null,
              lastSyncAt: null,
              lastError: null,
              tags: [] as string[],
              deviceCount: 0,
              createClientUrl: "https://login.tailscale.com/admin/settings/oauth",
            },
      platform: platformMode
        ? {
            status: platform?.status ?? "error",
            displayName: platform?.displayName ?? "Headscale",
            lastSyncAt: platform?.lastSyncAt?.toISOString() ?? null,
            lastError: platform?.lastError ?? null,
            deviceCount:
              typeof meta.deviceCount === "number" ? meta.deviceCount : tailnetDevices.length,
            headscaleUser:
              typeof meta.headscaleUser === "string"
                ? meta.headscaleUser
                : headscaleTenantUserName(tenantId),
          }
        : null,
      hasAuthKey: Boolean(authkey && authkey.status !== "disconnected"),
      devices,
      tailnetDevices,
      hostJoinsTailscale: await this.hostJoinsTailscaleForTenant(
        platformMode ? "headscale-platform" : meshProvider,
      ),
      note: platformMode
        ? "平台托管网络：主节点已入网，本租户设备仅能互访。注册 Runner 时自动加入。"
        : "Tailscale 云组网：使用 OAuth Client Credentials；Runner 通过 sidecar 入网。",
    };
  }

  /**
   * Ensure platform Headscale is provisioned for this tenant (idempotent).
   * Clears any leftover cloud OAuth integration — modes are mutually exclusive.
   */
  async ensurePlatformMesh(
    tenantId: string,
    opts?: { actorId?: string; ip?: string; refreshDevices?: boolean },
  ) {
    return this.enablePlatformMesh(tenantId, opts);
  }

  /**
   * Enable / refresh platform-managed Headscale mesh for a tenant.
   * When already connected and refreshDevices is false, returns DB payload without Headscale HTTP.
   */
  async enablePlatformMesh(
    tenantId: string,
    opts?: { actorId?: string; ip?: string; refreshDevices?: boolean },
  ) {
    const hs = await this.getPlatformHeadscale();
    if (!hs.enabled) {
      throw new Error(
        "平台未配置 Headscale。请在 SaaS 超管后台填写 URL / API Key，并部署 docker/headscale。",
      );
    }
    const client = (await this.getHeadscaleClient())!;

    // Platform mode wins: disconnect cloud integrations if any
    const nowClear = new Date();
    await this.db
      .update(networkIntegrations)
      .set({ status: "disconnected", updatedAt: nowClear, lastError: null })
      .where(
        and(
          eq(networkIntegrations.tenantId, tenantId),
          sql`${networkIntegrations.kind} in ('tailscale-oauth', 'tailscale-authkey')`,
          sql`${networkIntegrations.status} != 'disconnected'`,
        ),
      );

    const existing = await this.loadPlatformIntegration(tenantId);
    // Fast path: already connected — skip Headscale unless explicit refresh
    if (existing?.status === "connected") {
      if (opts?.refreshDevices) {
        try {
          const user = await client.ensureTenantUser(tenantId);
          const nodes = await client.listTenantNodes(tenantId);
          const devices = nodes.map((n) => this.headscaleNodeToDevice(n));
          let prevMeta: Record<string, unknown> = {};
          try {
            prevMeta = JSON.parse(existing.metaJson ?? "{}") as Record<string, unknown>;
          } catch {
            /* ignore */
          }
          const now = new Date();
          await this.db
            .update(networkIntegrations)
            .set({
              lastSyncAt: now,
              lastError: null,
              metaJson: JSON.stringify({
                ...prevMeta,
                headscaleUser: user.name,
                headscaleUserId: user.id,
                deviceCount: devices.length,
                devices,
                loginServer: hs.url,
              }),
              updatedAt: now,
            })
            .where(eq(networkIntegrations.id, existing.id));
        } catch {
          /* keep existing row */
        }
      }
      this.markMeshFresh(tenantId);
      return this.buildMeshPayload(tenantId);
    }

    const user = await client.ensureTenantUser(tenantId);
    await client.ensurePlatformUser();

    // Best-effort: join host as tag:platform
    let hostIp: string | null = null;
    try {
      let platformKey = hs.platformAuthKey;
      if (!platformKey) {
        const minted = await client.createPlatformPreAuthKey({ reusable: true });
        platformKey = minted.key;
        await persistPlatformAuthKey(this.db, this.config.secret, platformKey);
        await this.refreshPlatformHeadscale();
      }
      hostIp = await this.hostTailscale.ensurePlatformHost({
        authKey: platformKey,
        loginServer: hs.url,
      });
    } catch (err) {
      console.warn(
        "[mesh] platform host join failed:",
        err instanceof Error ? err.message : err,
      );
    }

    let devices: TailscaleDevice[] = [];
    try {
      const nodes = await client.listTenantNodes(tenantId);
      devices = nodes.map((n) => this.headscaleNodeToDevice(n));
    } catch {
      /* ignore */
    }

    const now = new Date();
    const metaJson = JSON.stringify({
      headscaleUser: user.name,
      headscaleUserId: user.id,
      deviceCount: devices.length,
      devices,
      hostIp,
      loginServer: hs.url,
    });
    if (existing) {
      await this.db
        .update(networkIntegrations)
        .set({
          status: "connected",
          displayName: `Headscale · ${user.name}`,
          credentialsEnc: encryptJson(this.config.secret, {
            headscaleUser: user.name,
            headscaleUserId: user.id,
          }),
          metaJson,
          lastSyncAt: now,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(networkIntegrations.id, existing.id));
    } else {
      await this.db.insert(networkIntegrations).values({
        id: newId(),
        tenantId,
        kind: "headscale-platform",
        status: "connected",
        displayName: `Headscale · ${user.name}`,
        credentialsEnc: encryptJson(this.config.secret, {
          headscaleUser: user.name,
          headscaleUserId: user.id,
        }),
        metaJson,
        lastSyncAt: now,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    await this.audit.append(tenantId, "mesh.platform.enable", {
      actor: { type: "user", id: opts?.actorId, ip: opts?.ip },
      targetType: "network_integration",
      detail: {
        kind: "headscale-platform",
        headscaleUser: user.name,
        hostIp,
        auto: true,
      },
    });

    this.markMeshFresh(tenantId);
    return this.buildMeshPayload(tenantId);
  }

  private headscaleNodeToDevice(n: HeadscaleNode): TailscaleDevice {
    return {
      id: n.id,
      name: n.name,
      hostname: n.hostname,
      addresses: n.addresses,
      tags: n.tags,
      online: n.online,
      user: n.user,
      os: n.os,
      lastSeen: n.lastSeen,
    };
  }

  async syncHeadscale(
    tenantId: string,
    opts?: { actorId?: string; ip?: string },
  ) {
    const platform = await this.loadPlatformIntegration(tenantId);
    if (!platform || platform.status !== "connected") {
      throw new Error("尚未启用平台托管 Headscale");
    }
    const client = await this.getHeadscaleClient();
    if (!client) throw new Error("平台未配置 Headscale");

    try {
      const user = await client.ensureTenantUser(tenantId);
      const nodes = await client.listTenantNodes(tenantId);
      const devices = nodes.map((n) => this.headscaleNodeToDevice(n));
      let prevMeta: Record<string, unknown> = {};
      try {
        prevMeta = JSON.parse(platform.metaJson ?? "{}") as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      const hs = await this.getPlatformHeadscale();
      const now = new Date();
      await this.db
        .update(networkIntegrations)
        .set({
          status: "connected",
          lastSyncAt: now,
          lastError: null,
          metaJson: JSON.stringify({
            ...prevMeta,
            headscaleUser: user.name,
            headscaleUserId: user.id,
            deviceCount: devices.length,
            devices,
            loginServer: hs.url,
          }),
          updatedAt: now,
        })
        .where(eq(networkIntegrations.id, platform.id));

      await this.audit.append(tenantId, "mesh.sync", {
        actor: { type: "user", id: opts?.actorId, ip: opts?.ip },
        targetType: "network_integration",
        targetId: platform.id,
        detail: { provider: "headscale-platform", deviceCount: devices.length },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .update(networkIntegrations)
        .set({ status: "error", lastError: message, updatedAt: new Date() })
        .where(eq(networkIntegrations.id, platform.id));
      throw new Error(message);
    }
    return this.getMesh(tenantId, { refresh: true });
  }

  private async loadTailscaleClient(tenantId: string): Promise<{
    client: TailscaleAdminClient;
    rowId: string;
  }> {
    const row = await this.db.query.networkIntegrations.findFirst({
      where: and(
        eq(networkIntegrations.tenantId, tenantId),
        eq(networkIntegrations.kind, "tailscale-oauth"),
      ),
    });
    if (!row || row.status !== "connected") {
      throw new Error("尚未连接 Tailscale OAuth Client");
    }
    const creds = decryptJson<TailscaleOAuthCredentials>(
      this.config.secret,
      row.credentialsEnc,
    );
    if (!creds.clientId || !creds.clientSecret) {
      throw new Error("Tailscale OAuth 凭证不完整");
    }
    return { client: new TailscaleAdminClient(creds), rowId: row.id };
  }

  private async persistTailscaleCreds(
    tenantId: string,
    creds: TailscaleOAuthCredentials,
    patch: {
      status: string;
      displayName: string | null;
      lastError: string | null;
      meta: Record<string, unknown>;
    },
  ) {
    const now = new Date();
    const credentialsEnc = encryptJson(this.config.secret, creds);
    const metaJson = JSON.stringify(patch.meta);
    const existing = await this.db.query.networkIntegrations.findFirst({
      where: and(
        eq(networkIntegrations.tenantId, tenantId),
        eq(networkIntegrations.kind, "tailscale-oauth"),
      ),
    });
    if (existing) {
      await this.db
        .update(networkIntegrations)
        .set({
          status: patch.status,
          displayName: patch.displayName,
          credentialsEnc,
          metaJson,
          lastSyncAt: now,
          lastError: patch.lastError,
          updatedAt: now,
        })
        .where(eq(networkIntegrations.id, existing.id));
      return existing.id;
    }
    const [row] = await this.db
      .insert(networkIntegrations)
      .values({
        id: newId(),
        tenantId,
        kind: "tailscale-oauth",
        status: patch.status,
        displayName: patch.displayName,
        credentialsEnc,
        metaJson,
        lastSyncAt: now,
        lastError: patch.lastError,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row.id;
  }

  /**
   * Connect Tailscale via OAuth Client ID + Secret (client_credentials).
   */
  async connectTailscaleOAuth(
    tenantId: string,
    input: { clientId: string; clientSecret: string; tags?: string[] },
    opts?: { actorId?: string; ip?: string },
  ) {
    if (await this.isPlatformHeadscaleAvailable()) {
      throw new Error("当前部署为平台托管网络，无需也不支持连接 Tailscale 云。");
    }

    const clientId = input.clientId.trim();
    const clientSecret = input.clientSecret.trim();
    if (!clientId) throw new Error("Client ID 不能为空");
    if (!clientSecret) throw new Error("Client Secret 不能为空");

    const tags = normalizeTailscaleTags(input.tags);
    if (!tags.length) {
      throw new Error(
        [
          "必须填写 Tags，且须与 OAuth Client 上勾选的 tag 完全一致。",
          "先在 ACL tagOwners 定义 tag，再创建带该 tag 的 OAuth Client（auth_keys / devices）。",
          "示例：若 Client 勾选了 tag:ci，此处也填 tag:ci — 不要填未定义的 tag:zakura-runner。",
        ].join(""),
      );
    }

    const client = new TailscaleAdminClient({
      clientId,
      clientSecret,
      tags,
    });

    try {
      // Probe without requesting tags — they may not exist in ACL yet.
      await client.ensureAccessToken({ omitTags: true });
      const probe = await client.probe({ omitTags: true });
      const devices = await client.listDevices({ omitTags: true });
      await this.persistTailscaleCreds(tenantId, client.credentials, {
        status: "connected",
        displayName: probe.displayName,
        lastError: null,
        meta: {
          tags: client.credentials.tags ?? [],
          deviceCount: probe.deviceCount,
          devices,
        },
      });

      // Auto-create missing tags in ACL tagOwners (best-effort)
      let aclEnsure: Awaited<ReturnType<TailscaleAdminClient["ensureTagsInAcl"]>> | null =
        null;
      let aclEnsureError: string | null = null;
      try {
        aclEnsure = await client.ensureTagsInAcl(tags);
      } catch (aclErr) {
        aclEnsureError = aclErr instanceof Error ? aclErr.message : String(aclErr);
      }

      await this.audit.append(tenantId, "mesh.oauth.connect", {
        actor: { type: "user", id: opts?.actorId, ip: opts?.ip },
        targetType: "network_integration",
        detail: {
          kind: "tailscale-oauth",
          displayName: probe.displayName,
          deviceCount: probe.deviceCount,
          aclEnsure,
          aclEnsureError,
        },
      });

      const mesh = await this.getMesh(tenantId);
      return {
        ...mesh,
        ...(aclEnsure ? { aclEnsure } : {}),
        ...(aclEnsureError ? { aclEnsureError } : {}),
        note: aclEnsureError
          ? `OAuth 已连接，但自动写入 ACL 失败：${aclEnsureError}。请确认 OAuth Client 勾选 Policy file → Write，或手动「在 ACL 中创建 Tags」。`
          : aclEnsure?.added.length
            ? `OAuth 已连接，已在 ACL 创建：${aclEnsure.added.join(", ")}`
            : "OAuth 已连接",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.persistTailscaleCreds(tenantId, client.credentials, {
        status: "error",
        displayName: null,
        lastError: message,
        meta: { tags: client.credentials.tags ?? [] },
      });
      throw new Error(message);
    }
  }

  /** Refresh device list via Tailscale cloud API or Headscale. */
  async syncTailscale(
    tenantId: string,
    opts?: { actorId?: string; ip?: string },
  ) {
    const provider = await this.resolveMeshProvider(tenantId);
    if (provider === "headscale-platform") {
      return this.syncHeadscale(tenantId, opts);
    }

    const { client, rowId } = await this.loadTailscaleClient(tenantId);
    try {
      await client.ensureAccessToken();
      const probe = await client.probe();
      const devices = await client.listDevices();
      await this.persistTailscaleCreds(tenantId, client.credentials, {
        status: "connected",
        displayName: probe.displayName,
        lastError: null,
        meta: {
          tags: client.credentials.tags ?? [],
          deviceCount: probe.deviceCount,
          devices,
        },
      });
      await this.audit.append(tenantId, "mesh.sync", {
        actor: { type: "user", id: opts?.actorId, ip: opts?.ip },
        targetType: "network_integration",
        targetId: rowId,
        detail: { deviceCount: probe.deviceCount },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const row = await this.db.query.networkIntegrations.findFirst({
        where: eq(networkIntegrations.id, rowId),
      });
      if (row) {
        await this.db
          .update(networkIntegrations)
          .set({ status: "error", lastError: message, updatedAt: new Date() })
          .where(eq(networkIntegrations.id, rowId));
      }
      throw new Error(message);
    }
    return this.getMesh(tenantId);
  }

  /**
   * Update stored tags for an existing OAuth connection (must match OAuth client).
   */
  async updateTailscaleTags(
    tenantId: string,
    tagsInput: string[],
    opts?: { actorId?: string; ip?: string },
  ) {
    const tags = normalizeTailscaleTags(tagsInput);
    if (!tags.length) throw new Error("Tags 不能为空");

    const { client, rowId } = await this.loadTailscaleClient(tenantId);
    client.setTags(tags);

    try {
      await client.ensureAccessToken();
      const probe = await client.probe();
      const devices = await client.listDevices();
      const existing = await this.db.query.networkIntegrations.findFirst({
        where: eq(networkIntegrations.id, rowId),
      });
      let prevMeta: Record<string, unknown> = {};
      try {
        prevMeta = JSON.parse(existing?.metaJson ?? "{}") as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      await this.persistTailscaleCreds(tenantId, client.credentials, {
        status: "connected",
        displayName: existing?.displayName ?? probe.displayName,
        lastError: null,
        meta: {
          ...prevMeta,
          tags,
          deviceCount: probe.deviceCount,
          devices,
        },
      });
      await this.audit.append(tenantId, "mesh.oauth.connect", {
        actor: { type: "user", id: opts?.actorId, ip: opts?.ip },
        targetType: "network_integration",
        targetId: rowId,
        detail: { action: "update_tags", tags },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(message);
    }
    return this.getMesh(tenantId);
  }

  /**
   * Merge missing tags into Tailscale ACL tagOwners (requires Policy file write scope).
   */
  async ensureTailscaleTagsInAcl(
    tenantId: string,
    tagsInput?: string[],
    opts?: { actorId?: string; ip?: string },
  ) {
    const { client, rowId } = await this.loadTailscaleClient(tenantId);
    const tags = normalizeTailscaleTags(
      tagsInput?.length ? tagsInput : client.credentials.tags,
    );
    if (!tags.length) {
      throw new Error("请先填写要写入 ACL 的 Tags（例如 tag:zakura-runner）");
    }

    const result = await client.ensureTagsInAcl(tags);
    await this.audit.append(tenantId, "mesh.acl.ensure_tags", {
      actor: { type: "user", id: opts?.actorId, ip: opts?.ip },
      targetType: "network_integration",
      targetId: rowId,
      detail: result,
    });

    const mesh = await this.getMesh(tenantId);
    return { ...mesh, aclEnsure: result };
  }

  /**
   * Create a Runner auth key via Tailscale cloud API or Headscale preauth.
   */
  async generateTailscaleAuthKey(
    tenantId: string,
    opts?: {
      tags?: string[];
      expirySeconds?: number;
      description?: string;
      actorId?: string;
      ip?: string;
      /** Skip auto ACL write (default false = auto-create missing tags) */
      skipAclEnsure?: boolean;
    },
  ) {
    const provider = await this.resolveMeshProvider(tenantId);
    if (provider === "headscale-platform") {
      return this.generateHeadscalePreAuthKey(tenantId, opts);
    }

    const { client } = await this.loadTailscaleClient(tenantId);
    const tags = normalizeTailscaleTags(
      opts?.tags?.length ? opts.tags : client.credentials.tags,
    );
    if (!tags.length) {
      throw new Error(
        "尚未配置 Tags。请先在连接时填写与 OAuth Client 一致的 tag，或调用更新 Tags。",
      );
    }
    // Keep credentials + token request aligned
    client.setTags(tags);

    // Auto-create missing tags in ACL before minting keys
    if (!opts?.skipAclEnsure) {
      try {
        await client.ensureTagsInAcl(tags);
      } catch (aclErr) {
        // Continue — auth key may still succeed if tags already exist;
        // if not, createAuthKey error will mention Client checkbox.
        void aclErr;
      }
    }

    const created = await client.createAuthKey({
      tags,
      expirySeconds: opts?.expirySeconds,
      description: opts?.description ?? "Zakura runner",
      reusable: true,
      ephemeral: false,
      preauthorized: true,
    });

    const existingOauth = await this.db.query.networkIntegrations.findFirst({
      where: and(
        eq(networkIntegrations.tenantId, tenantId),
        eq(networkIntegrations.kind, "tailscale-oauth"),
      ),
    });
    let prevMeta: Record<string, unknown> = {};
    try {
      prevMeta = JSON.parse(existingOauth?.metaJson ?? "{}") as Record<string, unknown>;
    } catch {
      /* ignore */
    }

    await this.persistTailscaleCreds(tenantId, client.credentials, {
      status: "connected",
      displayName: existingOauth?.displayName ?? null,
      lastError: null,
      meta: {
        ...prevMeta,
        tags: client.credentials.tags ?? prevMeta.tags ?? [],
        lastAuthKeyId: created.id,
        lastAuthKeyExpires: created.expires ?? null,
      },
    });

    await this.saveManualAuthKey(tenantId, created.key, {
      actorId: opts?.actorId,
      ip: opts?.ip,
      skipAudit: true,
      displayName: "OAuth API Auth Key",
    });

    await this.audit.append(tenantId, "mesh.auth_key.create", {
      actor: { type: "user", id: opts?.actorId, ip: opts?.ip },
      targetType: "network_integration",
      detail: {
        kind: "tailscale-authkey",
        via: "oauth-api",
        keyId: created.id,
        tags: created.tags,
        expires: created.expires,
      },
    });

    const mesh = await this.getMesh(tenantId);
    return {
      ...mesh,
      generatedKey: created.key,
      generatedKeyId: created.id,
      generatedKeyExpires: created.expires ?? null,
      generatedKeyTags: created.tags,
    };
  }

  async generateHeadscalePreAuthKey(
    tenantId: string,
    opts?: {
      expirySeconds?: number;
      description?: string;
      actorId?: string;
      ip?: string;
    },
  ) {
    const client = await this.getHeadscaleClient();
    if (!client) throw new Error("平台未配置 Headscale");
    const platform = await this.loadPlatformIntegration(tenantId);
    if (!platform || platform.status !== "connected") {
      throw new Error("请先启用平台托管组网");
    }

    const created = await client.createTenantPreAuthKey(tenantId, {
      reusable: true,
      ephemeral: false,
      expirySeconds: opts?.expirySeconds,
    });

    await this.saveManualAuthKey(tenantId, created.key, {
      actorId: opts?.actorId,
      ip: opts?.ip,
      skipAudit: true,
      displayName: opts?.description ?? "Headscale PreAuth Key",
    });

    await this.audit.append(tenantId, "mesh.auth_key.create", {
      actor: { type: "user", id: opts?.actorId, ip: opts?.ip },
      targetType: "network_integration",
      detail: {
        kind: "headscale-platform",
        via: "headscale-api",
        keyId: created.id,
        expires: created.expiration,
      },
    });

    const mesh = await this.getMesh(tenantId);
    return {
      ...mesh,
      generatedKey: created.key,
      generatedKeyId: created.id,
      generatedKeyExpires: created.expiration ?? null,
      generatedKeyTags: [] as string[],
    };
  }

  async saveManualAuthKey(
    tenantId: string,
    authKey: string,
    opts?: {
      actorId?: string;
      ip?: string;
      skipAudit?: boolean;
      displayName?: string;
    },
  ) {
    const key = authKey.trim();
    if (!key) throw new Error("Auth Key 不能为空");
    const now = new Date();
    const existing = await this.db.query.networkIntegrations.findFirst({
      where: and(
        eq(networkIntegrations.tenantId, tenantId),
        eq(networkIntegrations.kind, "tailscale-authkey"),
      ),
    });
    const credentialsEnc = encryptJson(this.config.secret, { authKey: key });
    const displayName = opts?.displayName ?? "Manual Auth Key";
    if (existing) {
      await this.db
        .update(networkIntegrations)
        .set({
          status: "connected",
          credentialsEnc,
          displayName,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(networkIntegrations.id, existing.id));
    } else {
      await this.db.insert(networkIntegrations).values({
        id: newId(),
        tenantId,
        kind: "tailscale-authkey",
        status: "connected",
        displayName,
        credentialsEnc,
        metaJson: "{}",
        createdAt: now,
        updatedAt: now,
      });
    }

    if (!opts?.skipAudit) {
      await this.audit.append(tenantId, "mesh.auth_key.create", {
        actor: { type: "user", id: opts?.actorId, ip: opts?.ip },
        targetType: "network_integration",
        detail: { kind: "tailscale-authkey", manual: true },
      });
    }

    return this.getMesh(tenantId);
  }

  /**
   * Create a Cloudflare Named Tunnel via API Token and store tunnel token on the provider.
   */
  async createCloudflareNamedTunnel(
    tenantId: string,
    input: { name?: string },
    opts?: { actorId?: string; ip?: string },
  ) {
    await this.ensureTenantDefaults(tenantId);
    const row = await this.db.query.tunnelProviderSettings.findFirst({
      where: and(
        eq(tunnelProviderSettings.tenantId, tenantId),
        eq(tunnelProviderSettings.provider, "cloudflare-named"),
      ),
    });
    if (!row) throw new Error("cloudflare-named provider not found");

    const cfg = parseConfig(row.configEnc, this.config.secret);
    const apiToken = String(cfg.apiToken ?? "");
    const accountId = String(cfg.accountId ?? "");
    if (!apiToken || !accountId) {
      throw new Error("请先保存 Cloudflare API Token 与 Account ID");
    }

    const name =
      input.name?.trim() ||
      `zakura-${tenantId.slice(0, 8)}-${Date.now().toString(36)}`;

    const cf = new CloudflareAdminClient({ apiToken, accountId });
    const created = await cf.createTunnel(name);

    const merged = {
      ...cfg,
      apiToken,
      accountId,
      tunnelId: created.id,
      tunnelName: created.name,
      tunnelToken: created.token,
    };

    const now = new Date();
    await this.db
      .update(tunnelProviderSettings)
      .set({
        configEnc: encryptJson(this.config.secret, merged),
        enabled: true,
        lastTestAt: now,
        lastTestOk: true,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(tunnelProviderSettings.id, row.id));

    // Also mirror under network_integrations for audit / discovery
    const existing = await this.db.query.networkIntegrations.findFirst({
      where: and(
        eq(networkIntegrations.tenantId, tenantId),
        eq(networkIntegrations.kind, "cloudflare-named"),
      ),
    });
    const credentialsEnc = encryptJson(this.config.secret, {
      apiToken,
      accountId,
      tunnelId: created.id,
      tunnelToken: created.token,
    });
    if (existing) {
      await this.db
        .update(networkIntegrations)
        .set({
          status: "connected",
          displayName: created.name,
          credentialsEnc,
          metaJson: JSON.stringify({ tunnelId: created.id, tunnelName: created.name }),
          lastSyncAt: now,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(networkIntegrations.id, existing.id));
    } else {
      await this.db.insert(networkIntegrations).values({
        id: newId(),
        tenantId,
        kind: "cloudflare-named",
        status: "connected",
        displayName: created.name,
        credentialsEnc,
        metaJson: JSON.stringify({ tunnelId: created.id, tunnelName: created.name }),
        lastSyncAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    await this.audit.append(tenantId, "provider.config.update", {
      actor: { type: "user", id: opts?.actorId, ip: opts?.ip },
      targetType: "tunnel_provider",
      targetId: "cloudflare-named",
      detail: { action: "create_tunnel", tunnelId: created.id, name: created.name },
    });

    return {
      tunnelId: created.id,
      tunnelName: created.name,
      hasToken: Boolean(created.token),
      provider: serializeProviderSetting(
        (
          await this.db.query.tunnelProviderSettings.findFirst({
            where: eq(tunnelProviderSettings.id, row.id),
          })
        )!,
        this.config.secret,
      ),
    };
  }

  async disconnectMesh(
    tenantId: string,
    opts?: { actorId?: string; ip?: string },
  ) {
    if (await this.isPlatformHeadscaleAvailable()) {
      throw new Error("平台托管网络由部署配置决定，不能在控制台断开。");
    }
    const now = new Date();
    await this.db
      .update(networkIntegrations)
      .set({ status: "disconnected", updatedAt: now, lastError: null })
      .where(
        and(
          eq(networkIntegrations.tenantId, tenantId),
          sql`${networkIntegrations.kind} in ('tailscale-oauth', 'tailscale-authkey')`,
        ),
      );
    await this.audit.append(tenantId, "mesh.disconnect", {
      actor: { type: "user", id: opts?.actorId, ip: opts?.ip },
    });
    this.invalidateMeshCache(tenantId);
    return this.getMesh(tenantId);
  }

  /** Returns a docker compose snippet: Tailscale sidecar + Runner (shared netns). */
  async runnerJoinHint(tenantId: string): Promise<{
    command: string;
    hasKey: boolean;
    mode: "tailscale-sidecar";
  }> {
    try {
      const pack = await this.buildRunnerInstallPackage(tenantId, {
        token: "rnr_REPLACE_ME",
        slug: "runner",
        enableTailscale: true,
        mintAuthKeyIfMissing: false,
      });
      return {
        command: pack.compose,
        hasKey: pack.hasAuthKey,
        mode: "tailscale-sidecar" as const,
      };
    } catch {
      const command = buildRunnerComposeSnippet({
        token: "rnr_...",
        serverUrl: this.config.publicBaseUrl,
        slug: "runner",
        enableTailscale: false,
      });
      return { command, hasKey: false, mode: "tailscale-sidecar" as const };
    }
  }

  /**
   * Build a single-file install package for a Runner (secrets embedded).
   * When enableTailscale: auto hostname zakura-{slug}, reuse/mint auth key.
   * Platform Headscale: no advertise-tags + --login-server.
   */
  async buildRunnerInstallPackage(
    tenantId: string,
    opts: {
      token: string;
      slug: string;
      enableTailscale: boolean;
      /** Generate + store auth key via OAuth / Headscale when none saved yet */
      mintAuthKeyIfMissing?: boolean;
      actorId?: string;
    },
  ): Promise<
    RunnerInstallPackage & {
      hasAuthKey: boolean;
      meshConnected: boolean;
      tags: string[];
      loginServer: string | null;
      meshProvider: MeshProviderId | null;
    }
  > {
    const t0 = performance.now();
    let tEnable = t0;
    let tKey = t0;
    let tHost = t0;
    // Only provision if not yet connected; do not refresh Headscale on every install build
    if ((await this.isPlatformHeadscaleAvailable()) && !this.isMeshFresh(tenantId)) {
      const existing = await this.loadPlatformIntegration(tenantId);
      if (existing?.status !== "connected") {
        try {
          await this.enablePlatformMesh(tenantId, { refreshDevices: false });
        } catch (err) {
          console.warn(
            "[mesh] ensure before install package:",
            err instanceof Error ? err.message : err,
          );
        }
      } else {
        this.markMeshFresh(tenantId);
      }
    }
    tEnable = performance.now();

    const meshProvider = await this.resolveMeshProvider(tenantId);
    const platformMode = meshProvider === "headscale-platform";

    const oauth = await this.db.query.networkIntegrations.findFirst({
      where: and(
        eq(networkIntegrations.tenantId, tenantId),
        eq(networkIntegrations.kind, "tailscale-oauth"),
      ),
    });
    const platform = await this.loadPlatformIntegration(tenantId);
    const meshConnected = platformMode
      ? platform?.status === "connected"
      : oauth?.status === "connected";

    let tags: string[] = [];
    if (!platformMode) {
      if (oauth?.metaJson) {
        try {
          const meta = JSON.parse(oauth.metaJson) as { tags?: string[] };
          tags = normalizeTailscaleTags(meta.tags);
        } catch {
          /* ignore */
        }
      }
      if (!tags.length && oauth?.credentialsEnc) {
        try {
          const creds = decryptJson<TailscaleOAuthCredentials>(
            this.config.secret,
            oauth.credentialsEnc,
          );
          tags = normalizeTailscaleTags(creds.tags);
        } catch {
          /* ignore */
        }
      }
    }

    const hs = await this.getPlatformHeadscale();
    const loginServer = platformMode ? hs.url : null;

    let tsAuthKey: string | undefined;
    if (opts.enableTailscale) {
      if (!meshConnected) {
        throw new Error(
          platformMode ? "请先启用平台托管组网" : "请先连接 Tailscale",
        );
      }

      const authkey = await this.db.query.networkIntegrations.findFirst({
        where: and(
          eq(networkIntegrations.tenantId, tenantId),
          eq(networkIntegrations.kind, "tailscale-authkey"),
        ),
      });
      if (authkey?.credentialsEnc) {
        try {
          const creds = decryptJson<{ authKey?: string }>(
            this.config.secret,
            authkey.credentialsEnc,
          );
          if (creds.authKey?.trim()) tsAuthKey = creds.authKey.trim();
        } catch {
          /* ignore */
        }
      }

      if (!tsAuthKey && opts.mintAuthKeyIfMissing !== false) {
        const generated = await this.generateTailscaleAuthKey(tenantId, {
          tags: platformMode ? undefined : tags,
          description: `Zakura runner ${opts.slug}`,
          actorId: opts.actorId,
        });
        tsAuthKey = generated.generatedKey ?? undefined;
      }

      if (!tsAuthKey) {
        throw new Error("缺少 Tailscale Auth Key");
      }
    }
    tKey = performance.now();

    const tsHostname = `zakura-${opts.slug}`
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63);

    // Runner → Server：始终走公网 URL（Caddy / ZAKURA_PUBLIC_URL）。
    // 8787 默认不映射到宿主机，mesh IP:8787 会 RST；Tailscale 只用于 Server → Runner。
    const serverUrl = this.config.publicBaseUrl;
    if (opts.enableTailscale && tsAuthKey) {
      if (platformMode) {
        let platformKey = hs.platformAuthKey;
        if (!platformKey) {
          try {
            const client = await this.getHeadscaleClient();
            if (client) {
              const minted = await client.createPlatformPreAuthKey({ reusable: true });
              platformKey = minted.key;
              await persistPlatformAuthKey(this.db, this.config.secret, platformKey);
              await this.refreshPlatformHeadscale();
            }
          } catch {
            /* host join is best-effort */
          }
        }
        if (platformKey) {
          await this.hostTailscale
            .ensurePlatformHost({
              authKey: platformKey,
              loginServer: hs.url,
            })
            .catch(() => null);
        }
      } else if (!this.config.multiTenant) {
        await this.hostTailscale
          .ensureAndGetIp({
            authKey: tsAuthKey,
            tags,
          })
          .catch(() => null);
      }
    }
    tHost = performance.now();

    const pack = buildRunnerInstallPackage({
      token: opts.token,
      serverUrl,
      slug: opts.slug,
      enableTailscale: opts.enableTailscale,
      tsAuthKey,
      tsHostname,
      // Platform: no tags (user-owned for autogroup:self)
      tsTags: platformMode ? undefined : tags.length ? tags : undefined,
      tsLoginServer: loginServer ?? undefined,
      port: 7443,
    });

    const total = performance.now() - t0;
    if (total >= 200) {
      console.warn(
        `[mesh] buildRunnerInstallPackage ${total.toFixed(0)}ms (enable=${(tEnable - t0).toFixed(0)} key=${(tKey - tEnable).toFixed(0)} hostIp=${(tHost - tKey).toFixed(0)} ts=${opts.enableTailscale} slug=${opts.slug})`,
      );
    }

    return {
      ...pack,
      hasAuthKey: Boolean(tsAuthKey),
      meshConnected: Boolean(meshConnected),
      tags: platformMode ? [] : tags,
      loginServer,
      meshProvider,
    };
  }

  /**
   * Build plain + optional Tailscale install packages in one pass.
   * Tailscale toggle is a display choice — callers should not re-hit the API on switch.
   */
  async buildRunnerInstallVariants(
    tenantId: string,
    opts: {
      token: string;
      slug: string;
      mintAuthKeyIfMissing?: boolean;
      actorId?: string;
    },
  ): Promise<{
    plain: RunnerInstallPackage & {
      hasAuthKey: boolean;
      meshConnected: boolean;
      tags: string[];
    };
    withTailscale:
      | (RunnerInstallPackage & {
          hasAuthKey: boolean;
          meshConnected: boolean;
          tags: string[];
        })
      | null;
    meshConnected: boolean;
    hostJoinsTailscale: boolean;
    meshProvider: MeshProviderId | null;
    tailscaleError?: string;
  }> {
    const t0 = performance.now();
    const plain = await this.buildRunnerInstallPackage(tenantId, {
      token: opts.token,
      slug: opts.slug,
      enableTailscale: false,
      mintAuthKeyIfMissing: false,
      actorId: opts.actorId,
    });
    const tPlain = performance.now();

    const platformMode = await this.isPlatformHeadscaleAvailable();
    let withTailscale: typeof plain | null = null;
    let tailscaleError: string | undefined;
    if (plain.meshConnected || platformMode) {
      try {
        withTailscale = await this.buildRunnerInstallPackage(tenantId, {
          token: opts.token,
          slug: opts.slug,
          enableTailscale: true,
          mintAuthKeyIfMissing: opts.mintAuthKeyIfMissing !== false,
          actorId: opts.actorId,
        });
      } catch (err) {
        tailscaleError = err instanceof Error ? err.message : String(err);
      }
    }
    const total = performance.now() - t0;
    if (total >= 200) {
      console.warn(
        `[mesh] buildRunnerInstallVariants ${total.toFixed(0)}ms (plain=${(tPlain - t0).toFixed(0)} ts=${(performance.now() - tPlain).toFixed(0)} slug=${opts.slug})`,
      );
    }

    return {
      plain,
      withTailscale,
      meshConnected: plain.meshConnected || platformMode,
      hostJoinsTailscale: await this.hostJoinsTailscaleForTenant(
        platformMode ? "headscale-platform" : plain.meshProvider,
      ),
      meshProvider: platformMode ? "headscale-platform" : plain.meshProvider,
      tailscaleError,
    };
  }
}
