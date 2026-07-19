/** Network mesh, tunnel providers, and port exposure shared types */

export const TUNNEL_PROVIDER_IDS = [
  "cloudflare-quick",
  "cloudflare-named",
  "tailscale-serve",
  "ngrok",
  "frp",
] as const;

export type TunnelProviderId = (typeof TUNNEL_PROVIDER_IDS)[number];

export const TUNNEL_PROVIDER_META: Record<
  TunnelProviderId,
  {
    name: string;
    description: string;
    requiresConfig: boolean;
    publicExposure: boolean;
  }
> = {
  "cloudflare-quick": {
    name: "Cloudflare Quick Tunnel",
    description: "零配置，随机 *.trycloudflare.com，适合开发调试。",
    requiresConfig: false,
    publicExposure: true,
  },
  "cloudflare-named": {
    name: "Cloudflare Named Tunnel",
    description: "固定域名，适合 Webhook。需 Tunnel Token。",
    requiresConfig: true,
    publicExposure: true,
  },
  "tailscale-serve": {
    name: "Tailscale Serve",
    description: "仅 tailnet 内 HTTPS，不暴露公网。需先完成 Runner 组网。",
    requiresConfig: false,
    publicExposure: false,
  },
  ngrok: {
    name: "ngrok",
    description: "公网隧道，需 Authtoken。",
    requiresConfig: true,
    publicExposure: true,
  },
  frp: {
    name: "frp（自托管）",
    description: "自托管反向代理，需 Server 地址与 Token。",
    requiresConfig: true,
    publicExposure: true,
  },
};

export const DEFAULT_DENIED_PORTS = [
  22, 2375, 2376, 5432, 6379, 27017, 5900, 6080, 9222, 8787, 7443,
] as const;

export type NetworkIntegrationKind =
  | "tailscale-oauth"
  | "tailscale-authkey"
  | "headscale-platform"
  | "cloudflare-named"
  | "ngrok"
  | "frp";

/** Mesh control-plane provider chosen by the tenant */
export type MeshProviderId = "tailscale-cloud" | "headscale-platform";

export type NetworkIntegrationStatus = "disconnected" | "connected" | "error";

export type PortExposureStatus =
  | "starting"
  | "active"
  | "error"
  | "stopped"
  | "expired";

export type PortExposureProtocol = "http" | "https" | "tcp";

export interface TailscaleHostInfo {
  connected: boolean;
  ip?: string;
  magicDnsName?: string;
  hostname?: string;
  tags?: string[];
}

export interface NetworkSecurityPolicyDto {
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
}

export interface TunnelProviderSettingDto {
  id: string;
  tenantId: string;
  provider: TunnelProviderId;
  enabled: boolean;
  isDefault: boolean;
  /** Non-secret config keys only (secrets redacted) */
  config: Record<string, unknown>;
  hasConfig: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastError: string | null;
  meta: (typeof TUNNEL_PROVIDER_META)[TunnelProviderId];
  createdAt: string;
  updatedAt: string;
}

export interface PortExposureDto {
  id: string;
  tenantId: string;
  agentId: string;
  agentName?: string | null;
  agentSlug?: string | null;
  runtimeNodeId: string | null;
  name: string | null;
  port: number;
  protocol: PortExposureProtocol;
  provider: TunnelProviderId;
  status: PortExposureStatus;
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
}

export interface NetworkOverviewDto {
  mesh: {
    connected: boolean;
    displayName: string | null;
    status: NetworkIntegrationStatus | "unavailable";
  };
  defaultProvider: TunnelProviderId | null;
  exposureEnabled: boolean;
  runners: { online: number; total: number };
  activeExposures: number;
  exposuresToday: number;
  auditEventsToday: number;
}

export interface NetworkAuditLogDto {
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
}
