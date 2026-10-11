"use client";

import { api } from "./api";
import type { MergePreview } from "./project-execution";

export type SignoffRole = "owner" | "admin" | "member";
export type SignoffRules = {
  minApprovals: number;
  eligibleReviewerIds: string[];
  eligibleRoles: SignoffRole[];
  disallowProjectCreator: boolean;
  expirySeconds: number;
};
export type SignoffPolicy = SignoffRules & {
  revision: number;
  hash: string;
  configured: boolean;
  updatedBy?: string;
  updatedAt?: string;
};
export type SignoffMember = { userId: string; name: string; role: string };
export type SignoffBinding = {
  previewId: string;
  runId: string;
  snapshotId: string;
  evidenceHash: string;
};
export type SignoffVote = {
  id: string;
  userId: string;
  role: string;
  policyHash: string;
  policyRevision: number;
  binding: SignoffBinding;
  previewRevision: number;
  decision: "approved" | "rejected";
  comment: string;
  status: "active" | "withdrawn";
  sequence: number;
  createdAt: string;
  withdrawnAt?: string;
  withdrawalSequence?: number;
};
export type SignoffVoteReason =
  | "counted"
  | "withdrawn"
  | "policy_changed"
  | "artifact_changed"
  | "future_timestamp"
  | "expired"
  | "inactive_member"
  | "ineligible_member"
  | "duplicate_reviewer"
  | "rejected"
  | "invalid_decision";
export type SignoffEvidence = {
  policyRevision: number;
  policyHash: string;
  binding: SignoffBinding;
  required: number;
  participants: {
    userId: string;
    voteId: string;
    createdAt: string;
    snapshotId: string;
  }[];
};
export type SignoffSummary = {
  policy: SignoffPolicy;
  binding: SignoffBinding;
  approvals: number;
  required: number;
  eligibleCount: number;
  quorum: boolean;
  rejected: boolean;
  canReachQuorum: boolean;
  evaluatedAt: string;
  legacyApproval?: boolean;
  evidence?: SignoffEvidence;
  votes: (SignoffVote & { counted: boolean; reason: SignoffVoteReason })[];
};
export type SignoffPreview = MergePreview & {
  reviewEvidence?: SignoffEvidence;
};
export type SignoffRecord = {
  preview: SignoffPreview;
  summary: SignoffSummary;
};
export type SignoffPolicyContext = {
  policy: SignoffPolicy;
  members: SignoffMember[];
  membersTruncated: boolean;
  currentUserId: string;
  currentRole: string;
  humanSession: boolean;
  canConfigure: boolean;
};
/** Capture a reviewed read snapshot. Never replace these fields after a conflict. */
export type SignoffTarget = {
  previewId: string;
  runId: string;
  expectedRevision: number;
  snapshotId: string;
  policyHash: string;
};

const segment = encodeURIComponent;
const base = (pid: string) => `/api/project-executions/${segment(pid)}`;
const reviewPath = (
  pid: string,
  target: { previewId: string; runId: string },
) =>
  `${base(pid)}/merges/${segment(target.previewId)}/signoffs?${new URLSearchParams({ runId: target.runId })}`;

export function getSignoffPolicy(pid: string) {
  return api<SignoffPolicyContext>(`${base(pid)}/review-policy`, {
    cacheTtlMs: false,
  });
}
export function getSignoffPolicyHistory(pid: string) {
  return api<SignoffPolicy[]>(`${base(pid)}/review-policy/history`, {
    cacheTtlMs: false,
  });
}
export function signoffRules(policy: SignoffRules): SignoffRules {
  return {
    minApprovals: policy.minApprovals,
    eligibleReviewerIds: [...policy.eligibleReviewerIds],
    eligibleRoles: [...policy.eligibleRoles],
    disallowProjectCreator: policy.disallowProjectCreator,
    expirySeconds: policy.expirySeconds,
  };
}
export function saveSignoffPolicy(
  pid: string,
  current: SignoffPolicy,
  rules: SignoffRules,
) {
  return api<{ policy: SignoffPolicy; resetPreviews: number }>(
    `${base(pid)}/review-policy`,
    {
      method: "PUT",
      json: { ...signoffRules(rules), expectedRevision: current.revision },
    },
  );
}
export function getSignoffs(pid: string, runId: string, previewId: string) {
  return api<SignoffRecord>(reviewPath(pid, { runId, previewId }), {
    cacheTtlMs: false,
  });
}
export function signoffTarget(record: SignoffRecord): SignoffTarget {
  const { preview, summary } = record;
  if (
    !preview.id ||
    !preview.runId ||
    !Number.isSafeInteger(preview.revision) ||
    preview.revision < 1 ||
    !summary.policy.hash ||
    summary.binding.previewId !== preview.id ||
    summary.binding.runId !== preview.runId ||
    !summary.binding.evidenceHash ||
    !summary.binding.snapshotId ||
    summary.binding.snapshotId !== preview.plan.result.id
  ) {
    throw new Error("签审数据的预览、运行或快照绑定不一致，请刷新后核对。");
  }
  return {
    previewId: preview.id,
    runId: preview.runId,
    expectedRevision: preview.revision,
    snapshotId: summary.binding.snapshotId,
    policyHash: summary.policy.hash,
  };
}
export function voteSignoff(
  pid: string,
  target: SignoffTarget,
  decision: SignoffVote["decision"],
  comment: string,
) {
  return api<SignoffPreview>(reviewPath(pid, target), {
    method: "POST",
    json: {
      expectedRevision: target.expectedRevision,
      snapshotId: target.snapshotId,
      policyHash: target.policyHash,
      decision,
      comment,
    },
  });
}
export function withdrawSignoff(
  pid: string,
  target: SignoffTarget,
  voteId: string,
) {
  const path = `${base(pid)}/merges/${segment(target.previewId)}/signoffs/${segment(voteId)}/withdraw?${new URLSearchParams({ runId: target.runId })}`;
  return api<SignoffPreview>(path, {
    method: "POST",
    json: {
      expectedRevision: target.expectedRevision,
      snapshotId: target.snapshotId,
      policyHash: target.policyHash,
    },
  });
}

