import { api } from "@/lib/api";
import { DEFAULT_RUNNER_IMAGE } from "@zakura/shared";
import type {
  ImageUpdateEntry,
  ImageUpdateKind,
  NodeImageUpdateStatus,
} from "@zakura/shared";

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
  isShared?: boolean;
  createdByUserId?: string | null;
  access?: "owned" | "shared";
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
  const res = await api<{ nodes: RuntimeNode[]; canUseLocalRunner?: boolean }>(
    "/api/runtime-nodes",
  );
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

/** Live Runner version + image + container id (probes the runner over its API). */
export type RunnerVersionInfo = {
  version: string | null;
  image: string | null;
  containerId: string | null;
  /** True when the value came from a live probe (false = DB fallback / offline). */
  live: boolean;
  /** Last version the runner reported via heartbeat. */
  reportedVersion: string | null;
};

export async function fetchRunnerVersion(
  id: string,
): Promise<RunnerVersionInfo> {
  return api(`/api/runtime-nodes/${id}/version`);
}

/** Trigger a remote Runner self-update to `image`. */
export async function updateRunner(
  id: string,
  body: { image: string; recreateDelayMs?: number },
): Promise<{ image: string; scheduled: true }> {
  return api(`/api/runtime-nodes/${id}/update-runner`, {
    method: "POST",
    json: body,
  });
}

/** Pull (refresh) a workspace image on the runner, optionally recreating runnings. */
export async function refreshWorkspaceImage(
  id: string,
  body: { image: string; recreateRunning?: boolean },
): Promise<{
  image: string;
  status: string;
  recreated: Array<{ agentId: string; dockerId: string; name: string }>;
}> {
  return api(`/api/runtime-nodes/${id}/refresh-workspace-image`, {
    method: "POST",
    json: body,
  });
}

// 镜像更新的线上结构统一由 @zakura/shared 定义（此前 6 处各写一份，已经互相漂移）。
export type { ImageUpdateEntry, ImageUpdateKind } from "@zakura/shared";

export async function fetchImageUpdates(
  id: string,
): Promise<{ images: ImageUpdateEntry[]; checkedAt?: number }> {
  return api(`/api/runtime-nodes/${id}/image-updates`);
}

/** 单节点状态 + 后端附加的节点元数据。 */
export type ImageUpdateNode = NodeImageUpdateStatus & {
  nodeName: string | null;
  nodeStatus: string | null;
  nodeKind: string | null;
  access: "owned" | "shared" | null;
};

export type GlobalImageUpdateStatus = {
  hasUpdates: boolean;
  /** 至少一个节点有运行中的工作区落后于其 tag。 */
  hasRunningStale: boolean;
  /** 至少一次探测失败 —— 「未知」不能当成「已是最新」显示。 */
  hasErrors?: boolean;
  nodes: ImageUpdateNode[];
};

export async function fetchGlobalImageUpdates(): Promise<GlobalImageUpdateStatus> {
  return api("/api/system/image-updates", { cacheTtlMs: 60_000 });
}

export async function checkNodeImageUpdates(
  nodeId: string,
): Promise<ImageUpdateNode> {
  return api("/api/system/image-updates/check", {
    method: "POST",
    json: { nodeId },
  });
}

/** 主动检查当前租户可见的全部在线 runner，返回与 GET 一致的结构。 */
export async function checkAllImageUpdates(): Promise<GlobalImageUpdateStatus> {
  return api("/api/system/image-updates/check-all", {
    method: "POST",
  });
}

/**
 * 条目该走哪条升级路径。
 *
 * 优先用后端给的 `kind` —— 只有服务端知道每个节点实际的 Runner 镜像。
 * 之前这里拿 image 和硬编码的 DEFAULT_RUNNER_IMAGE 做全等比较，于是任何
 * 用别的 tag / 别的 registry / 自建镜像部署的 Runner 都会被判成工作区镜像，
 * 走进 refreshWorkspaceImage：它匹配到 0 个工作区容器，返回成功，
 * 而 Runner 根本没升级。仅在后端没带 kind 时才按仓库名兜底（不比 tag）。
 */
export function resolveImageUpdateKind(entry: {
  image: string;
  kind?: ImageUpdateKind;
}): ImageUpdateKind {
  if (entry.kind) return entry.kind;
  const repo = (ref: string) => ref.split("@")[0]!.replace(/:[^/:]+$/, "");
  return repo(entry.image) === repo(DEFAULT_RUNNER_IMAGE) ? "runner" : "workspace";
}

/**
 * 统一升级入口：runner 镜像走 updateRunner（重建 Runner 容器），
 * 工作区镜像走 refreshWorkspaceImage（重建运行中工作区）。返回 kind 以便调用方给出针对性的 toast 文案。
 */
export async function upgradeNodeImage(
  nodeId: string,
  entry: string | { image: string; kind?: ImageUpdateKind },
): Promise<{ kind: ImageUpdateKind; result: unknown }> {
  const target = typeof entry === "string" ? { image: entry } : entry;
  const kind = resolveImageUpdateKind(target);
  if (kind === "runner") {
    return { kind, result: await updateRunner(nodeId, { image: target.image }) };
  }
  return {
    kind,
    result: await refreshWorkspaceImage(nodeId, {
      image: target.image,
      recreateRunning: true,
    }),
  };
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
