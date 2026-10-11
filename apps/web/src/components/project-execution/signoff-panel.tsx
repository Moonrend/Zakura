"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useMeOptional } from "@/components/me-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  friendlyError,
  getMerges,
  getRuns,
  type MergePreview,
  type Project,
  type Run,
} from "@/lib/project-execution";
import {
  getSignoffPolicy,
  getSignoffPolicyHistory,
  getSignoffs,
  saveSignoffPolicy,
  signoffActorReason,
  signoffExpiry,
  signoffHumanReason,
  signoffRules,
  signoffRulesError,
  signoffTarget,
  signoffUTC,
  signoffUserLabel,
  SIGNOFF_REASON_LABELS,
  voteSignoff,
  withdrawSignoff,
  type SignoffEvidence,
  type SignoffMember,
  type SignoffPolicy,
  type SignoffPolicyContext,
  type SignoffRecord,
  type SignoffRole,
  type SignoffRules,
  type SignoffTarget,
  type SignoffVote,
} from "@/lib/project-signoff";
import {
  Code,
  ErrorNotice,
  Field,
  NativeSelect,
  Panel,
  Status,
} from "./shared";

const roles: { id: SignoffRole; label: string }[] = [
  { id: "owner", label: "所有者" },
  { id: "admin", label: "管理员" },
  { id: "member", label: "成员" },
];

