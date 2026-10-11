"use client";

import { api } from "@/lib/api";
import type { Plan } from "@/lib/project-execution";

export type AcceptanceBinding = { taskSpecId: string; checkId: string };
export type RequirementClause = {
  id: string;
  kind: "functional" | "nonfunctional" | "constraint";
  title: string;
  description: string;
  required: boolean;
  bindings: AcceptanceBinding[];
};
export type RequirementsDraft = {
  title: string;
  clauses: RequirementClause[];
  requiredBeforePublication: boolean;
};
export type RequirementsBaseline = RequirementsDraft & {
  id: string;
  projectId: string;
  revision: number;
  status: "draft" | "approved" | "archived" | "deleted";
  approvedBy?: string;
  approvedAt?: string;
  approvedPlan: Plan;
  approvedPlanHash?: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};
export type RequirementsRevision = {
  baseline: RequirementsBaseline;
  action: string;
  authorId: string;
  comment: string;
  createdAt: string;
};
export type RequirementsRunBinding = {
  runId: string;
  baselineId: string;
  baselineRevision: number;
  baselineHash: string;
  baseline: RequirementsBaseline;
  frozenPlanHash: string;
  boundBy: string;
  boundAt: string;
};
export type RequirementIssue = {
  code: string;
  clauseId?: string;
  taskSpecId?: string;
  checkId?: string;
  severity: "error" | "warning";
  message: string;
};
export type RequirementsAnalysis = {
  planHash: string;
  valid: boolean;
  required: number;
  optional: number;
  issues: RequirementIssue[];
};
export type RequirementStatus =
  | "missing"
  | "pending"
  | "failed"
  | "review_unapproved"
  | "changed_plan"
  | "passed";
export type RequirementEvidence = {
  taskSpecId: string;
  taskId?: string;
  checkId: string;
  status: RequirementStatus;
  reason: string;
  snapshotId?: string;
  verificationId?: string;
  reviewId?: string;
  summary?: string;
};
export type RequirementsCoverage = {
  runId: string;
  baselineId: string;
  baselineRevision: number;
  baselineHash: string;
  frozenPlanHash: string;
  approvedPlanHash: string;
  bound: boolean;
  requiredBeforePublication: boolean;
  publicationAllowed: boolean;
  requiredPassed: number;
  requiredTotal: number;
  rows: {
    clause: RequirementClause;
    status: RequirementStatus;
    evidence: RequirementEvidence[];
  }[];
  issues: RequirementIssue[];
};
const path = (pid: string) =>
  `/api/project-executions/${encodeURIComponent(pid)}/requirements`;
const item = (pid: string, id: string) =>
  `${path(pid)}/${encodeURIComponent(id)}`;
export function listRequirements(
  pid: string,
  cursor?: string,
  includeRetired = false,
) {
  const query = new URLSearchParams({ limit: "50" });
  if (cursor) query.set("cursor", cursor);
  if (includeRetired) query.set("includeRetired", "true");
  return api<{ items: RequirementsBaseline[]; nextCursor?: string }>(
    `${path(pid)}?${query}`,
    { cacheTtlMs: false },
  );
}
export function getRequirements(pid: string, id: string, revision?: number) {
  return api<RequirementsBaseline>(
    `${item(pid, id)}${revision ? `?revision=${revision}` : ""}`,
    { cacheTtlMs: false },
  );
}
export function saveRequirements(
  pid: string,
  draft: RequirementsDraft,
  current?: RequirementsBaseline,
  comment = "",
) {
  return api<RequirementsBaseline>(
    current ? item(pid, current.id) : path(pid),
    {
      method: current ? "PATCH" : "POST",
      json: current
        ? { ...draft, expectedRevision: current.revision, comment }
        : draft,
    },
  );
}
export function reviewRequirements(
  pid: string,
  current: RequirementsBaseline,
  projectRevision: number,
  decision: "approved" | "rejected",
  comment: string,
) {
  return api<RequirementsBaseline>(`${item(pid, current.id)}/review`, {
    method: "POST",
    json: {
      expectedRevision: current.revision,
      expectedProjectRevision: projectRevision,
      decision,
      comment,
    },
  });
}
export function retireRequirements(
  pid: string,
  current: RequirementsBaseline,
  action: "archive" | "delete",
  comment: string,
) {
  return api<RequirementsBaseline>(
    `${item(pid, current.id)}${action === "archive" ? "/archive" : ""}`,
    {
      method: action === "archive" ? "POST" : "DELETE",
      json: { expectedRevision: current.revision, comment },
    },
  );
}
export function requirementsHistory(pid: string, id: string, before?: number) {
  return api<{ items: RequirementsRevision[] }>(
    `${item(pid, id)}/history${before ? `?before=${before}` : ""}`,
    { cacheTtlMs: false },
  );
}
export function requirementsAnalysis(pid: string, id: string) {
  return api<RequirementsAnalysis>(`${item(pid, id)}/analysis`, {
    cacheTtlMs: false,
  });
}
export function bindRequirements(
  pid: string,
  baseline: RequirementsBaseline,
  runId: string,
) {
  return api<RequirementsRunBinding>(`${item(pid, baseline.id)}/bind`, {
    method: "POST",
    json: { expectedRevision: baseline.revision, runId },
  });
}
export function requirementsRunCoverage(pid: string, runId: string) {
  return api<{
    binding: RequirementsRunBinding | null;
    coverage: RequirementsCoverage;
  }>(`${path(pid)}/runs/${encodeURIComponent(runId)}`, { cacheTtlMs: false });
}
export function requirementsDraftError(
  draft: RequirementsDraft,
): string | null {
  if (!draft.title.trim()) return "请填写需求基线名称。";
  if (draft.clauses.length === 0 || draft.clauses.length > 500)
    return "需要 1 至 500 条需求条款。";
  const ids = new Set<string>();
  for (const clause of draft.clauses) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(clause.id) ||
      ids.has(clause.id)
    )
      return "条款 ID 必须唯一，并使用字母、数字、点、下划线或横线。";
    ids.add(clause.id);
    if (!clause.title.trim()) return `请填写条款 ${clause.id} 的标题。`;
    const bindings = new Set<string>();
    for (const binding of clause.bindings) {
      const key = `${binding.taskSpecId}\0${binding.checkId}`;
      if (!binding.taskSpecId || !binding.checkId || bindings.has(key))
        return `条款 ${clause.id} 存在空映射或重复映射。`;
      bindings.add(key);
    }
  }
  return null;
}
export const requirementStatusLabel: Record<RequirementStatus, string> = {
  missing: "缺少映射或证据",
  pending: "等待任务和验收",
  failed: "验收失败",
  review_unapproved: "等待人工任务审批",
  changed_plan: "冻结计划与签审基线不符",
  passed: "满足映射验收",
};
