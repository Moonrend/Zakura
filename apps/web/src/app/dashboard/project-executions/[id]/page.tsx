"use client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  Play,
  Pause,
  RefreshCw,
  Square,
  Save,
  CheckCircle2,
  GitCompareArrows,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PlanEditor } from "@/components/project-execution/plan-editor";
import { TaskGraph } from "@/components/project-execution/task-graph";
import { TaskInspector } from "@/components/project-execution/task-inspector";
import { MergeWorkbench } from "@/components/project-execution/merge-workbench";
import { ArtifactExplorer } from "@/components/project-execution/artifact-explorer";
import { SourceActivityPanel } from "@/components/project-execution/source-activity-panel";
import { KnowledgePanel } from "@/components/project-execution/knowledge-panel";
import { SemanticPanel } from "@/components/project-execution/semantic-panel";
import { InsightsPanel } from "@/components/project-execution/insights-panel";
import { DeliveryPanel } from "@/components/project-execution/delivery-panel";
import { RequirementsPanel } from "@/components/project-execution/requirements-panel";
import { RefactorPanel } from "@/components/project-execution/refactor-panel";
import { CampaignPanel } from "@/components/project-execution/campaign-panel";
import { SignoffPanel } from "@/components/project-execution/signoff-panel";
import { ContextPanel } from "@/components/project-execution/context-panel";
import { useProjectEvents } from "@/components/project-execution/use-events";
import {
  Panel,
  Status,
  NativeSelect,
  Code,
  ErrorNotice,
} from "@/components/project-execution/shared";
import {
  getProject,
  getRuns,
  getRun,
  getSchedule,
  startRun,
  forkRun,
  controlRun,
  updateProject,
  deleteProject,
  validatePlan,
  comparePlan,
  replan,
  validateDraft,
  friendlyError,
  type Project,
  type Definition,
  type Analysis,
  type Run,
  type Task,
  type Comparison,
  type ReplanReport,
  type Schedule,
} from "@/lib/project-execution";
import { fetchSpaces, type SpaceItem } from "@/lib/spaces";
import { fetchAgents, type AgentListItem } from "@/lib/agents";

type Tab =
  | "execution"
  | "plan"
  | "artifacts"
  | "semantic"
  | "knowledge"
  | "insights"
  | "delivery"
  | "requirements"
  | "refactor"
  | "campaign"
  | "signoff"
  | "context"
  | "merge"
  | "events";
