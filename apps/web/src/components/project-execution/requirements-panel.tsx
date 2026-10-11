"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMeOptional } from "@/components/me-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  friendlyError,
  getRuns,
  type Project,
  type Run,
} from "@/lib/project-execution";
import {
  bindRequirements,
  getRequirements,
  listRequirements,
  requirementsAnalysis,
  requirementsDraftError,
  requirementsHistory,
  requirementsRunCoverage,
  requirementStatusLabel,
  retireRequirements,
  reviewRequirements,
  saveRequirements,
  type RequirementClause,
  type RequirementsAnalysis,
  type RequirementsBaseline,
  type RequirementsCoverage,
  type RequirementsDraft,
  type RequirementsRevision,
  type RequirementsRunBinding,
} from "@/lib/project-requirements";
import { ErrorNotice, Field, NativeSelect, Panel, Status } from "./shared";

const newClause = (index: number): RequirementClause => ({
  id: `REQ-${index}`,
  kind: "functional",
  title: "",
  description: "",
  required: true,
  bindings: [],
});
const newDraft = (): RequirementsDraft => ({
  title: "",
  clauses: [newClause(1)],
  requiredBeforePublication: true,
});
function asDraft(baseline: RequirementsBaseline): RequirementsDraft {
  return {
    title: baseline.title,
    requiredBeforePublication: baseline.requiredBeforePublication,
    clauses: baseline.clauses.map((clause) => ({
      ...clause,
      bindings: clause.bindings.map((binding) => ({ ...binding })),
    })),
  };
}

