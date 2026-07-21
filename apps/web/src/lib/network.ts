import { api } from "@/lib/api";

export type TunnelProviderId =
  | "cloudflare-quick"
  | "cloudflare-named"
  | "tailscale-serve"
  | "ngrok"
  | "frp";

export type NetworkOverviewDto = {
  mesh: {
    connected: boolean;
    displayName: string | null;
    status: string;
  };
  defaultProvider: TunnelProviderId | null;
  exposureEnabled: boolean;
  runners: { online: number; total: number };
  activeExposures: number;
  exposuresToday: number;
  auditEventsToday: number;
  /** False in SaaS: control plane host does not join tenant tailnets */
  hostJoinsTailscale?: boolean;
};

export type TunnelProviderSettingDto = {
  id: string;
  tenantId: string;
  provider: TunnelProviderId;
  enabled: boolean;
  isDefault: boolean;
  config: Record<string, unknown>;
  hasConfig: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastError: string | null;
  meta: { name: string; description: string; requiresConfig: boolean; publicExposure: boolean };
  createdAt: string;
  updatedAt: string;
};

export type NetworkSecurityPolicyDto = {
  id: string;
  tenantId: string;
  scope: "platform" | "tenant";
  enabled: boolean;
  exposureEnabled: boolean;
  defaultTtlMinutes: number;
  maxTtlMinutes: number;
  maxActivePerAgent: number;
  maxActivePerTenant: number;
  deniedPorts: number[];
  allowDesktopExposure: boolean;
  allowPublicExposure: boolean;
  allowTcpExposure: boolean;
  agentsCanExpose: boolean;
  requireUserApproval: boolean;
  requireTailscaleForRemoteRunners: boolean;
  auditRetentionDays: number;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PortExposureDto = {
  id: string;
  tenantId: string;
  agentId: string;
  agentName?: string | null;
  agentSlug?: string | null;
  runtimeNodeId: string | null;
  name: string | null;
  port: number;
  protocol: string;
  provider: string;
  status: string;
  publicUrl: string | null;
  relayHost: string | null;
  relayPort: number | null;
  ttlMinutes: number | null;
  expiresAt: string | null;
  lastError: string | null;
  createdByType: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  stoppedAt: string | null;
};

export type NetworkAuditLogDto = {
  id: string;
  tenantId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
};

export type MeshDevice = {
  id: string;
  name: string;
  slug: string;
  kind: string;
  status: string;
  endpoint: string | null;
  tailscale: {
    connected: boolean;
    ip: string | null;
    magicDnsName: string | null;
    hostname: string | null;
    tags: string[];
  } | null;
};

export type TailnetDevice = {
  id: string;
  name: string;
  hostname: string;
  addresses: string[];
  tags: string[];
  online: boolean;
  user?: string;
  os?: string;
  lastSeen?: string;
};

export type MeshPayload = {
  connected: boolean;
  /** Active mesh control plane */
  meshProvider?: "tailscale-cloud" | "headscale-platform" | null;
  loginServer?: string | null;
  headscaleUser?: string | null;
  oauth: {
    status: string;
    displayName: string | null;
    lastSyncAt: string | null;
    lastError: string | null;
    tags?: string[];
    deviceCount?: number;
    createClientUrl?: string;
  } | null;
  platform?: {
    status: string;
    displayName: string | null;
    lastSyncAt: string | null;
    lastError: string | null;
    deviceCount?: number;
    headscaleUser?: string | null;
  } | null;
  hasAuthKey: boolean;
  devices: MeshDevice[];
  tailnetDevices?: TailnetDevice[];
  note?: string;
  joinCommand?: string;
  generatedKey?: string;
  generatedKeyId?: string;
  generatedKeyExpires?: string | null;
  generatedKeyTags?: string[];
  hostJoinsTailscale?: boolean;
};

export const NETWORK_SUBNAV = [
  { href: "", label: "概览" },
  { href: "mesh", label: "Runner 组网" },
  { href: "exposure", label: "端口暴露" },
  { href: "active", label: "活跃暴露" },
  { href: "security", label: "安全策略" },
] as const;

export function networkPath(seg?: string) {
  return seg ? `/dashboard/network/${seg}` : "/dashboard/network";
}

export async function fetchNetworkOverview() {
  return api<NetworkOverviewDto>("/api/settings/network/overview");
}

export async function fetchMesh() {
  return api<MeshPayload>("/api/settings/network/mesh");
}

export async function startMeshOauth() {
  return api<{
    mode: string;
    createClientUrl: string;
    recommendedScopes: string[];
    recommendedTags: string[];
    note: string;
  }>("/api/settings/network/mesh/oauth/start", { method: "POST", json: {} });
}

export async function connectMeshOauth(input: {
  clientId: string;
  clientSecret: string;
  tags?: string[];
}) {
  return api<MeshPayload>("/api/settings/network/mesh/oauth/connect", {
    method: "POST",
    json: input,
  });
}

export async function updateMeshOauthTags(tags: string[]) {
  return api<MeshPayload>("/api/settings/network/mesh/oauth/tags", {
    method: "PATCH",
    json: { tags },
  });
}

export async function ensureMeshAclTags(tags?: string[]) {
  return api<
    MeshPayload & {
      aclEnsure?: { added: string[]; alreadyPresent: string[]; owners: string[] };
    }
  >("/api/settings/network/mesh/acl/ensure-tags", {
    method: "POST",
    json: { tags },
  });
}

export async function enablePlatformMesh() {
  return api<MeshPayload>("/api/settings/network/mesh/platform/enable", {
    method: "POST",
    json: {},
  });
}

export async function syncMesh() {
  return api<MeshPayload>("/api/settings/network/mesh/sync", {
    method: "POST",
    json: {},
  });
}

export async function generateMeshAuthKey(input?: {
  tags?: string[];
  expirySeconds?: number;
  description?: string;
}) {
  return api<MeshPayload>("/api/settings/network/mesh/auth-key/generate", {
    method: "POST",
    json: input ?? {},
  });
}

export async function saveMeshAuthKey(authKey: string) {
  return api<MeshPayload>("/api/settings/network/mesh/auth-key", {
    method: "POST",
    json: { authKey },
  });
}

export async function disconnectMesh() {
  return api<MeshPayload>("/api/settings/network/mesh/disconnect", {
    method: "POST",
    json: {},
  });
}

export type PlatformHeadscaleConfig = {
  enabled: boolean;
  url: string;
  hasApiKey: boolean;
  hasPlatformAuthKey: boolean;
  ready: boolean;
};

export async function fetchPlatformHeadscale() {
  return api<PlatformHeadscaleConfig>("/api/settings/network/headscale");
}

export async function savePlatformHeadscale(body: {
  enabled?: boolean;
  url?: string;
  apiKey?: string;
  platformAuthKey?: string;
}) {
  return api<PlatformHeadscaleConfig>("/api/settings/network/headscale", {
    method: "PUT",
    json: body,
  });
}

export async function fetchProviders() {
  return api<{ providers: TunnelProviderSettingDto[] }>(
    "/api/settings/network/exposure/providers",
  );
}

export async function patchProvider(
  id: string,
  body: { enabled?: boolean; isDefault?: boolean; config?: Record<string, unknown> },
) {
  return api<{ provider: TunnelProviderSettingDto }>(
    `/api/settings/network/exposure/providers/${id}`,
    { method: "PATCH", json: body },
  );
}

export async function testProvider(id: string) {
  return api<{ ok: boolean; message: string; publicUrl?: string }>(
    `/api/settings/network/exposure/providers/${id}/test`,
    { method: "POST", json: {} },
  );
}

export async function createCloudflareNamedTunnel(name?: string) {
  return api<{
    tunnelId: string;
    tunnelName: string;
    hasToken: boolean;
    provider: TunnelProviderSettingDto;
  }>("/api/settings/network/exposure/providers/cloudflare-named/create-tunnel", {
    method: "POST",
    json: { name },
  });
}

export async function fetchSecurityPolicy() {
  return api<{ policy: NetworkSecurityPolicyDto }>("/api/settings/network/security");
}

export async function updateSecurityPolicy(body: Partial<NetworkSecurityPolicyDto>) {
  return api<{ policy: NetworkSecurityPolicyDto }>("/api/settings/network/security", {
    method: "PUT",
    json: {
      enabled: body.enabled,
      exposureEnabled: body.exposureEnabled,
      defaultTtlMinutes: body.defaultTtlMinutes,
      maxTtlMinutes: body.maxTtlMinutes,
      maxActivePerAgent: body.maxActivePerAgent,
      maxActivePerTenant: body.maxActivePerTenant,
      deniedPorts: body.deniedPorts,
      allowDesktopExposure: body.allowDesktopExposure,
      allowPublicExposure: body.allowPublicExposure,
      allowTcpExposure: body.allowTcpExposure,
      agentsCanExpose: body.agentsCanExpose,
      requireUserApproval: body.requireUserApproval,
      requireTailscaleForRemoteRunners: body.requireTailscaleForRemoteRunners,
      auditRetentionDays: body.auditRetentionDays,
    },
  });
}

export async function fetchActiveExposures() {
  return api<{ exposures: PortExposureDto[] }>("/api/settings/network/active-exposures");
}

export async function stopAllExposures() {
  return api<{ stopped: number }>("/api/settings/network/active-exposures/stop-all", {
    method: "POST",
    json: {},
  });
}

export async function stopExposure(id: string) {
  return api<{ exposure: PortExposureDto }>(`/api/exposures/${id}`, {
    method: "DELETE",
  });
}

export async function fetchAuditLogs(opts?: { limit?: number; offset?: number }) {
  const q = new URLSearchParams();
  if (opts?.limit) q.set("limit", String(opts.limit));
  if (opts?.offset) q.set("offset", String(opts.offset));
  const qs = q.toString();
  return api<{ items: NetworkAuditLogDto[]; total: number }>(
    `/api/settings/network/audit${qs ? `?${qs}` : ""}`,
  );
}
