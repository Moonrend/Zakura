import { api } from "./api";
import { workspaceNodeUnavailableReason, type RuntimeNode } from "./runners";

export type WorkspaceDisk = {
  id: string;
  name: string;
  nodeId: string;
  nodeIncarnation: string;
  nodeRemovedAt?: string | null;
  state: string;
  attachedInstanceId: string | null;
  usedBytes: number | null;
  sampledAt: string | null;
  verifiedAt: string | null;
  lastError: string | null;
};
export type WorkspaceInstance = { instanceId: string; generation: number; diskId: string; nodeId: string; state: string };
export type WorkspaceCleanup = { id: string; instanceId: string | null; diskId: string; deleteDisk: boolean; phase: string; pending: boolean; lastError: string | null };
export type WorkspaceDisks = { disks: WorkspaceDisk[]; cleanups: WorkspaceCleanup[] };
export const diskStateText: Record<string, string> = { pending: "等待创建确认", available: "可用于重建", attached: "工作区正在使用", release_pending: "等待释放", delete_pending: "等待删除", unknown: "等待核验", error: "需要处理", deleted: "已删除" };
export const diskDeletionDescription = "永久删除盘中的项目文件、上传与输出、技能和认证资料。聊天记录和其他数据盘保留。节点离线时会等待上线后清理。";

export function diskNodeUnavailableReason(node: RuntimeNode): string | null {
  return workspaceNodeUnavailableReason(node) || (node.kind === "local" || node.capabilities.workspaceProtocolV2 !== true ? "请更新节点，启用数据盘协议" : null);
}
export function diskUnavailableReason(disk: WorkspaceDisk, node: RuntimeNode | undefined): string | null {
  if (disk.nodeRemovedAt) return "原节点已删除，已停止同步";
  if (disk.state !== "available" || disk.attachedInstanceId) return diskStateText[disk.state] ?? "数据盘暂不可用";
  if (!disk.verifiedAt) return "等待原节点核验";
  return node ? diskNodeUnavailableReason(node) : "原节点不可用";
}
export function diskUsageIsStale(disk: WorkspaceDisk, online: boolean, now = Date.now()): boolean {
  const sampled = disk.sampledAt ? Date.parse(disk.sampledAt) : NaN;
  return !online || !Number.isFinite(sampled) || now - sampled > 15 * 60 * 1000;
}
const base = (space: string) => `/api/spaces/${encodeURIComponent(space)}/disks`;
export const listWorkspaceDisks = (space: string) => api<WorkspaceDisks>(base(space), { cacheTtlMs: false });
export const createWorkspaceDisk = (space: string, name: string, nodeId: string) => api<{ disk: WorkspaceDisk }>(base(space), { method: "POST", json: { name, nodeId } });
export const renameWorkspaceDisk = (space: string, disk: string, name: string) => api(`${base(space)}/${encodeURIComponent(disk)}`, { method: "PATCH", json: { name } });
export const refreshWorkspaceDisk = (space: string, disk: string) => api(`${base(space)}/${encodeURIComponent(disk)}/refresh`, { method: "POST", json: {} });
export const deleteWorkspaceDisk = (space: string, disk: string, requestId: string) => api(`${base(space)}/${encodeURIComponent(disk)}`, { method: "DELETE", json: { requestId } });