function ClauseEditor({
  clause,
  project,
  onChange,
  onDelete,
}: {
  clause: RequirementClause;
  project: Project;
  onChange: (value: RequirementClause) => void;
  onDelete: () => void;
}) {
  return (
    <article className="space-y-3 rounded-lg border p-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="条款 ID">
          <Input
            value={clause.id}
            onChange={(e) => onChange({ ...clause, id: e.target.value })}
          />
        </Field>
        <Field label="条款类型">
          <NativeSelect
            value={clause.kind}
            onChange={(e) =>
              onChange({
                ...clause,
                kind: e.target.value as RequirementClause["kind"],
              })
            }
          >
            <option value="functional">功能要求</option>
            <option value="nonfunctional">性能与质量要求</option>
            <option value="constraint">实现约束</option>
          </NativeSelect>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={clause.required}
            onChange={(e) =>
              onChange({ ...clause, required: e.target.checked })
            }
          />
          必需条款
        </label>
      </div>
      <Field label="需求标题">
        <Input
          value={clause.title}
          onChange={(e) => onChange({ ...clause, title: e.target.value })}
        />
      </Field>
      <Field
        label="需求说明"
        hint="写清行为或指标；检查是否能证明这条需求仍需要签审人核对。"
      >
        <Textarea
          rows={3}
          value={clause.description}
          onChange={(e) => onChange({ ...clause, description: e.target.value })}
        />
      </Field>
      <div className="space-y-2">
        <p className="text-sm font-medium">对应的任务验收检查</p>
        {clause.bindings.map((binding, index) => {
          const task = project.plan.tasks.find(
            (item) => item.id === binding.taskSpecId,
          );
          const change = (value: typeof binding) =>
            onChange({
              ...clause,
              bindings: clause.bindings.map((item, i) =>
                i === index ? value : item,
              ),
            });
          return (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Field label={`映射 ${index + 1} 任务`}>
                <NativeSelect
                  value={binding.taskSpecId}
                  onChange={(e) => {
                    const next = project.plan.tasks.find(
                      (item) => item.id === e.target.value,
                    );
                    change({
                      taskSpecId: e.target.value,
                      checkId: next?.checks[0]?.id ?? "",
                    });
                  }}
                >
                  <option value="">选择任务</option>
                  {!task && binding.taskSpecId && (
                    <option value={binding.taskSpecId}>
                      已移除：{binding.taskSpecId}
                    </option>
                  )}
                  {project.plan.tasks.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title} · {item.id}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label={`映射 ${index + 1} 验收`}>
                <NativeSelect
                  value={binding.checkId}
                  onChange={(e) =>
                    change({ ...binding, checkId: e.target.value })
                  }
                >
                  <option value="">选择检查</option>
                  {binding.checkId &&
                    !task?.checks.some(
                      (check) => check.id === binding.checkId,
                    ) && (
                      <option value={binding.checkId}>
                        已移除：{binding.checkId}
                      </option>
                    )}
                  {task?.checks.map((check) => (
                    <option key={check.id} value={check.id}>
                      {check.title || check.id} · {check.kind}
                      {check.required ? "" : "（任务可选）"}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Button
                variant="ghost"
                size="sm"
                className="self-end"
                onClick={() =>
                  onChange({
                    ...clause,
                    bindings: clause.bindings.filter((_, i) => i !== index),
                  })
                }
              >
                移除映射
              </Button>
            </div>
          );
        })}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              onChange({
                ...clause,
                bindings: [...clause.bindings, { taskSpecId: "", checkId: "" }],
              })
            }
          >
            添加验收映射
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete}>
            删除条款
          </Button>
        </div>
      </div>
    </article>
  );
}

export function RequirementsPanel({
  project,
  initialId,
}: {
  project: Project;
  initialId?: string;
}) {
  const me = useMeOptional();
  const writable = Boolean(
    me && ["owner", "admin", "member"].includes(me.role ?? ""),
  );
  const human = writable && Boolean(me?.user?.id);
  const [items, setItems] = useState<RequirementsBaseline[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [retired, setRetired] = useState(false);
  const [current, setCurrent] = useState<RequirementsBaseline>();
  const [historical, setHistorical] = useState(false);
  const [draft, setDraft] = useState<RequirementsDraft>();
  const [history, setHistory] = useState<RequirementsRevision[]>([]);
  const [analysis, setAnalysis] = useState<RequirementsAnalysis>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState("");
  const [binding, setBinding] = useState<RequirementsRunBinding | null>(null);
  const [coverage, setCoverage] = useState<RequirementsCoverage>();
  const [comment, setComment] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const result = await listRequirements(project.id, undefined, retired);
    setItems(result.items);
    setCursor(result.nextCursor);
  }, [project.id, retired]);
  useEffect(() => {
    let alive = true;
    void Promise.all([
      listRequirements(project.id, undefined, retired),
      getRuns(project.id),
    ])
      .then(([result, runList]) => {
        if (!alive) return;
        setItems(result.items);
        setCursor(result.nextCursor);
        setRuns(runList.items);
      })
      .catch((e) => alive && setError(friendlyError(e)));
    return () => {
      alive = false;
      generation.current++;
    };
  }, [project.id, retired]);
  const reloadCoverage = useCallback(async () => {
    if (!runId) {
      setBinding(null);
      setCoverage(undefined);
      return;
    }
    const result = await requirementsRunCoverage(project.id, runId);
    setBinding(result.binding);
    setCoverage(result.coverage);
  }, [project.id, runId]);
  useEffect(() => {
    let alive = true;
    setCoverage(undefined);
    setBinding(null);
    if (!runId) return;
    const load = () =>
      requirementsRunCoverage(project.id, runId)
        .then((result) => {
          if (alive) {
            setBinding(result.binding);
            setCoverage(result.coverage);
          }
        })
        .catch((e) => alive && setError(friendlyError(e)));
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [project.id, runId]);
  const open = useCallback(
    async (id: string, revision?: number) => {
      const mine = ++generation.current;
      const [baseline, revisions, result] = await Promise.all([
        getRequirements(project.id, id, revision),
        requirementsHistory(project.id, id),
        requirementsAnalysis(project.id, id),
      ]);
      if (mine !== generation.current) return;
      setCurrent(baseline);
      setHistory(revisions.items);
      setAnalysis(result);
      setHistorical(Boolean(revision));
      setDraft(undefined);
      setComment("");
      setConfirmed(false);
    },
    [project.id],
  );
  useEffect(() => {
    if (!initialId) return;
    void open(initialId).catch((e) => setError(friendlyError(e)));
  }, [open, initialId]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(async () => {
      if (!draft) return;
      const problem = requirementsDraftError(draft);
      if (problem) throw new Error(problem);
      const saved = await saveRequirements(project.id, draft, current, comment);
      await reload();
      await open(saved.id);
    });
  const review = (decision: "approved" | "rejected") =>
    act(async () => {
      if (!current) return;
      const saved = await reviewRequirements(
        project.id,
        current,
        project.revision,
        decision,
        comment,
      );
      await reload();
      await open(saved.id);
    });
  return (
    <div className="space-y-4">
      <ErrorNotice message={error} />
      <Panel
        title="需求与验收追溯"
        description="把需求条款映射到明确的任务检查，签审后按每次运行的真实验收与人工审批追踪。绑定为发布门槛时，还会要求最终合并产物通过这些检查。"
        actions={
          writable && (
            <Button
              disabled={busy}
              onClick={() => {
                generation.current++;
                setCurrent(undefined);
                setHistory([]);
                setAnalysis(undefined);
                setHistorical(false);
                setDraft(newDraft());
                setComment("");
                setConfirmed(false);
              }}
            >
              新增需求基线
            </Button>
          )
        }
      >
        <label className="mb-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={retired}
            onChange={(e) => setRetired(e.target.checked)}
          />
          显示已归档与删除的基线
        </label>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={busy}
              onClick={() => void act(() => open(item.id))}
              className={`rounded-lg border p-3 text-left hover:bg-muted ${current?.id === item.id ? "border-primary" : ""}`}
            >
              <span className="font-medium">{item.title}</span>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                <Status value={item.status} />
                <span>
                  v{item.revision} · {item.clauses.length} 条款
                </span>
                <span>
                  {item.requiredBeforePublication
                    ? "启用绑定运行的发布门槛"
                    : "仅追踪"}
                </span>
              </div>
            </button>
          ))}
        </div>
        {items.length === 0 && (
          <p className="text-sm text-muted-foreground">
            尚无需求基线。未绑定基线的运行沿用现有发布流程。
          </p>
        )}
        {cursor && (
          <Button
            className="mt-3"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const next = await listRequirements(
                  project.id,
                  cursor,
                  retired,
                );
                setItems((old) => [...old, ...next.items]);
                setCursor(next.nextCursor);
              })
            }
          >
            加载更多基线
          </Button>
        )}
      </Panel>
      {draft && (
        <Panel
          title={current ? "编辑需求基线" : "新建需求基线"}
          description="保存会清除当前版本的签审；已有运行仍固定使用其绑定的旧版本。"
        >
          <div className="space-y-4">
            <Field label="基线名称">
              <Input
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.requiredBeforePublication}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    requiredBeforePublication: e.target.checked,
                  })
                }
              />
              绑定后的运行必须满足必需条款才能发布
            </label>
            {draft.clauses.map((clause, index) => (
              <ClauseEditor
                key={index}
                clause={clause}
                project={project}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    clauses: draft.clauses.map((item, i) =>
                      i === index ? value : item,
                    ),
                  })
                }
                onDelete={() =>
                  setDraft({
                    ...draft,
                    clauses: draft.clauses.filter((_, i) => i !== index),
                  })
                }
              />
            ))}
            <Button
              variant="outline"
              onClick={() => {
                let index = draft.clauses.length + 1;
                while (draft.clauses.some((item) => item.id === `REQ-${index}`))
                  index++;
                setDraft({
                  ...draft,
                  clauses: [...draft.clauses, newClause(index)],
                });
              }}
            >
              添加需求条款
            </Button>
            <Field label="修改说明">
              <Textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <Button disabled={busy || !writable} onClick={() => void save()}>
                保存草案
              </Button>
              <Button variant="ghost" onClick={() => setDraft(undefined)}>
                取消编辑
              </Button>
            </div>
          </div>
        </Panel>
      )}
      {current && !draft && (
        <Panel
          title={`${current.title} · v${current.revision}${historical ? " · 历史版本" : ""}`}
          description={`状态：${current.status}。${current.approvedBy ? `签审人 ${current.approvedBy}；计划摘要 ${current.approvedPlanHash?.slice(0, 16)}。` : "尚未签审。"}`}
          actions={
            writable &&
            !historical &&
            !["archived", "deleted"].includes(current.status) && (
              <Button
                variant="outline"
                onClick={() => setDraft(asDraft(current))}
              >
                编辑新版本
              </Button>
            )
          }
        >
          <div className="space-y-3">
            {current.clauses.map((clause) => (
              <article key={clause.id} className="rounded-lg border p-3">
                <div className="font-medium">
                  {clause.id} · {clause.title}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {clause.required ? "必需" : "可选"} · {clause.kind}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm">
                  {clause.description}
                </p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  {clause.bindings.length ? (
                    clause.bindings.map((mapped) => (
                      <span
                        key={`${mapped.taskSpecId}/${mapped.checkId}`}
                        className="rounded bg-muted px-2 py-1"
                      >
                        {mapped.taskSpecId} / {mapped.checkId}
                      </span>
                    ))
                  ) : (
                    <span className="text-amber-600">尚无验收映射</span>
                  )}
                </div>
              </article>
            ))}
            {analysis && (
              <div className="rounded-lg bg-muted/40 p-3 text-sm">
                <p>
                  当前项目计划映射：
                  {analysis.valid ? "必需映射完整" : "存在缺失映射"}；
                  {analysis.required} 必需 / {analysis.optional} 可选。
                </p>
                {analysis.issues.map((issue, index) => (
                  <p key={index} className="mt-1 text-muted-foreground">
                    {issue.severity === "error" ? "阻塞" : "提示"} ·{" "}
                    {issue.clauseId} · {issue.code}: {issue.message}
                  </p>
                ))}
              </div>
            )}
            {human && !historical && current.status === "draft" && (
              <div className="space-y-2 rounded-lg border p-3">
                <Field label="签审说明">
                  <Textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                  />
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  已核对条款、验收映射和项目计划 v{project.plan.version}（修订{" "}
                  {project.revision}）
                </label>
                <div className="flex gap-2">
                  <Button
                    disabled={
                      busy || !confirmed || !comment.trim() || !analysis?.valid
                    }
                    onClick={() => void review("approved")}
                  >
                    签审并冻结计划
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || !comment.trim()}
                    onClick={() => void review("rejected")}
                  >
                    退回草案并记录说明
                  </Button>
                </div>
              </div>
            )}
            {writable &&
              !historical &&
              !["archived", "deleted"].includes(current.status) && (
                <details className="rounded-lg border p-3">
                  <summary className="cursor-pointer text-sm">
                    归档或删除当前基线
                  </summary>
                  <p className="mt-2 text-xs text-muted-foreground">
                    已有绑定运行的基线与历史保持可追溯。
                  </p>
                  <Textarea
                    className="mt-2"
                    aria-label="基线退役说明"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                  />
                  <div className="mt-2 flex gap-2">
                    {(["archive", "delete"] as const).map((action) => (
                      <Button
                        key={action}
                        size="sm"
                        variant="outline"
                        disabled={busy || !comment.trim()}
                        onClick={() =>
                          void act(async () => {
                            const saved = await retireRequirements(
                              project.id,
                              current,
                              action,
                              comment,
                            );
                            await reload();
                            await open(saved.id);
                          })
                        }
                      >
                        {action === "archive" ? "归档" : "删除并保留历史"}
                      </Button>
                    ))}
                  </div>
                </details>
              )}
            <details className="rounded-lg border p-3">
              <summary className="cursor-pointer text-sm">
                版本历史与签审说明（{history.length}）
              </summary>
              <div className="mt-3 space-y-2">
                {history.map((revision) => (
                  <button
                    type="button"
                    key={revision.baseline.revision}
                    disabled={busy}
                    className="block w-full rounded border p-2 text-left text-sm"
                    onClick={() =>
                      void act(() =>
                        open(revision.baseline.id, revision.baseline.revision),
                      )
                    }
                  >
                    v{revision.baseline.revision} · {revision.action} ·{" "}
                    {revision.authorId}
                    <p className="text-xs text-muted-foreground">
                      {revision.comment} · {revision.createdAt}
                    </p>
                  </button>
                ))}
              </div>
              {history.length >= 50 && (
                <Button
                  className="mt-2"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const next = await requirementsHistory(
                        project.id,
                        current.id,
                        history[history.length - 1].baseline.revision,
                      );
                      setHistory((old) => [...old, ...next.items]);
                    })
                  }
                >
                  更多历史版本
                </Button>
              )}
              {historical && (
                <Button
                  className="mt-2"
                  size="sm"
                  variant="outline"
                  onClick={() => void act(() => open(current.id))}
                >
                  返回最新版本
                </Button>
              )}
            </details>
          </div>
        </Panel>
      )}
      <Panel
        title="运行覆盖矩阵"
        description="检查存在不代表通过。这里仅统计同一运行、同一任务快照、同一冻结验收规则上的真实证据。"
      >
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <Field label="选择运行">
            <NativeSelect
              value={runId}
              onChange={(e) => {
                setRunId(e.target.value);
                setConfirmed(false);
              }}
            >
              <option value="">选择运行</option>
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.id.slice(0, 12)} · {run.status} · {run.createdAt}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Button
            variant="outline"
            disabled={!runId || busy}
            onClick={() => void act(reloadCoverage)}
          >
            刷新证据
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const result = await getRuns(project.id);
                setRuns(result.items);
              })
            }
          >
            刷新运行列表
          </Button>
        </div>
        {runId && coverage && !binding && (
          <div className="space-y-2 rounded-lg border p-3">
            <p className="text-sm">此运行尚未绑定需求基线，发布门槛未启用。</p>
            {current?.status === "approved" && !historical && writable ? (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  将此运行永久绑定到 {current.title} v{current.revision}
                  ；后续编辑不改变该运行的基线。
                </label>
                <Button
                  disabled={busy || !confirmed}
                  onClick={() =>
                    void act(async () => {
                      await bindRequirements(project.id, current, runId);
                      await reloadCoverage();
                      setConfirmed(false);
                    })
                  }
                >
                  固定已签审基线
                </Button>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                选中当前已签审的基线后即可绑定；其计划必须与该运行的冻结计划一致。
              </p>
            )}
          </div>
        )}
        {binding && coverage && (
          <div className="space-y-4">
            <div className="rounded-lg border p-3 text-sm">
              <p>
                固定基线：{binding.baseline.title} v{binding.baselineRevision} ·{" "}
                {binding.baselineHash.slice(0, 16)}
              </p>
              <p className="mt-1">
                必需条款 {coverage.requiredPassed}/{coverage.requiredTotal}{" "}
                已通过 ·{" "}
                {coverage.requiredBeforePublication
                  ? coverage.publicationAllowed
                    ? "运行证据满足发布门槛"
                    : "发布已被需求门槛阻止"
                  : "仅追踪，无发布门槛"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                最终发布还会复验所选任务在合并快照上的验收检查。绑定人：
                {binding.boundBy}。
              </p>
              <Button
                className="mt-2"
                size="sm"
                variant="outline"
                onClick={() => {
                  setCurrent(binding.baseline);
                  setHistorical(true);
                  setDraft(undefined);
                  setHistory([]);
                  setAnalysis(undefined);
                }}
              >
                查看运行固定基线
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="p-2">需求条款</th>
                    <th className="p-2">状态</th>
                    <th className="p-2">验收与证据</th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.rows.map((row) => (
                    <tr key={row.clause.id} className="border-b align-top">
                      <td className="p-2">
                        <p className="font-medium">
                          {row.clause.id} · {row.clause.title}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {row.clause.required ? "必需" : "可选"}
                        </p>
                      </td>
                      <td className="p-2">
                        <Status value={row.status} />
                        <p className="mt-1 text-xs">
                          {requirementStatusLabel[row.status]}
                        </p>
                      </td>
                      <td className="space-y-3 p-2">
                        {row.evidence.map((evidence) => (
                          <div
                            key={`${evidence.taskSpecId}/${evidence.checkId}`}
                          >
                            <p>
                              {evidence.taskSpecId} / {evidence.checkId}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {evidence.reason}
                            </p>
                            {evidence.summary && (
                              <p className="text-xs">{evidence.summary}</p>
                            )}
                            {evidence.taskId && (
                              <a
                                className="text-xs text-primary underline"
                                href={`/dashboard/project-executions/${encodeURIComponent(project.id)}?runId=${encodeURIComponent(runId)}&taskId=${encodeURIComponent(evidence.taskId)}&tab=execution`}
                              >
                                查看任务与不可变验收证据
                              </a>
                            )}
                            {evidence.verificationId && (
                              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                                证明 {evidence.verificationId} · 快照{" "}
                                {evidence.snapshotId}
                              </p>
                            )}
                            {evidence.reviewId && (
                              <p className="font-mono text-xs text-muted-foreground">
                                本地审批 {evidence.reviewId}
                              </p>
                            )}
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