/** This is a UI affordance only; the mutation rechecks the human actor server-side. */
export function signoffHumanReason(
  context: SignoffPolicyContext,
  localUserId: string | undefined,
): string | null {
  if (!context.humanSession || !localUserId || !context.currentUserId)
    return "投票需要当前团队的真人登录会话。";
  if (localUserId !== context.currentUserId)
    return "当前登录身份与签审身份不一致，请刷新登录信息。";
  if (!["owner", "admin", "member"].includes(context.currentRole))
    return "当前会话不是团队的有效签审成员。";
  return null;
}
export function signoffActorReason(
  context: SignoffPolicyContext,
  localUserId: string | undefined,
  policy: SignoffPolicy,
  creator: string,
): string | null {
  const humanReason = signoffHumanReason(context, localUserId);
  if (humanReason) return humanReason;
  if (!policy.eligibleRoles.includes(context.currentRole as SignoffRole))
    return "当前团队角色不在这份策略允许的签审角色中。";
  if (
    policy.eligibleReviewerIds.length > 0 &&
    !policy.eligibleReviewerIds.includes(context.currentUserId)
  )
    return "当前用户不在指定签审人名单中。";
  if (policy.disallowProjectCreator && context.currentUserId === creator)
    return "策略禁止项目创建者签审自己的项目。";
  return null;
}
export function signoffRulesError(rules: SignoffRules): string | null {
  if (
    !Number.isSafeInteger(rules.minApprovals) ||
    rules.minApprovals < 1 ||
    rules.minApprovals > 10
  )
    return "所需赞成票必须是 1 至 10 的整数。";
  if (
    rules.eligibleReviewerIds.length > 32 ||
    new Set(rules.eligibleReviewerIds).size !== rules.eligibleReviewerIds.length
  )
    return "指定签审人最多 32 位，且不能重复。";
  if (
    rules.eligibleRoles.length < 1 ||
    rules.eligibleRoles.some(
      (role) => !["owner", "admin", "member"].includes(role),
    )
  )
    return "至少选择一种允许签审的团队角色。";
  if (
    !Number.isSafeInteger(rules.expirySeconds) ||
    rules.expirySeconds < 0 ||
    rules.expirySeconds > 604800
  )
    return "有效期必须是 0 至 604800 秒的整数，0 表示不自动过期。";
  return null;
}
export function signoffUserLabel(members: SignoffMember[], userId: string) {
  const member = members.find((item) => item.userId === userId);
  return member?.name ? `${member.name} (${userId})` : userId;
}
export function signoffUTC(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "未知时间";
}
export function signoffExpiry(vote: SignoffVote, policy: SignoffPolicy) {
  if (vote.policyHash !== policy.hash) return "旧策略票据，当前策略下无效";
  if (policy.expirySeconds === 0) return "无自动过期";
  const created = Date.parse(vote.createdAt);
  const expiry = new Date(created + policy.expirySeconds * 1000);
  return Number.isFinite(expiry.getTime())
    ? expiry.toISOString()
    : "未知有效期";
}

export const SIGNOFF_REASON_LABELS: Record<SignoffVoteReason, string> = {
  counted: "当前计入赞成票",
  withdrawn: "已撤回",
  policy_changed: "策略版本已改变",
  artifact_changed: "产物或验收证据已改变",
  future_timestamp: "票据时间晚于评估时间",
  expired: "票据已过期",
  inactive_member: "签审人已不是当前有效成员",
  ineligible_member: "签审人不符合当前策略",
  duplicate_reviewer: "同一签审人已有有效票",
  rejected: "有效否决票",
  invalid_decision: "未知投票结果",
};