export default function ProjectWorkbenchPage() {
  return (
    <Suspense
      fallback={
        <div className="p-8 text-sm text-muted-foreground">
          正在读取项目工作台…
        </div>
      }
    >
      <ProjectWorkbench />
    </Suspense>
  );
}
function ProjectWorkbench() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const router = useRouter();
  const searchParams = useSearchParams();
  const targetRun = searchParams.get("runId") ?? "";
  const targetTask = searchParams.get("taskId") ?? "";
  const targetReview = searchParams.get("reviewId") ?? "";
  const targetKind = searchParams.get("reviewKind") ?? "";
  const targetTab = searchParams.get("tab") ?? "";
  const [project, setProject] = useState<Project | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runAnalysis, setRunAnalysis] = useState<Analysis | null>(null);
  const [selectedTask, setSelectedTask] = useState("");
  const [spaces, setSpaces] = useState<SpaceItem[]>([]);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [tab, setTab] = useState<Tab>("execution");
  const [draft, setDraft] = useState<Definition | null>(null);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [planAnalysis, setPlanAnalysis] = useState<Analysis | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [replanReport, setReplanReport] = useState<ReplanReport | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [artifact, setArtifact] = useState({ snapshotId: "", path: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  useEffect(() => setCancelConfirm(false), [run?.id, run?.revision]);
  const activeRun = useRef(runId);
  activeRun.current = runId;
  const pollBusy = useRef<string | null>(null);
  const appliedTarget = useRef("");
  useEffect(() => {
    if (targetTab) {
      if (
        [
          "execution",
          "plan",
          "artifacts",
          "semantic",
          "knowledge",
          "insights",
          "delivery",
          "requirements",
          "refactor",
          "campaign",
          "signoff",
          "context",
          "merge",
          "events",
        ].includes(targetTab)
      )
        setTab(targetTab as Tab);
      else setError("链接中的工作台页面不存在，请从导航选择当前页面。");
    }
  }, [targetTab]);
  useEffect(() => {
    if (
      !targetTask ||
      !run ||
      (targetRun && run.id !== targetRun) ||
      !tasks.length
    )
      return;
    const key = `${run.id}:${targetTask}`;
    if (appliedTarget.current === key) return;
    appliedTarget.current = key;
    const found = tasks.find((task) => task.id === targetTask);
    if (found) setSelectedTask(found.id);
    else
      setError(
        "审批链接中的任务已删除或当前不可访问，请重新选择任务并核对当前状态。",
      );
  }, [targetTask, targetRun, run, tasks]);
  const reloadProject = useCallback(async () => {
    const [data, list] = await Promise.all([
      getProject(projectId),
      getRuns(projectId),
    ]);
    setProject(data.project);
    setAnalysis(data.analysis);
    setRuns(list.items ?? []);
    return data.project;
  }, [projectId]);
  const reloadRun = useCallback(async () => {
    if (!runId || pollBusy.current === runId) return;
    pollBusy.current = runId;
    try {
      const current = runId;
      const data = await getRun(projectId, current);
      if (activeRun.current !== current) return;
      setRun(data.run);
      setTasks(data.tasks ?? []);
      setRunAnalysis(data.analysis ?? null);
      setRuns((previous) =>
        previous.map((r) => (r.id === data.run.id ? data.run : r)),
      );
    } catch (error) {
      setError(friendlyError(error));
    } finally {
      if (pollBusy.current === runId) pollBusy.current = null;
    }
  }, [projectId, runId]);
  useEffect(() => {
    let alive = true;
    void Promise.all([
      getProject(projectId),
      getRuns(projectId),
      fetchSpaces(),
      fetchAgents(),
    ])
      .then(([data, runs, spaces, agents]) => {
        if (!alive) return;
        setProject(data.project);
        setAnalysis(data.analysis);
        setRuns(runs.items ?? []);
        if (targetRun) {
          if (runs.items?.some((run) => run.id === targetRun))
            setRunId(targetRun);
          else {
            setRunId("");
            setError(
              "审批链接中的执行轮次已删除或当前无权访问，请从轮次列表重新选择。",
            );
          }
        } else setRunId(runs.items?.[0]?.id ?? "");
        setSpaces(spaces);
        setAgents(agents);
      })
      .catch((error) => {
        if (alive) setError(friendlyError(error));
      });
    return () => {
      alive = false;
    };
  }, [projectId, targetRun]);
  useEffect(() => {
    setRun(null);
    setTasks([]);
    setRunAnalysis(null);
    setSelectedTask("");
    setSchedule(null);
    void reloadRun();
  }, [reloadRun]);
  const eventLog = useProjectEvents(projectId, runId, () => void reloadRun());
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (error) {
      setError(friendlyError(error));
    } finally {
      setBusy(false);
    }
  };
  const beginEdit = () => {
    if (!project) return;
    const next = structuredClone(project);
    next.plan.version++;
    next.expectedRevision = project.revision;
    setDraft(next);
    setEditing(true);
    setDirty(false);
    setComparison(null);
    setReplanReport(null);
    setPlanAnalysis(null);
    setTab("plan");
  };
  const save = async () => {
    if (!project || !draft) return;
    const issues = validateDraft(draft);
    if (issues.length) throw new Error(issues.join("\n"));
    await updateProject(project.id, {
      ...draft,
      expectedRevision: project.revision,
    });
    await reloadProject();
    setEditing(false);
    setDraft(null);
    setDirty(false);
  };
  const openArtifact = (snapshotId: string, path = "") => {
    setArtifact({ snapshotId, path });
    setTab("artifacts");
  };
  const hasLiveRun = runs.some(
    (r) => !["completed", "failed", "cancelled"].includes(r.status),
  );
  if (!project)
    return (
      <div className="p-8">
        <ErrorNotice message={error} />
        {!error && (
          <p className="text-sm text-muted-foreground">正在读取长期项目…</p>
        )}
      </div>
    );
  const visibleAnalysis = run
    ? (runAnalysis ??
      (run.planVersion === project.plan.version ? analysis : null))
    : analysis;
  const chooseTask = (specId: string) => {
    const task = tasks.find((t) => t.spec.id === specId);
    if (task) setSelectedTask(task.id);
  };
  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5 p-4 md:p-8">
      <header>
        <Link
          href="/dashboard/project-executions"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← 项目列表
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{project.name}</h1>
            <p className="mt-2 max-w-3xl whitespace-pre-wrap text-sm text-muted-foreground">
              {project.goal}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
              <Status value={project.status} />
              <span>计划 v{project.plan.version}</span>
              <span>{spaces.find((s) => s.id === project.spaceId)?.name}</span>
              <span>{project.plan.tasks.length} 项任务</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await reloadProject();
                  await reloadRun();
                })
              }
            >
              <RefreshCw />
              刷新
            </Button>
          </div>
        </div>
      </header>
      <ErrorNotice message={error} />
      {targetReview && (
        <p className="break-all rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
          来自审核收件箱：{targetKind || "审核条目"} · {targetReview}
          。以下显示服务端当前状态；已处理、过期或不可访问的目标需要重新核对。
        </p>
      )}
      <SourceActivityPanel projectId={projectId} />
      <div className="flex justify-end">
        <Button
          disabled={busy || hasLiveRun || editing}
          onClick={() =>
            void act(async () => {
              const next = await startRun(projectId, project.revision);
              await reloadProject();
              setRunId(next.id);
              setTab("execution");
            })
          }
        >
          <Play />
          开始新一轮
        </Button>
      </div>
      <nav
        aria-label="项目工作台导航"
        className="flex flex-wrap gap-1 rounded-xl border bg-muted/40 p-1"
      >
        {(
          [
            ["execution", "持续执行"],
            ["plan", "计划与影响"],
            ["artifacts", "产物比较"],
            ["semantic", "代码语义与影响"],
            ["knowledge", "知识与决策"],
            ["insights", "观测与调度实验"],
            ["delivery", "交付包与渠道"],
            ["requirements", "需求与验收追溯"],
            ["refactor", "符号重构"],
            ["campaign", "Agent 对照实验"],
            ["signoff", "独立审核签审"],
            ["context", "任务代码上下文"],
            ["merge", "审核合并"],
            ["events", "事件与恢复"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            variant={tab === value ? "default" : "ghost"}
            aria-current={tab === value ? "page" : undefined}
            onClick={() => setTab(value)}
          >
            {label}
          </Button>
        ))}
      </nav>
      {tab !== "plan" && tab !== "knowledge" && (
        <Panel
          title="执行轮次"
          description="每轮固定计划和工作区基线；编辑项目不会修改正在执行的冻结计划。"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <NativeSelect
              aria-label="选择执行轮次"
              value={runId}
              onChange={(e) => setRunId(e.target.value)}
            >
              <option value="">尚未启动</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  v{r.planVersion} ·{" "}
                  {new Date(r.createdAt).toLocaleString("zh-CN")} · {r.status}
                </option>
              ))}
            </NativeSelect>
            {run && (
              <div className="flex flex-wrap items-center gap-2">
                <Status value={run.status} />
                {["completed", "failed", "cancelled"].includes(run.status) && (
                  <Button
                    variant="outline"
                    disabled={busy || hasLiveRun || editing}
                    onClick={() =>
                      void act(async () => {
                        const next = await forkRun(
                          projectId,
                          run.id,
                          project.revision,
                        );
                        await reloadProject();
                        setRunId(next.id);
                        setTab("execution");
                      })
                    }
                  >
                    沿用此轮基线增量执行当前计划
                  </Button>
                )}
                {["running", "pending"].includes(run.status) && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        setRun(await controlRun(projectId, run, "pause"));
                        await reloadRun();
                      })
                    }
                  >
                    <Pause />
                    暂停
                  </Button>
                )}
                {[
                  "paused",
                  "waiting_review",
                  "waiting_approval",
                  "unknown",
                  "failed",
                ].includes(run.status) && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        setRun(await controlRun(projectId, run, "resume"));
                        await reloadRun();
                      })
                    }
                  >
                    <Play />
                    恢复
                  </Button>
                )}
                {!["completed", "cancelled"].includes(run.status) && (
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={cancelConfirm}
                        onChange={(e) => setCancelConfirm(e.target.checked)}
                      />
                      确认取消 r{run.revision}
                    </label>
                    <Button
                      variant="destructive"
                      disabled={busy || !cancelConfirm}
                      onClick={() =>
                        void act(async () => {
                          setRun(await controlRun(projectId, run, "cancel"));
                          await reloadRun();
                        })
                      }
                    >
                      <Square />
                      取消此轮
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
          {run && (
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm lg:grid-cols-4">
              <span>
                Token <strong>{run.tokens.toLocaleString()}</strong>
              </span>
              <span>
                模型调用 <strong>{run.modelCalls}</strong>
              </span>
              <span>
                工具调用 <strong>{run.toolCalls}</strong>
              </span>
              <span>
                任务通过{" "}
                <strong>
                  {tasks.filter((t) => t.status === "completed").length}/
                  {tasks.length}
                </strong>
              </span>
            </div>
          )}
          {run?.error && (
            <p className="mt-3 text-sm text-destructive">{run.error}</p>
          )}
          {!runs.length && (
            <p className="mt-3 text-sm text-muted-foreground">
              在「计划与影响」检查条件后，可开始持续执行。
            </p>
          )}
        </Panel>
      )}
      {tab === "execution" && (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
          <div className="space-y-4">
            {visibleAnalysis && (
              <TaskGraph
                analysis={visibleAnalysis}
                tasks={tasks}
                onSelect={run ? chooseTask : undefined}
              />
            )}
            {run && (
              <Panel
                title="候选任务与预算预留"
                actions={
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void act(async () =>
                        setSchedule(await getSchedule(projectId, run.id)),
                      )
                    }
                  >
                    分析当前候选
                  </Button>
                }
              >
                {schedule ? (
                  <div className="space-y-2">
                    <p className="text-sm">
                      可用并发位 {schedule.availableSlots} · 预留 Token{" "}
                      {schedule.reserved.tokens}
                    </p>
                    {schedule.ranked.map((c) => (
                      <div
                        key={c.taskId}
                        className="rounded border p-2 text-xs"
                      >
                        {project.plan.tasks.find((t) => t.id === c.taskId)
                          ?.title ?? c.taskId}{" "}
                        · 得分 {c.score.toFixed(2)}
                        <div className="mt-1 text-muted-foreground">
                          优先级 {c.priorityScore} · 关键路径 {c.criticalScore}{" "}
                          · 等待 {c.agingScore.toFixed(2)} · 公平修正 −
                          {c.fairnessPenalty}
                        </div>
                      </div>
                    ))}
                    {schedule.deferred.map((d) => (
                      <div
                        key={d.taskId}
                        className="rounded border p-2 text-xs"
                      >
                        <strong>
                          {tasks.find((t) => t.spec.id === d.taskId)?.spec
                            .title ?? d.taskId}
                        </strong>{" "}
                        · {d.codes.join("，")}
                        <p className="mt-1 text-muted-foreground">{d.detail}</p>
                      </div>
                    ))}
                    {schedule.warnings.map((w, i) => (
                      <p key={i} className="text-xs text-muted-foreground">
                        {w.message}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    查看为什么某项任务还不能开始，以及优先级、等待时长与预算的影响。
                  </p>
                )}
              </Panel>
            )}
          </div>
          {selectedTask && run ? (
            <TaskInspector
              key={`${run.id}/${selectedTask}`}
              projectId={projectId}
              runId={run.id}
              taskId={selectedTask}
              initialOperationId={
                targetKind === "operation" ? targetReview : undefined
              }
              refreshToken={tasks.find((t) => t.id === selectedTask)?.revision}
              onChanged={() => void reloadRun()}
              onArtifact={openArtifact}
            />
          ) : (
            <Panel title="选择任务">
              <p className="text-sm text-muted-foreground">
                点击图中的任务，查看持久化检查点、工具操作、验收证据及审核。
              </p>
              {run && (
                <div className="mt-3 space-y-2">
                  {tasks.map((t) => (
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-2 rounded border p-2 text-left text-sm hover:bg-muted"
                      key={t.id}
                      onClick={() => setSelectedTask(t.id)}
                    >
                      <span>{t.spec.title}</span>
                      <Status value={t.status} />
                    </button>
                  ))}
                </div>
              )}
            </Panel>
          )}
        </div>
      )}
      {tab === "knowledge" && (
        <KnowledgePanel
          projectId={projectId}
          runs={runs}
          tasks={tasks}
          onArtifact={openArtifact}
          initialEntryId={
            ["decision", "question"].includes(targetKind)
              ? targetReview
              : undefined
          }
        />
      )}
      {tab === "delivery" && <DeliveryPanel project={project} />}
      {tab === "requirements" && (
        <RequirementsPanel
          key={projectId}
          project={project}
          initialId={targetKind === "baseline" ? targetReview : undefined}
        />
      )}
      {tab === "refactor" && (
        <RefactorPanel key={projectId} project={project} />
      )}
      {tab === "campaign" && (
        <CampaignPanel key={projectId} project={project} />
      )}
      {tab === "signoff" && <SignoffPanel key={projectId} project={project} />}
      {tab === "context" && <ContextPanel key={projectId} project={project} />}
      {tab === "semantic" && (
        <SemanticPanel
          key={runId}
          projectId={projectId}
          tasks={tasks}
          baseSnapshot={run?.baseSnapshot}
          initialSnapshot={artifact.snapshotId}
        />
      )}
      {tab === "insights" && (
        <InsightsPanel
          key={runId}
          projectId={projectId}
          runId={runId}
          runs={runs}
          tasks={tasks}
          maxConcurrent={project.config.budget.maxConcurrent}
        />
      )}
      {tab === "plan" && (
        <div className="space-y-4">
          <Panel
            title="计划版本与重规划"
            description="影响预览会指出失效产物、需重放任务及不能中断的操作。保存更新仅影响后续执行轮次。"
            actions={
              <Button disabled={busy || editing} onClick={beginEdit}>
                编辑新版本
              </Button>
            }
          >
            <div className="flex flex-wrap gap-2">
              {editing && draft && (
                <>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const issues = validateDraft(draft);
                        if (issues.length) throw new Error(issues.join("\n"));
                        setPlanAnalysis(await validatePlan(projectId, draft));
                      })
                    }
                  >
                    <CheckCircle2 />
                    验证任务图
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(async () =>
                        setComparison(await comparePlan(projectId, draft)),
                      )
                    }
                  >
                    <GitCompareArrows />
                    比较计划
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(async () =>
                        setReplanReport(
                          await replan(projectId, draft, runId || undefined),
                        ),
                      )
                    }
                  >
                    预览重规划影响
                  </Button>
                  <Button
                    disabled={busy || !dirty}
                    onClick={() => void act(save)}
                  >
                    <Save />
                    保存新版本
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setEditing(false);
                      setDraft(null);
                      setDirty(false);
                    }}
                  >
                    放弃编辑
                  </Button>
                </>
              )}
            </div>
          </Panel>
          {editing && draft ? (
            <PlanEditor
              value={draft}
              onChange={(value) => {
                setDraft(value);
                setDirty(true);
                setPlanAnalysis(null);
              }}
              spaces={spaces}
              agents={agents}
              lockSpace
            />
          ) : (
            <>
              {analysis && <TaskGraph analysis={analysis} />}
              <Panel title="冻结执行要求">
                <div className="space-y-3">
                  {project.plan.tasks.map((t) => (
                    <details className="rounded-lg border p-3" key={t.id}>
                      <summary className="cursor-pointer text-sm font-medium">
                        {t.title} · {t.checks.filter((c) => c.required).length}{" "}
                        项必需验收
                      </summary>
                      <p className="my-3 whitespace-pre-wrap text-sm">
                        {t.prompt}
                      </p>
                      <Code
                        value={{
                          writes: t.writes,
                          dependsOn: t.dependsOn,
                          checks: t.checks,
                        }}
                      />
                    </details>
                  ))}
                </div>
              </Panel>
            </>
          )}
          {planAnalysis && <TaskGraph analysis={planAnalysis} />}
          {comparison && <ComparisonPanel value={comparison} />}
          {replanReport && (
            <Panel
              title="重规划影响"
              description={
                replanReport.safeToApply
                  ? "当前没有需要先停稳的执行。"
                  : "有活动或结果未决的执行，应用前必须处理。"
              }
            >
              <div className="grid gap-3 text-sm sm:grid-cols-3">
                <span>产物失效 {replanReport.invalidated.length}</span>
                <span>可保留 {replanReport.retained.length}</span>
                <span>需重放 {replanReport.replayRequired.length}</span>
              </div>
              <div className="mt-3 space-y-2">
                {Object.entries(replanReport.reasons).map(([id, reasons]) => (
                  <div key={id} className="rounded border p-2 text-sm">
                    <strong>
                      {draft?.plan.tasks.find((t) => t.id === id)?.title ?? id}
                    </strong>
                    <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
                      {reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </Panel>
          )}
          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm text-destructive">
              删除项目定义
            </summary>
            <p className="mt-2 text-xs text-muted-foreground">
              先结束所有活动执行。删除操作使用当前项目修订号校验。
            </p>
            <label className="my-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.checked)}
              />
              确认删除此项目
            </label>
            <Button
              variant="destructive"
              disabled={busy || !deleteConfirm || hasLiveRun}
              onClick={() =>
                void act(async () => {
                  await deleteProject(projectId, project.revision);
                  router.push("/dashboard/project-executions");
                })
              }
            >
              删除项目
            </Button>
          </details>
        </div>
      )}
      {tab === "artifacts" && (
        <ArtifactExplorer
          projectId={projectId}
          runId={run?.id}
          tasks={tasks}
          snapshotId={artifact.snapshotId}
          initialPath={artifact.path}
        />
      )}
      {tab === "merge" &&
        (run ? (
          <MergeWorkbench
            key={run.id}
            projectId={projectId}
            run={run}
            tasks={tasks}
            onArtifact={openArtifact}
            initialPreviewId={targetKind === "merge" ? targetReview : undefined}
          />
        ) : (
          <Panel title="审核合并">
            <p className="text-sm text-muted-foreground">
              先完成一轮持续执行，再选择产物生成合并预览。
            </p>
          </Panel>
        ))}
      {tab === "events" && (
        <Panel
          title="持久化事件流"
          description={`已读取到事件游标 ${eventLog.cursor}，显示最近 300 条。刷新或切换轮次后从服务端记录恢复。`}
        >
          <ErrorNotice message={eventLog.error} />
          <div className="max-h-[700px] space-y-3 overflow-auto">
            {[...eventLog.events].reverse().map((event) => (
              <details key={event.id} className="rounded-lg border p-3">
                <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3 text-sm">
                  <strong>{event.kind}</strong>
                  <span className="text-xs text-muted-foreground">
                    #{event.sequence} ·{" "}
                    {new Date(event.createdAt).toLocaleString("zh-CN")}
                  </span>
                </summary>
                <Code value={event.payload} />
              </details>
            ))}
            {!eventLog.events.length && (
              <p className="text-sm text-muted-foreground">尚无执行事件。</p>
            )}
          </div>
        </Panel>
      )}
    </div>
  );
}
function ComparisonPanel({ value }: { value: Comparison }) {
  const labels: Record<string, string> = {
    cost: "预算成本",
    verification: "验收覆盖与多样性",
    artifacts: "可验证产物",
    risk: "执行风险",
    criticalSeconds: "关键链估计秒数",
  };
  const recommendation: Record<string, string> = {
    review_assumptions: "需要核实假设，不能直接按总分选方案",
    candidate: "当前假设下候选方案得分更高",
    base: "当前假设下原方案得分更高",
    equivalent_under_assumptions: "当前假设下两方案等价",
  };
  return (
    <Panel
      title="方案比较"
      description={recommendation[value.recommendation] ?? value.recommendation}
    >
      <div className="overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="p-2">指标</th>
              <th className="p-2">当前</th>
              <th className="p-2">候选</th>
              <th className="p-2">差异</th>
            </tr>
          </thead>
          <tbody>
            {value.metrics.map((metric) => (
              <tr key={metric.name} className="border-b">
                <td className="p-2">{labels[metric.name] ?? metric.name}</td>
                <td className="p-2">{metric.base.toFixed(3)}</td>
                <td className="p-2">{metric.candidate.toFixed(3)}</td>
                <td className="p-2">{metric.delta.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {value.uncertainty.length > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          任务成本估计不完整或交付范围有差异。当前分解结果用于检查假设，不能证明方案更快、更便宜。
        </p>
      )}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs">
          查看评分依据与不确定性
        </summary>
        <Code value={value} />
      </details>
    </Panel>
  );
}
