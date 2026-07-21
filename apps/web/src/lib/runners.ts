import { api } from "@/lib/api";

export type RunnerNetworkInterface = {
  name: string;
  mac?: string;
  ipv4: string[];
  ipv6: string[];
  internal: boolean;
  operstate?: string;
};

export type RunnerHostInfo = {
  hostname?: string;
  platform?: string;
  arch?: string;
  primaryIp?: string;
  interfaces?: RunnerNetworkInterface[];
  publicUrl?: string;
  dockerVersion?: string;
  storageRoot?: string;
  disk?: { totalBytes: number; freeBytes: number };
  tailscale?: {
    connected: boolean;
    ip?: string;
    magicDnsName?: string;
    hostname?: string;
    tags?: string[];
  };
};

export type RuntimeNode = {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  kind: "local" | "runner" | string;
  status: "online" | "offline" | "draining" | string;
  endpoint: string | null;
  capabilities: Record<string, unknown>;
  hostInfo: RunnerHostInfo | Record<string, unknown>;
  storageRoot: string;
  agentVersion: string | null;
  lastSeenAt: string | null;
  labels: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type RunnerInstallPackage = {
  compose: string;
  filename: string;
  /** Detect/install Docker → /var/zakura → start */
  script: string;
  /** Plain docker run (no compose) */
  dockerRun?: string;
  enableTailscale: boolean;
  tsHostname: string | null;
  slug: string;
  hasAuthKey?: boolean;
  meshConnected?: boolean;
  tags?: string[];
  bootstrapUrl?: string;
  /** curl | sudo bash */
  installCurl?: string;
};

export type RunnerInstallBundle = {
  node: RuntimeNode;
  /** Always the non-Tailscale package */
  install: RunnerInstallPackage;
  /** Present when mesh is connected and auth key is available */
  installTailscale: RunnerInstallPackage | null;
  meshConnected?: boolean;
  hostJoinsTailscale?: boolean;
  meshProvider?: string | null;
  tailscaleError?: string;
  tokenHint?: string;
};

export function isRunnerHostInfo(v: unknown): v is RunnerHostInfo {
  return Boolean(v && typeof v === "object");
}

export async function listRuntimeNodes(): Promise<RuntimeNode[]> {
  const res = await api<{ nodes: RuntimeNode[] }>("/api/runtime-nodes");
  return res.nodes ?? [];
}

export async function getRuntimeNode(id: string): Promise<RuntimeNode> {
  const res = await api<{ node: RuntimeNode }>(`/api/runtime-nodes/${id}`);
  return res.node;
}

/** Runner 详情页：node + containers + mesh 摘要（安装包见 /install） */
export type RunnerDetailPayload = {
  node: RuntimeNode;
  containers: ManagedContainerRow[];
  install: RunnerInstallPackage | null;
  installTailscale: RunnerInstallPackage | null;
  meshConnected?: boolean;
  hostJoinsTailscale?: boolean;
  meshProvider?: string | null;
  tailscaleError?: string | null;
  tokenHint?: string | null;
};

export async function fetchRunnerDetail(id: string): Promise<RunnerDetailPayload> {
  return api(`/api/runtime-nodes/${id}/detail`);
}

export async function createRuntimeNode(input: {
  name: string;
  labels?: Record<string, unknown>;
  enableTailscale?: boolean;
}): Promise<{
  node: RuntimeNode;
  token: string;
  install: RunnerInstallPackage | null;
  installTailscale?: RunnerInstallPackage | null;
  hostJoinsTailscale?: boolean;
}> {
  return api("/api/runtime-nodes", {
    method: "POST",
    json: input,
  });
}

/** Fetch both install variants once — toggle Tailscale locally, do not re-fetch. */
export async function fetchRunnerInstall(id: string): Promise<RunnerInstallBundle> {
  return api(`/api/runtime-nodes/${id}/install`);
}

export function pickInstallPackage(
  bundle: Pick<RunnerInstallBundle, "install" | "installTailscale">,
  enableTailscale: boolean,
): RunnerInstallPackage {
  if (enableTailscale && bundle.installTailscale) return bundle.installTailscale;
  return bundle.install;
}

export type ManagedContainerRow = {
  id: string;
  name: string;
  image: string;
  purpose: string;
  status: string;
  dockerId?: string | null;
  allocatedTo?: string | null;
  runtimeNodeId?: string | null;
};

export async function listNodeContainers(nodeId: string): Promise<ManagedContainerRow[]> {
  const res = await api<{ containers: ManagedContainerRow[] }>(
    `/api/runtime-nodes/${nodeId}/containers`,
  );
  return res.containers ?? [];
}

export async function allocateNodeContainer(
  nodeId: string,
  input: {
    image: string;
    name?: string;
    purpose?: string;
    allocatedTo?: string;
  },
): Promise<ManagedContainerRow> {
  const res = await api<{ container: ManagedContainerRow }>(
    `/api/runtime-nodes/${nodeId}/containers/allocate`,
    { method: "POST", json: input },
  );
  return res.container;
}

export async function stopContainer(id: string, remove = true): Promise<void> {
  await api(`/api/containers/${id}/stop`, {
    method: "POST",
    json: { remove },
  });
}

export async function fetchRunnerMeshStatus(): Promise<{
  meshConnected: boolean;
  hasAuthKey: boolean;
  tags: string[];
  /** False in SaaS cloud mode: host never joins tenant tailnets */
  hostJoinsTailscale?: boolean;
  meshProvider?: string | null;
}> {
  return api("/api/runtime-nodes/mesh-status");
}

export async function patchRuntimeNode(
  id: string,
  input: { name?: string; labels?: Record<string, unknown> },
): Promise<RuntimeNode> {
  const res = await api<{ node: RuntimeNode }>(`/api/runtime-nodes/${id}`, {
    method: "PATCH",
    json: input,
  });
  return res.node;
}

export async function deleteRuntimeNode(id: string): Promise<void> {
  await api(`/api/runtime-nodes/${id}`, { method: "DELETE" });
}

export function formatBytes(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function statusVariant(
  status: string,
): "success" | "secondary" | "warn" | "danger" | "outline" {
  switch (status) {
    case "online":
      return "success";
    case "draining":
      return "warn";
    case "offline":
      return "secondary";
    default:
      return "outline";
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case "online":
      return "在线";
    case "offline":
      return "离线";
    case "draining":
      return "排空中";
    default:
      return status;
  }
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case "local":
      return "本机";
    case "runner":
      return "远程 Runner";
    default:
      return kind;
  }
}
