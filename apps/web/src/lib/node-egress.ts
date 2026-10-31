import { api } from "./api";

export type EgressMode = "off" | "allow" | "deny";

export type NodeEgressPolicy = {
  mode: EgressMode;
  allow: string[] | null;
  deny: string[] | null;
  noUpstream: string[] | null;
  /** 已脱敏：只含协议与主机，凭证不会返回 */
  upstream?: string;
  logAllowed: boolean;
};

export type EgressDecision = { time: string; client: string; host: string; port: number; allowed: boolean; reason: string };

export type NodeEgressState = {
  policy: NodeEgressPolicy;
  meta: { appliedAt: string | null; applyError: string | null; updatedAt: string | null; hasUpstream: boolean };
  /** 节点在线时的实时状态 */
  live: { proxy: string; allowed: number; denied: number; recent: EgressDecision[] | null } | null;
};

export type EgressPresets = { presets: Record<string, NodeEgressPolicy>; builtinDeny: string[] };

const path = (node: string) => `/api/runtime-nodes/${encodeURIComponent(node)}/egress`;

export const fetchNodeEgress = (node: string) => api<NodeEgressState>(path(node), { cacheTtlMs: false });
export const fetchEgressPresets = () => api<EgressPresets>("/api/settings/network/egress/presets");
export const saveNodeEgress = (node: string, body: NodeEgressPolicy & { keepUpstream?: boolean }) =>
  api<{ applied: boolean; applyError?: string }>(path(node), { method: "PUT", json: body });