function PolicyEditor({
  context,
  editable,
  busy,
  onSave,
}: {
  context: SignoffPolicyContext;
  editable: boolean;
  busy: boolean;
  onSave: (policy: SignoffPolicy, draft: SignoffRules) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => signoffRules(context.policy));
  const [acknowledged, setAcknowledged] = useState(false);
  const [memberQuery, setMemberQuery] = useState("");
  const update = (value: SignoffRules) => {
    setDraft(value);
    setAcknowledged(false);
  };
  const validation = signoffRulesError(draft);
  const absentIds = draft.eligibleReviewerIds.filter(
    (id) => !context.members.some((member) => member.userId === id),
  );
  const displayed = context.members.filter((member) =>
    `${member.userId} ${member.name} ${member.role}`
      .toLocaleLowerCase()
      .includes(memberQuery.toLocaleLowerCase()),
  );
  return (
    <div className="space-y-4">
      <p className="break-all text-sm text-muted-foreground">
        策略版本 {context.policy.revision} ·{" "}
        {context.policy.configured ? "已配置" : "默认策略"}
        <br />
        哈希 {context.policy.hash}
        {context.policy.updatedAt && (
          <> · 更新时间 {signoffUTC(context.policy.updatedAt)}</>
        )}
      </p>
      {!editable && (
        <p className="text-sm">
          只有当前团队的所有者或管理员真人会话可以修改策略。
        </p>
      )}
      <fieldset disabled={!editable || busy} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="所需独立赞成票"
            hint="1 至 10 人；每人最多计入一张有效赞成票。"
          >
            <Input
              type="number"
              min={1}
              max={10}
              step={1}
              value={Number.isNaN(draft.minApprovals) ? "" : draft.minApprovals}
              onChange={(e) =>
                update({
                  ...draft,
                  minApprovals:
                    e.target.value === "" ? NaN : Number(e.target.value),
                })
              }
            />
          </Field>
          <Field
            label="票据有效期（秒）"
            hint="0 表示不自动过期，最长 7 天；发布前还会再次核对有效性。"
          >
            <Input
              type="number"
              min={0}
              max={604800}
              step={1}
              value={
                Number.isNaN(draft.expirySeconds) ? "" : draft.expirySeconds
              }
              onChange={(e) =>
                update({
                  ...draft,
                  expirySeconds:
                    e.target.value === "" ? NaN : Number(e.target.value),
                })
              }
            />
          </Field>
        </div>
        <div className="flex flex-wrap gap-4">
          {roles.map((role) => (
            <label key={role.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.eligibleRoles.includes(role.id)}
                onChange={(e) =>
                  update({
                    ...draft,
                    eligibleRoles: e.target.checked
                      ? [...draft.eligibleRoles, role.id]
                      : draft.eligibleRoles.filter((item) => item !== role.id),
                  })
                }
              />
              允许{role.label}签审
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.disallowProjectCreator}
              onChange={(e) =>
                update({ ...draft, disallowProjectCreator: e.target.checked })
              }
            />
            禁止项目创建者签审自己的项目
          </label>
        </div>
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-sm font-medium">
            指定签审人（已选 {draft.eligibleReviewerIds.length}/32）
          </p>
          <p className="text-xs text-muted-foreground">
            未选任何人表示允许全部符合所选角色的当前有效成员。指定名单与角色规则同时生效。
          </p>
          <Field label="筛选当前团队成员">
            <Input
              value={memberQuery}
              onChange={(e) => setMemberQuery(e.target.value)}
              placeholder="姓名、成员 ID 或角色"
            />
          </Field>
          {context.membersTruncated && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              成员列表仅包含按 ID 排序的前 500
              位有效成员；未显示成员不能通过此列表新增。已有指定 ID
              会保留，服务端以完整名单判断。
            </p>
          )}
          <div className="max-h-56 space-y-2 overflow-auto">
            {displayed.map((member) => (
              <label
                key={member.userId}
                className="flex items-start gap-2 break-all text-sm"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={draft.eligibleReviewerIds.includes(member.userId)}
                  disabled={
                    !editable ||
                    busy ||
                    (!draft.eligibleReviewerIds.includes(member.userId) &&
                      draft.eligibleReviewerIds.length >= 32)
                  }
                  onChange={(e) =>
                    update({
                      ...draft,
                      eligibleReviewerIds: e.target.checked
                        ? [...draft.eligibleReviewerIds, member.userId]
                        : draft.eligibleReviewerIds.filter(
                            (id) => id !== member.userId,
                          ),
                    })
                  }
                />
                <span>
                  {signoffUserLabel(context.members, member.userId)} ·{" "}
                  {member.role}
                </span>
              </label>
            ))}
            {displayed.length === 0 && (
              <p className="text-sm text-muted-foreground">
                当前返回的成员列表中没有匹配项。
              </p>
            )}
          </div>
          {absentIds.length > 0 && (
            <div className="space-y-2 border-t pt-2">
              <p className="text-xs text-muted-foreground">
                以下已配置 ID
                不在返回名单中，可能因列表截断或成员状态变化；保持原选择，或明确移除。
              </p>
              {absentIds.map((id) => (
                <div
                  key={id}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span className="break-all">{id}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      update({
                        ...draft,
                        eligibleReviewerIds: draft.eligibleReviewerIds.filter(
                          (item) => item !== id,
                        ),
                      })
                    }
                  >
                    移除
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            确认按策略版本 {context.policy.revision} 保存；所有尚未发布且为
            ready/approved
            的预览都会更新版本、清空批准凭据并回到待签审。历史投票仍保留。
          </span>
        </label>
        <Button
          type="button"
          disabled={!acknowledged || !!validation || !editable || busy}
          onClick={() => {
            setAcknowledged(false);
            void onSave(context.policy, signoffRules(draft));
          }}
        >
          保存签审策略
        </Button>
      </fieldset>
      <ErrorNotice message={validation} />
    </div>
  );
}

export function SignoffProof({
  evidence,
  members,
}: {
  evidence: SignoffEvidence;
  members: SignoffMember[];
}) {
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm">
      <p className="font-medium">
        聚合签审凭据 · 策略版本 {evidence.policyRevision} · 所需{" "}
        {evidence.required} 人
      </p>
      <p className="break-all">
        策略哈希 {evidence.policyHash}
        <br />
        预览 {evidence.binding.previewId}
        <br />
        运行 {evidence.binding.runId}
        <br />
        快照 {evidence.binding.snapshotId}
        <br />
        验收证据哈希 {evidence.binding.evidenceHash}
      </p>
      <ul className="space-y-2">
        {evidence.participants.map((participant) => (
          <li key={participant.voteId} className="break-all">
            {signoffUserLabel(members, participant.userId)} · 票据{" "}
            {participant.voteId}
            <br />
            {signoffUTC(participant.createdAt)} · 快照 {participant.snapshotId}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        交付清单可保留这份参与者来源信息。导入的来源元数据不构成当前项目的授权；正式发布仍需服务端重新检查当前策略、成员和有效期。
      </p>
    </div>
  );
}

function VoteControls({
  record,
  context,
  currentUserId,
  creator,
  busy,
  policyCurrent,
  onVote,
  onWithdraw,
}: {
  record: SignoffRecord;
  context: SignoffPolicyContext;
  currentUserId: string | undefined;
  creator: string;
  busy: boolean;
  policyCurrent: boolean;
  onVote: (
    target: SignoffTarget,
    decision: SignoffVote["decision"],
    comment: string,
  ) => Promise<void>;
  onWithdraw: (target: SignoffTarget, voteId: string) => Promise<void>;
}) {
  const [decision, setDecision] = useState<SignoffVote["decision"]>("approved");
  const [comment, setComment] = useState("");
  const [confirmed, setConfirmed] = useState<SignoffTarget | null>(null);
  const [withdrawal, setWithdrawal] = useState<{
    target: SignoffTarget;
    voteId: string;
  } | null>(null);
  const { preview, summary } = record;
  let target: SignoffTarget | null = null;
  let bindingError: string | null = null;
  try {
    target = signoffTarget(record);
  } catch (error) {
    bindingError = friendlyError(error);
  }
  const reason = signoffActorReason(
    context,
    currentUserId,
    summary.policy,
    creator,
  );
  const mutable = ["ready", "approved"].includes(preview.status);
  const withdrawalAllowed =
    !busy &&
    !signoffHumanReason(context, currentUserId) &&
    mutable &&
    policyCurrent &&
    !!target;
  const allowed = withdrawalAllowed && !reason && summary.canReachQuorum;
  const commentBytes = new TextEncoder().encode(comment).length;
  const commentValid = comment.trim().length > 0 && commentBytes <= 16000;
  const matchesBinding = (vote: SignoffVote) =>
    vote.binding.previewId === summary.binding.previewId &&
    vote.binding.runId === summary.binding.runId &&
    vote.binding.snapshotId === summary.binding.snapshotId &&
    vote.binding.evidenceHash === summary.binding.evidenceHash;
  const ownActiveVote = summary.votes.some(
    (vote) =>
      vote.userId === currentUserId &&
      vote.status === "active" &&
      vote.policyHash === summary.policy.hash &&
      matchesBinding(vote),
  );
  return (
    <div className="space-y-4">
      {summary.legacyApproval && (
        <p className="rounded-lg border p-3 text-sm">
          此预览保留旧版单人审批；只有原审批人仍符合当前成员规则时才计入。
          没有独立签审票据、签名时间或聚合参与者凭据。配置策略后需重新签审。
        </p>
      )}
      <div className="rounded-lg bg-muted/50 p-3 text-sm">
        <p>
          {summary.legacyApproval ? "当前计入旧版审批" : "当前计入独立赞成票"}{" "}
          {summary.approvals}/{summary.required} · 符合当前策略的有效成员{" "}
          {summary.eligibleCount} 人
        </p>
        <p>
          {summary.rejected
            ? "有有效否决票，预览已拒绝。需要创建新预览重新签审。"
            : summary.quorum
              ? "当前评估已达到签审票数；最终发布会重新检查。"
              : "当前未达到签审票数。一张赞成票不会绕过多人签审要求。"}
        </p>
        {!summary.canReachQuorum && (
          <p className="text-amber-700 dark:text-amber-400">
            当前符合策略的人数不足，无法达到所需票数；请管理员核对角色、名单及项目创建者限制。
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          服务端评估时间 {signoffUTC(summary.evaluatedAt)}
          ；票据有效性会随时间、成员和策略变化，请在操作前刷新。
        </p>
      </div>
      <ErrorNotice message={bindingError} />
      {!policyCurrent && (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
          策略与该预览评估版本不一致，请刷新并重新核对。
        </p>
      )}
      {reason && <p className="text-sm text-muted-foreground">{reason}</p>}
      {!mutable && (
        <p className="text-sm text-muted-foreground">
          预览状态 {preview.status}{" "}
          不允许投票或撤票。执行中、已发布和结果未知的预览必须保留效果历史。
        </p>
      )}
      <div className="space-y-3 rounded-lg border p-3">
        <p className="break-all text-xs text-muted-foreground">
          预览 {preview.id} · 版本 {preview.revision}
          <br />
          快照 {summary.binding.snapshotId}
          <br />
          策略版本 {summary.policy.revision} · 哈希 {summary.policy.hash}
        </p>
        <fieldset disabled={!allowed} className="space-y-3">
          <Field label="我的签审结论">
            <NativeSelect
              value={decision}
              onChange={(e) => {
                setDecision(e.target.value as SignoffVote["decision"]);
                setConfirmed(null);
              }}
            >
              <option value="approved">赞成</option>
              <option value="rejected">否决（此预览不可重新批准）</option>
            </NativeSelect>
          </Field>
          <Field
            label="签审理由"
            hint={`必须填写，按 UTF-8 计 ${commentBytes}/16000 字节。请说明核对了哪些验收和产物。`}
          >
            <Textarea
              rows={3}
              value={comment}
              onChange={(e) => {
                setComment(e.target.value);
                setConfirmed(null);
              }}
            />
          </Field>
          {ownActiveVote && (
            <p className="text-sm text-muted-foreground">
              你已有尚未撤回、绑定当前策略和产物的票；过期票也需要先撤回，再刷新后重新签审。
            </p>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={!!confirmed}
              onChange={(e) => setConfirmed(e.target.checked ? target : null)}
            />
            <span>
              我已核对上述确切预览版本、不可变快照和策略哈希，确认提交
              {decision === "approved" ? "赞成" : "否决"}票。
              {decision === "rejected" && "否决会永久拒绝此预览。"}
            </span>
          </label>
          <Button
            type="button"
            disabled={!allowed || !confirmed || !commentValid || ownActiveVote}
            onClick={() => {
              if (confirmed) {
                const captured = confirmed;
                setConfirmed(null);
                void onVote(captured, decision, comment);
              }
            }}
          >
            提交我的签审票
          </Button>
        </fieldset>
      </div>
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">投票历史与当前有效性</h3>
        {summary.votes.length === 0 && (
          <p className="text-sm text-muted-foreground">还没有投票记录。</p>
        )}
        {summary.votes.map((vote) => (
          <article
            key={vote.id}
            className="space-y-2 rounded-lg border p-3 text-sm"
          >
            <p className="break-all font-medium">
              {signoffUserLabel(context.members, vote.userId)} ·{" "}
              {vote.decision === "approved" ? "赞成" : "否决"} ·{" "}
              {SIGNOFF_REASON_LABELS[vote.reason] ?? vote.reason}
            </p>
            <p className="whitespace-pre-wrap break-words">{vote.comment}</p>
            <p className="break-all text-xs text-muted-foreground">
              票据 {vote.id} · 序号 {vote.sequence} · 当时角色 {vote.role}
              <br />
              投票时间 {signoffUTC(vote.createdAt)} · UTC 截止{" "}
              {signoffExpiry(vote, summary.policy)}
              <br />
              策略版本 {vote.policyRevision} · 预览版本 {vote.previewRevision} ·
              快照 {vote.binding.snapshotId}
              {vote.withdrawnAt && (
                <>
                  <br />
                  撤回时间 {signoffUTC(vote.withdrawnAt)}
                </>
              )}
            </p>
            {vote.userId === currentUserId &&
              vote.status === "active" &&
              matchesBinding(vote) && (
                <div className="space-y-2">
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1"
                      disabled={!withdrawalAllowed}
                      checked={withdrawal?.voteId === vote.id}
                      onChange={(e) =>
                        setWithdrawal(
                          e.target.checked && target
                            ? { voteId: vote.id, target }
                            : null,
                        )
                      }
                    />
                    <span>
                      确认仅撤回我的票据 {vote.id}；按当前预览版本{" "}
                      {preview.revision}
                      、快照和策略执行。失去足够赞成票会清空批准凭据。
                    </span>
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      !withdrawalAllowed || withdrawal?.voteId !== vote.id
                    }
                    onClick={() => {
                      if (withdrawal?.voteId === vote.id) {
                        const captured = withdrawal;
                        setWithdrawal(null);
                        void onWithdraw(captured.target, captured.voteId);
                      }
                    }}
                  >
                    撤回这张票
                  </Button>
                </div>
              )}
          </article>
        ))}
      </div>
      {summary.evidence ? (
        <SignoffProof evidence={summary.evidence} members={context.members} />
      ) : (
        <p className="text-sm text-muted-foreground">
          当前评估没有有效的聚合批准凭据。
        </p>
      )}
      {!summary.evidence && preview.reviewEvidence && (
        <details className="text-sm">
          <summary className="cursor-pointer">
            预览中保留的历史凭据（不代表当前有效批准）
          </summary>
          <SignoffProof
            evidence={preview.reviewEvidence}
            members={context.members}
          />
        </details>
      )}
    </div>
  );
}

export function SignoffPanel({ project }: { project: Project }) {
  return <SignoffWorkbench key={project.id} project={project} />;
}

function SignoffWorkbench({ project }: { project: Project }) {
  const me = useMeOptional();
  const mounted = useRef(true);
  const contextRequest = useRef(0);
  const [context, setContext] = useState<SignoffPolicyContext | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState("");
  const [previews, setPreviews] = useState<MergePreview[]>([]);
  const [previewId, setPreviewId] = useState("");
  const [record, setRecord] = useState<SignoffRecord | null>(null);
  const [history, setHistory] = useState<SignoffPolicy[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [contextLoading, setContextLoading] = useState(true);
  const [mergesLoading, setMergesLoading] = useState(false);
  const [recordLoading, setRecordLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const request = ++contextRequest.current;
    setContextLoading(true);
    setRecord(null);
    setHistory(null);
    setError(null);
    try {
      const [fresh, runList] = await Promise.all([
        getSignoffPolicy(project.id),
        getRuns(project.id),
      ]);
      if (!mounted.current || request !== contextRequest.current) return;
      setContext(fresh);
      setRuns(runList.items);
      setRunId((selected) =>
        runList.items.some((run) => run.id === selected)
          ? selected
          : (runList.items[0]?.id ?? ""),
      );
      setRefreshEpoch((epoch) => epoch + 1);
    } catch (cause) {
      if (mounted.current && request === contextRequest.current) {
        setContext(null);
        setError(friendlyError(cause));
      }
    } finally {
      if (mounted.current && request === contextRequest.current)
        setContextLoading(false);
    }
  }, [project.id]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      contextRequest.current++;
    };
  }, [refresh]);
  useEffect(() => {
    let alive = true;
    setRecord(null);
    if (!runId) {
      setPreviews([]);
      setPreviewId("");
      setMergesLoading(false);
      return;
    }
    setMergesLoading(true);
    void getMerges(project.id, runId)
      .then((result) => {
        if (!alive) return;
        setPreviews(result.items);
        setPreviewId((selected) =>
          result.items.some((preview) => preview.id === selected)
            ? selected
            : (result.items[0]?.id ?? ""),
        );
      })
      .catch((cause) => {
        if (alive) {
          setPreviews([]);
          setPreviewId("");
          setError(friendlyError(cause));
        }
      })
      .finally(() => {
        if (alive) setMergesLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [project.id, runId, refreshEpoch]);
  useEffect(() => {
    let alive = true;
    setRecord(null);
    setRecordLoading(false);
    if (!runId || !previewId || mergesLoading || contextLoading) return;
    setRecordLoading(true);
    void getSignoffs(project.id, runId, previewId)
      .then((result) => {
        if (!alive) return;
        if (
          result.preview.projectId !== project.id ||
          result.preview.runId !== runId ||
          result.preview.id !== previewId
        )
          throw new Error("签审响应与所选项目、运行或预览不一致，请刷新。");
        setRecord(result);
      })
      .catch((cause) => {
        if (alive) setError(friendlyError(cause));
      })
      .finally(() => {
        if (alive) setRecordLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [
    project.id,
    runId,
    previewId,
    refreshEpoch,
    mergesLoading,
    contextLoading,
  ]);
  const busy = mutating || contextLoading || mergesLoading || recordLoading;
  const localUserId = me?.user?.id;
  const configure =
    !!context &&
    !!localUserId &&
    localUserId === context.currentUserId &&
    context.humanSession &&
    context.canConfigure &&
    ["owner", "admin"].includes(context.currentRole);
  const mutate = async (action: () => Promise<string>) => {
    if (mutating) return;
    setMutating(true);
    setError(null);
    setMessage(null);
    try {
      const result = await action();
      if (!mounted.current) return;
      setMessage(result);
      await refresh();
    } catch (cause) {
      if (mounted.current) {
        setRecord(null);
        setContext(null);
        setError(
          `${friendlyError(cause)}\n操作没有自动重试。请刷新当前状态、重新核对确切版本，再重新确认；响应丢失时也请先查投票历史。`,
        );
      }
    } finally {
      if (mounted.current) setMutating(false);
    }
  };
  return (
    <div className="space-y-4">
      <Panel
        title="多人签审"
        description="对合并后的不可变快照进行独立人工签审；策略、票据和参与者证据由当前项目服务端保存。"
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void refresh()}
          >
            刷新成员与策略（重置未保存编辑）
          </Button>
        }
      >
        <div className="space-y-3">
          <ErrorNotice message={error} />
          {message && (
            <p role="status" className="text-sm">
              {message}
            </p>
          )}
          {contextLoading && (
            <p className="text-sm text-muted-foreground">
              正在读取当前团队策略和运行…
            </p>
          )}
          {context && (
            <>
              <PolicyEditor
                key={`${refreshEpoch}:${context.policy.hash}`}
                context={context}
                editable={configure}
                busy={busy}
                onSave={async (current, draft) => {
                  if (!configure || signoffRulesError(draft)) return;
                  await mutate(async () => {
                    const saved = await saveSignoffPolicy(
                      project.id,
                      current,
                      draft,
                    );
                    return `已保存策略版本 ${saved.policy.revision}，${saved.resetPreviews} 个未发布预览已失效并回到待签审。`;
                  });
                }}
              />
              <details className="rounded-lg border p-3 text-sm">
                <summary className="cursor-pointer">
                  策略历史（最多最近 100 个版本）
                </summary>
                <div className="mt-3 space-y-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy || historyLoading}
                    onClick={() => {
                      setHistoryLoading(true);
                      void getSignoffPolicyHistory(project.id)
                        .then((items) => {
                          if (mounted.current) setHistory(items);
                        })
                        .catch((cause) => {
                          if (mounted.current) setError(friendlyError(cause));
                        })
                        .finally(() => {
                          if (mounted.current) setHistoryLoading(false);
                        });
                    }}
                  >
                    {historyLoading ? "读取中…" : "读取真实策略历史"}
                  </Button>
                  {history?.length === 0 && (
                    <p>尚无已配置策略版本，当前使用默认策略。</p>
                  )}
                  {history?.map((policy) => (
                    <details key={policy.revision}>
                      <summary className="cursor-pointer break-all">
                        版本 {policy.revision} ·{" "}
                        {policy.updatedAt
                          ? signoffUTC(policy.updatedAt)
                          : "未知时间"}{" "}
                        · 修改者 {policy.updatedBy ?? "未知"}
                      </summary>
                      <Code value={policy} />
                    </details>
                  ))}
                </div>
              </details>
            </>
          )}
        </div>
      </Panel>
      <Panel
        title="预览签审票据"
        description="先在合并工作台创建并完成验收的预览，再选择本页的真实运行与预览。"
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="运行">
              <NativeSelect
                value={runId}
                disabled={busy || !context}
                onChange={(e) => {
                  setRecord(null);
                  setPreviewId("");
                  setPreviews([]);
                  setRunId(e.target.value);
                  setError(null);
                  setMessage(null);
                }}
              >
                <option value="">选择运行</option>
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.id} · {run.status}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="合并预览">
              <NativeSelect
                value={previewId}
                disabled={busy || !context || !runId}
                onChange={(e) => {
                  setRecord(null);
                  setPreviewId(e.target.value);
                  setError(null);
                  setMessage(null);
                }}
              >
                <option value="">选择预览</option>
                {previews.map((preview) => (
                  <option key={preview.id} value={preview.id}>
                    {preview.id} · {preview.status} · 版本 {preview.revision}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          {mergesLoading && (
            <p className="text-sm text-muted-foreground">
              正在读取该运行的预览…
            </p>
          )}
          {recordLoading && (
            <p className="text-sm text-muted-foreground">
              正在核对当前预览及签审有效性…
            </p>
          )}
          {!busy && context && runs.length === 0 && (
            <p className="text-sm text-muted-foreground">项目还没有运行。</p>
          )}
          {!busy && context && runId && previews.length === 0 && (
            <p className="text-sm text-muted-foreground">
              此运行还没有合并预览。请在合并工作台创建。
            </p>
          )}
          {record && context && (
            <>
              <div className="flex items-center gap-2 text-sm">
                <Status value={record.preview.status} />
                <span>预览版本 {record.preview.revision}</span>
              </div>
              <VoteControls
                key={`${refreshEpoch}:${record.preview.id}:${record.preview.revision}:${record.summary.policy.hash}`}
                record={record}
                context={context}
                currentUserId={localUserId}
                creator={project.createdBy}
                busy={busy}
                policyCurrent={
                  record.summary.policy.hash === context.policy.hash &&
                  record.summary.policy.revision === context.policy.revision
                }
                onVote={async (target, decision, comment) => {
                  await mutate(async () => {
                    const saved = await voteSignoff(
                      project.id,
                      target,
                      decision,
                      comment,
                    );
                    return `已记录你的${decision === "approved" ? "赞成" : "否决"}票，预览当前为 ${saved.status}（版本 ${saved.revision}）。`;
                  });
                }}
                onWithdraw={async (target, voteId) => {
                  await mutate(async () => {
                    const saved = await withdrawSignoff(
                      project.id,
                      target,
                      voteId,
                    );
                    return `已撤回票据 ${voteId}，预览当前为 ${saved.status}（版本 ${saved.revision}）。`;
                  });
                }}
              />
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}
