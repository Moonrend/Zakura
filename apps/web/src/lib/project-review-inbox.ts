"use client";

import { api } from "@/lib/api";

export type ReviewKind =
  | "operation"
  | "source"
  | "merge"
  | "baseline"
  | "task_review"
  | "decision"
  | "question";
export type ReviewItem = {
  id: string;
  kind: ReviewKind;
  projectId: string;
  projectName: string;
  spaceId: string;
  runId?: string;
  taskId?: string;
  status: string;
  revision: number;
  risk: number;
  createdAt: string;
  updatedAt: string;
  waitingSeconds: number;
  requiredRole: "member" | "owner_admin";
  canAct: boolean;
  title: string;
  action: string;
  summary: string;
  hasError: boolean;
  errorCategory?: string;
  toolName?: string;
  effect?: string;
  argumentFields?: string[];
  snapshotId?: string;
  href: string;
};
export type ReviewGroup = {
  kind: ReviewKind;
  status: string;
  requiredRole: "member" | "owner_admin";
  count: number;
  oldestAt: string;
};
export type ReviewSummary = {
  total: number;
  groups: ReviewGroup[];
  snapshotAt: string;
  visibleKinds: ReviewKind[];
};
export type ReviewList = {
  items: ReviewItem[];
  nextCursor?: string;
  snapshotAt: string;
  total: number;
  visibleKinds: ReviewKind[];
};
export type ReviewFilters = {
  spaceId?: string;
  projectId?: string;
  kind?: ReviewKind | "";
  status?: string;
  q?: string;
  reviewId?: string;
  runId?: string;
  minAgeSeconds?: number;
  maxAgeSeconds?: number;
};
export const reviewKindLabels: Record<ReviewKind, string> = {
  operation: "工具调用",
  source: "原工作区进程确认",
  merge: "工作区合并",
  baseline: "需求基线",
  task_review: "任务验收",
  decision: "项目决策",
  question: "开放问题",
};
export const reviewStatusLabels: Record<string, string> = {
  pending_approval: "等待调用审批",
  unknown: "结果未知",
  ready: "等待产物审查",
  approved: "已批准，等待发布",
  conflicted: "需要解决冲突",
  verification_failed: "验收未通过",
  applying: "发布结果待确认",
  waiting_review: "等待任务验收",
  proposed: "等待决策审核",
  open: "等待问题结论",
  draft: "等待基线审核",
  pending: "确认回执待检查",
};
export const reviewErrorLabels: Record<string, string> = {
  timeout: "请求超时",
  conflict: "状态或基线冲突",
  permission: "权限或策略拒绝",
  unknown_outcome: "执行结果未知",
  recorded_error: "记录了执行错误",
};
function filterQuery(filters: ReviewFilters, cursor?: string, limit?: number) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  if (cursor) query.set("cursor", cursor);
  if (limit) query.set("limit", String(Math.min(200, Math.max(1, limit))));
  return query.toString();
}
export function getReviewInbox(filters: ReviewFilters, cursor?: string, limit = 50) {
  return api<ReviewList>(`/api/project-reviews/?${filterQuery(filters, cursor, limit)}`, {
    cacheTtlMs: false,
  });
}
export function getReviewSummary(filters: ReviewFilters) {
  return api<ReviewSummary>(`/api/project-reviews/summary?${filterQuery(filters)}`, {
    cacheTtlMs: false,
  });
}
export async function recheckReview(item: ReviewItem) {
  const current = await getReviewInbox({
    projectId: item.projectId,
    kind: item.kind,
    reviewId: item.id,
    runId: item.runId,
  }, undefined, 200);
  return current.items.find((value) => reviewItemKey(value) === reviewItemKey(item)) ?? null;
}
export function reviewItemKey(item: ReviewItem) {
  return JSON.stringify([item.kind, item.projectId, item.runId ?? "", item.id]);
}
export function reviewWaitingLabel(seconds: number) {
  if (seconds < 60) return "不到 1 分钟";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时`;
  return `${Math.floor(seconds / 86400)} 天`;
}
export function reviewDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "时间不可用" : parsed.toLocaleString("zh-CN");
}
