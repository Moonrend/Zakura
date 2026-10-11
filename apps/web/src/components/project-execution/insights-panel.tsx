"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError, type Run, type Task } from "@/lib/project-execution";
import {
  compareRunInsights,
  downloadInsightReport,
  getProjectInsights,
  getRunInsights,
  simulateRun,
  type DurationEstimate,
  type InsightComparison,
  type InsightScenario,
  type InsightSimulation,
  type InsightTask,
  type ProjectInsight,
  type RunInsight,
  type ScenarioResult,
} from "@/lib/project-insights";
import {
  Code,
  ErrorNotice,
  Field,
  NativeSelect,
  Panel,
  Status,
} from "./shared";

const seconds = (value: number | undefined) =>
  value === undefined
    ? "未知"
    : value < 60
      ? `${value.toFixed(1)} 秒`
      : value < 3600
        ? `${(value / 60).toFixed(1)} 分`
        : `${(value / 3600).toFixed(2)} 小时`;
const percent = (value: number | undefined) =>
  value === undefined ? "未知" : `${(value * 100).toFixed(1)}%`;
type ScenarioDraft = InsightScenario & {
  capacitiesJSON: string;
  resourcesJSON: string;
};
const newScenario = (concurrency: number, count: number): ScenarioDraft => ({
  id: `scenario_${count + 1}`,
  label: `方案 ${count + 1}`,
  maxConcurrent: concurrency,
  durations: {},
  capacities: {},
  resources: {},
  costs: {},
  serializeWrites: true,
  capacitiesJSON: "{}",
  resourcesJSON: "{}",
});

function TraceTimeline({
  run,
  onTask,
}: {
  run: RunInsight;
  onTask: (taskId: string) => void;
}) {
  const baseline = Date.parse(run.createdAt);
  const finiteSpans = run.tasks
    .flatMap((task) => task.intervals)
    .filter((span) => span.end && span.seconds !== undefined);
  const maxSeconds = Math.max(
    1,
    ...finiteSpans.map((span) => (Date.parse(span.end!) - baseline) / 1000),
  );
  const visible = run.tasks.slice(0, 100);
  const width = 1000,
    labelWidth = 190,
    chartWidth = 770,
    rowHeight = 28;
  return (
    <div>
      <div className="overflow-auto">
        <svg
          role="img"
          aria-label="任务实际执行时间轴，以持久化开始结束事件为依据"
          viewBox={`0 0 ${width} ${visible.length * rowHeight + 42}`}
          className="min-w-[760px] w-full"
        >
          <title>实际执行时间轴，横轴为轮次启动后的墙钟秒数</title>
          {Array.from({ length: 6 }, (_, i) => (
            <g key={i}>
              <line
                x1={labelWidth + (i * chartWidth) / 5}
                x2={labelWidth + (i * chartWidth) / 5}
                y1={22}
                y2={visible.length * rowHeight + 24}
                stroke="currentColor"
                opacity={0.08}
              />
              <text
                x={labelWidth + (i * chartWidth) / 5}
                y={14}
                fontSize={10}
                fill="currentColor"
                textAnchor={i === 5 ? "end" : "start"}
              >
                {seconds((maxSeconds * i) / 5)}
              </text>
            </g>
          ))}
          {visible.map((task, i) => (
            <g key={task.taskId}>
              <a
                role="button"
                tabIndex={0}
                aria-label={`查看 ${task.title} 的执行证据`}
                onClick={() => onTask(task.taskId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onTask(task.taskId);
                  }
                }}
                className="cursor-pointer"
              >
                <text
                  x={0}
                  y={i * rowHeight + 41}
                  fill="currentColor"
                  fontSize={11}
                >
                  {task.title.slice(0, 23)}
                </text>
                {task.intervals.map((span, n) => {
                  const start = Math.max(
                    0,
                    (Date.parse(span.start) - baseline) / 1000,
                  );
                  const known = span.end && span.seconds !== undefined;
                  const end = known
                    ? Math.max(start, (Date.parse(span.end!) - baseline) / 1000)
                    : start;
                  return (
                    <rect
                      key={n}
                      x={
                        labelWidth +
                        Math.min(start / maxSeconds, 1) * chartWidth
                      }
                      y={i * rowHeight + 28}
                      width={
                        known
                          ? Math.max(
                              3,
                              ((end - start) / maxSeconds) * chartWidth,
                            )
                          : 4
                      }
                      height={18}
                      rx={3}
                      fill={
                        known
                          ? span.outcome === "failed"
                            ? "#dc2626"
                            : "#6366f1"
                          : "#d97706"
                      }
                      opacity={0.8}
                    >
                      <title>
                        {task.title}: {seconds(span.seconds)} · {span.outcome} ·
                        序列 {span.startSequence}–{span.endSequence ?? "未结束"}
                      </title>
                    </rect>
                  );
                })}
                {task.reused && (
                  <text
                    x={labelWidth}
                    y={i * rowHeight + 41}
                    fontSize={10}
                    fill="#16a34a"
                  >
                    复用冻结产物，无新执行区间
                  </text>
                )}
              </a>
            </g>
          ))}
        </svg>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        紫色：已闭合执行区间；红色：失败；橙色标记：结束时间未知。此图表示墙钟执行时间，未结束区间不估算长度。
        {run.tasks.length > visible.length
          ? ` 图中仅显示前 ${visible.length} 项，完整证据在任务清单和导出报告中。`
          : ""}
      </p>
    </div>
  );
}

function SimulatedTimeline({
  result,
  titles,
}: {
  result: ScenarioResult;
  titles: Record<string, string>;
}) {
  const maxSeconds = Math.max(
    1,
    result.makespanSeconds ?? 0,
    ...result.timeline.map((item) => item.endSeconds),
  );
  const visible = result.timeline.slice(0, 100);
  return (
    <div>
      <div className="space-y-2">
        {visible.map((entry) => (
          <div
            className="grid items-center gap-3 sm:grid-cols-[170px_minmax(0,1fr)]"
            key={entry.specId}
          >
            <p
              className="truncate text-xs"
              title={titles[entry.specId] ?? entry.specId}
            >
              {titles[entry.specId] ?? entry.specId}
            </p>
            <div className="relative h-7 rounded bg-muted">
              <div
                className={`absolute top-1 h-5 rounded ${entry.durationSource === "override" ? "bg-amber-500/70" : "bg-indigo-500/70"}`}
                style={{
                  left: `${(entry.startSeconds / maxSeconds) * 100}%`,
                  width: `${Math.max(0.2, (entry.durationSeconds / maxSeconds) * 100)}%`,
                }}
                title={`${seconds(entry.startSeconds)} → ${seconds(entry.endSeconds)} · ${entry.durationSource} · ${JSON.stringify(entry.resources)}`}
              />
              <span className="absolute inset-0 flex items-center justify-end pr-2 text-[10px]">
                {seconds(entry.startSeconds)} → {seconds(entry.endSeconds)}
              </span>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        蓝色使用历史观测，橙色使用手工耗时假设；任务从零开始重演。
        {result.timeline.length > visible.length
          ? ` 仅绘制前 ${visible.length} 项。`
          : ""}
      </p>
    </div>
  );
}

function EstimateTable({
  estimates,
  titles,
}: {
  estimates: DurationEstimate[];
  titles: Record<string, string>;
}) {
  return (
    <div className="overflow-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr>
            <th className="p-2">任务</th>
            <th className="p-2">样本</th>
            <th className="p-2">P50</th>
            <th className="p-2">P90</th>
            <th className="p-2">中位数区间与限制</th>
          </tr>
        </thead>
        <tbody>
          {estimates.map((estimate) => (
            <tr className="border-t" key={estimate.specId}>
              <td className="p-2">
                {titles[estimate.specId] ?? estimate.specId}
              </td>
              <td className="p-2">
                {estimate.samples} ·{" "}
                {estimate.source === "observed" ? "历史观测" : "未知"}
              </td>
              <td className="p-2">{seconds(estimate.p50Seconds)}</td>
              <td className="p-2">{seconds(estimate.p90Seconds)}</td>
              <td className="p-2">
                {estimate.medianInterval
                  ? `${seconds(estimate.medianInterval.low)}–${seconds(estimate.medianInterval.high)} (${percent(estimate.medianInterval.confidence)}，${estimate.medianInterval.replicates} 次重采样)`
                  : "没有可用区间"}
                {estimate.warnings.map((warning, i) => (
                  <p key={i} className="mt-1 text-muted-foreground">
                    {warning}
                  </p>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScenarioEditor({
  value,
  tasks,
  estimates,
  onChange,
  onRemove,
}: {
  value: ScenarioDraft;
  tasks: Task[];
  estimates: DurationEstimate[];
  onChange: (value: ScenarioDraft) => void;
  onRemove: () => void;
}) {
  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="grid items-end gap-3 sm:grid-cols-[1fr_180px_auto]">
        <Field label={`方案 ${value.id} 名称`}>
          <Input
            value={value.label}
            onChange={(e) => onChange({ ...value, label: e.target.value })}
          />
        </Field>
        <Field label="模拟并发">
          <Input
            type="number"
            min={1}
            max={1000}
            value={value.maxConcurrent}
            onChange={(e) =>
              onChange({ ...value, maxConcurrent: Number(e.target.value) })
            }
          />
        </Field>
        <Button variant="ghost" onClick={onRemove}>
          删除方案
        </Button>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.serializeWrites ?? true}
          onChange={(e) =>
            onChange({ ...value, serializeWrites: e.target.checked })
          }
        />
        模拟重叠写入声明的串行预留
      </label>
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-card">
            <tr>
              <th className="p-2">任务 / 历史样本</th>
              <th className="p-2">耗时覆盖（秒）</th>
              <th className="p-2">成本假设</th>
              <th className="p-2">Token</th>
              <th className="p-2">模型调用</th>
              <th className="p-2">工具调用</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const id = task.spec.id;
              const estimate = estimates.find(
                (estimate) => estimate.specId === id,
              );
              const cost = value.costs[id];
              return (
                <tr className="border-t" key={id}>
                  <td className="min-w-40 p-2">
                    {task.spec.title}
                    <p className="mt-1 text-muted-foreground">
                      {estimate?.samples ?? 0} 个可比样本
                    </p>
                  </td>
                  <td className="p-2">
                    <Input
                      className="w-28"
                      aria-label={`${value.label} ${task.spec.title} 耗时假设秒数`}
                      type="number"
                      min={0}
                      step="any"
                      value={value.durations[id] ?? ""}
                      placeholder="历史 / 未知"
                      onChange={(e) => {
                        const next = { ...value.durations };
                        if (e.target.value === "") delete next[id];
                        else next[id] = Number(e.target.value);
                        onChange({ ...value, durations: next });
                      }}
                    />
                  </td>
                  <td className="p-2">
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={Boolean(cost)}
                        onChange={(e) => {
                          const next = { ...value.costs };
                          if (e.target.checked)
                            next[id] = {
                              tokens: 0,
                              modelCalls: 0,
                              toolCalls: 0,
                            };
                          else delete next[id];
                          onChange({ ...value, costs: next });
                        }}
                      />
                      已提供
                    </label>
                  </td>
                  {(["tokens", "modelCalls", "toolCalls"] as const).map(
                    (key) => (
                      <td className="p-2" key={key}>
                        <Input
                          className="w-24"
                          type="number"
                          min={0}
                          aria-label={`${value.label} ${task.spec.title} ${key} 成本假设`}
                          value={cost?.[key] ?? ""}
                          disabled={!cost}
                          onChange={(e) =>
                            onChange({
                              ...value,
                              costs: {
                                ...value.costs,
                                [id]: {
                                  ...cost!,
                                  [key]: Number(e.target.value),
                                },
                              },
                            })
                          }
                        />
                      </td>
                    ),
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Field
          label="命名资源容量 JSON"
          hint={
            '例如 {"gpu":1,"database":2}。容量是整数；空 {} 不启用命名资源。'
          }
        >
          <Textarea
            rows={4}
            className="font-mono text-xs"
            value={value.capacitiesJSON}
            onChange={(e) =>
              onChange({ ...value, capacitiesJSON: e.target.value })
            }
          />
        </Field>
        <Field
          label="每个任务资源需求 JSON"
          hint={
            '键是任务 spec ID，例如 {"build":{"gpu":1}}；缺省任务不消耗命名资源。'
          }
        >
          <Textarea
            rows={4}
            className="font-mono text-xs"
            value={value.resourcesJSON}
            onChange={(e) =>
              onChange({ ...value, resourcesJSON: e.target.value })
            }
          />
        </Field>
      </div>
      <details>
        <summary className="cursor-pointer text-xs">任务 spec ID 映射</summary>
        <Code
          value={Object.fromEntries(
            tasks.map((task) => [task.spec.id, task.spec.title]),
          )}
        />
      </details>
    </div>
  );
}

export function InsightsPanel({
  projectId,
  runId,
  runs,
  tasks,
  maxConcurrent = 2,
}: {
  projectId: string;
  runId: string;
  runs: Run[];
  tasks: Task[];
  maxConcurrent?: number;
}) {
  const [project, setProject] = useState<ProjectInsight | null>(null);
  const [run, setRun] = useState<RunInsight | null>(null);
  const [selectedTask, setSelectedTask] = useState<InsightTask | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioDraft[]>(() => [
    newScenario(maxConcurrent, 0),
  ]);
  const [quantile, setQuantile] = useState(0.5);
  const [simulation, setSimulation] = useState<InsightSimulation | null>(null);
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [comparison, setComparison] = useState<InsightComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titles = Object.fromEntries(
    tasks.map((task) => [task.spec.id, task.spec.title]),
  );
  useEffect(() => {
    let active = true;
    setRun(null);
    setSelectedTask(null);
    setSimulation(null);
    setScenarios([newScenario(maxConcurrent, 0)]);
    void Promise.all([
      getProjectInsights(projectId),
      ...(runId ? [getRunInsights(projectId, runId)] : []),
    ])
      .then(([project, run]) => {
        if (active) {
          setProject(project as ProjectInsight);
          setRun((run as RunInsight) ?? null);
        }
      })
      .catch((e) => active && setError(friendlyError(e)));
    return () => {
      active = false;
    };
  }, [projectId, runId, maxConcurrent]);
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
  const updateScenario = (index: number, value: ScenarioDraft) => {
    setScenarios((previous) =>
      previous.map((item, i) => (i === index ? value : item)),
    );
    setSimulation(null);
  };
  const simulate = async () => {
    const inputs: InsightScenario[] = scenarios.map(
      ({ capacitiesJSON, resourcesJSON, ...scenario }) => {
        let capacities: Record<string, number>,
          resources: Record<string, Record<string, number>>;
        try {
          capacities = JSON.parse(capacitiesJSON);
          resources = JSON.parse(resourcesJSON);
        } catch {
          throw new Error(`方案「${scenario.label}」的资源配置不是有效 JSON`);
        }
        return { ...scenario, capacities, resources };
      },
    );
    setSimulation(await simulateRun(projectId, runId, inputs, quantile));
  };
  return (
    <div className="space-y-4">
      <ErrorNotice message={error} />
      <Panel
        title="执行证据与观测"
        description="解释持久化事件、真实使用量、等待与重试。未结束的执行区间和没有历史样本的任务保持未知。"
        actions={
          runId && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const [project, run] = await Promise.all([
                      getProjectInsights(projectId),
                      getRunInsights(projectId, runId),
                    ]);
                    setProject(project);
                    setRun(run);
                  })
                }
              >
                刷新证据
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    downloadInsightReport(projectId, runId, "json"),
                  )
                }
              >
                导出 JSON
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    downloadInsightReport(projectId, runId, "markdown"),
                  )
                }
              >
                导出报告
              </Button>
            </div>
          )
        }
      >
        {run ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <span className="text-sm">
                轮次墙钟 {seconds(run.elapsedSeconds)}
              </span>
              <span className="text-sm">
                Token {run.usage.tokens.toLocaleString()}
              </span>
              <span className="text-sm">
                模型 / 工具 {run.usage.modelCalls} / {run.usage.toolCalls}
              </span>
              <span className="text-sm">事件证据 {run.eventCount} 条</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {run.evidenceComplete
                ? "已读入完整持久化证据"
                : "证据达到数量上限或存在缺失，分析结论不完整"}{" "}
              · 未归属任务的使用量 {run.unattributedUsage.tokens} Token /{" "}
              {run.unattributedUsage.modelCalls} 模型 /{" "}
              {run.unattributedUsage.toolCalls} 工具
            </p>
            <p className="text-sm">
              实测关键路径 {seconds(run.criticalPath.seconds)} · 已知下界{" "}
              {seconds(run.criticalPath.knownLowerBoundSeconds)}
              {run.criticalPath.unknownTaskIds.length
                ? ` · ${run.criticalPath.unknownTaskIds.length} 项任务耗时未知`
                : ""}
            </p>
            <TraceTimeline
              run={run}
              onTask={(id) =>
                setSelectedTask(
                  run.tasks.find((task) => task.taskId === id) ?? null,
                )
              }
            />
            {run.warnings.map((notice, i) => (
              <p key={i} className="text-xs text-amber-600">
                {notice.code} · {notice.message}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            选择一个已启动轮次后查看真实执行证据。
          </p>
        )}
      </Panel>
      {run && (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Panel title="任务耗时、重试与等待">
            <div className="max-h-[550px] space-y-2 overflow-auto">
              {run.tasks.map((task) => (
                <button
                  key={task.taskId}
                  type="button"
                  className={`w-full rounded border p-3 text-left ${selectedTask?.taskId === task.taskId ? "border-primary" : "hover:bg-muted"}`}
                  onClick={() => setSelectedTask(task)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <strong className="text-sm">{task.title}</strong>
                    <Status value={task.status} />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    执行 {seconds(task.observedSeconds)}
                    {task.durationComplete ? "" : "（部分或未知）"} ·
                    人工审核等待 {seconds(task.reviewSeconds)} · 重试请求{" "}
                    {task.retryRequests} · 崩溃恢复 {task.recoveries} · 尝试{" "}
                    {task.attempt}
                    {task.reused ? " · 产物复用" : ""}
                  </p>
                  {task.blockers.map((blocker, i) => (
                    <p key={i} className="mt-1 text-xs text-amber-600">
                      {blocker.code} · {blocker.message}
                    </p>
                  ))}
                </button>
              ))}
            </div>
          </Panel>
          <Panel
            title={
              selectedTask ? `${selectedTask.title} · 证据链` : "任务证据链"
            }
          >
            {selectedTask ? (
              <div className="space-y-4">
                <p className="text-xs">
                  Token {selectedTask.usage.tokens.toLocaleString()} · 模型{" "}
                  {selectedTask.usage.modelCalls} · 工具{" "}
                  {selectedTask.usage.toolCalls} · 实测 Token / 执行秒{" "}
                  {selectedTask.tokensPerObservedSecond?.toFixed(2) ?? "未知"}
                </p>
                {selectedTask.blockers.map((blocker, i) => (
                  <div key={i} className="rounded border p-3 text-xs">
                    <strong>{blocker.code}</strong>
                    <p className="mt-1">{blocker.message}</p>
                    <p className="mt-1 text-muted-foreground">
                      依据：{blocker.evidence}
                    </p>
                    {blocker.chain?.length ? (
                      <p className="mt-1 break-all">
                        {blocker.chain.join(" → ")}
                      </p>
                    ) : null}
                  </div>
                ))}
                <details open>
                  <summary className="cursor-pointer text-sm">
                    执行区间与持久化序列
                  </summary>
                  <Code value={selectedTask.intervals} />
                </details>
                <details>
                  <summary className="cursor-pointer text-sm">
                    检查点与工具 / 验收状态统计
                  </summary>
                  <Code
                    value={{
                      checkpoints: selectedTask.checkpoints,
                      operations: selectedTask.operationStatuses,
                      verification: selectedTask.verificationStatuses,
                    }}
                  />
                </details>
                {selectedTask.warnings.map((warning, i) => (
                  <p key={i} className="text-xs text-amber-600">
                    {warning.code} · {warning.message}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                选择左侧任务查看等待原因、操作状态、检查点和恢复证据。
              </p>
            )}
          </Panel>
        </div>
      )}
      {project && (
        <Panel
          title="可比历史耗时"
          description="仅使用执行输入、验收和依赖未变的已闭合观测；复用产物不计入样本。bootstrap 区间描述已有样本，不能保证未来表现。"
        >
          <EstimateTable estimates={project.estimates ?? []} titles={titles} />
          {project.warnings.map((warning, i) => (
            <p key={i} className="mt-2 text-xs text-amber-600">
              {warning.code} · {warning.message}
            </p>
          ))}
        </Panel>
      )}
      {runId && (
        <Panel
          title="What-if 调度实验"
          description="在 CPU 上从零重演整个冻结 DAG；不会启动任务、调用模型或修改运行状态。缺少耗时或成本时会明确返回未知。"
        >
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <Field label="历史耗时分位数">
              <NativeSelect
                value={quantile}
                onChange={(e) => {
                  setQuantile(Number(e.target.value));
                  setSimulation(null);
                }}
              >
                <option value={0.5}>P50</option>
                <option value={0.9}>P90</option>
              </NativeSelect>
            </Field>
            <Button
              variant="outline"
              disabled={scenarios.length >= 8}
              onClick={() => {
                setScenarios((previous) => [
                  ...previous,
                  newScenario(
                    maxConcurrent,
                    Math.max(
                      0,
                      ...previous.map((scenario) =>
                        Number(scenario.id.split("_").at(-1)),
                      ),
                    ),
                  ),
                ]);
                setSimulation(null);
              }}
            >
              添加比较方案
            </Button>
            <Button
              disabled={busy || !scenarios.length || !tasks.length}
              onClick={() => void act(simulate)}
            >
              模拟并比较方案
            </Button>
          </div>
          <div className="space-y-4">
            {scenarios.map((scenario, i) => (
              <ScenarioEditor
                key={scenario.id}
                value={scenario}
                tasks={tasks}
                estimates={project?.estimates ?? []}
                onChange={(next) => updateScenario(i, next)}
                onRemove={() => {
                  setScenarios((previous) =>
                    previous.filter((_, n) => n !== i),
                  );
                  setSimulation(null);
                }}
              />
            ))}
          </div>
          {simulation && (
            <div className="mt-5 space-y-4">
              <div className="overflow-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th className="p-2">方案</th>
                      <th className="p-2">状态</th>
                      <th className="p-2">并发</th>
                      <th className="p-2">总耗时</th>
                      <th className="p-2">并发利用率</th>
                      <th className="p-2">预算</th>
                    </tr>
                  </thead>
                  <tbody>
                    {simulation.scenarios.map((result) => (
                      <tr className="border-t" key={result.id}>
                        <td className="p-2">{result.label}</td>
                        <td className="p-2">{result.status}</td>
                        <td className="p-2">{result.maxConcurrent}</td>
                        <td className="p-2">
                          {seconds(result.makespanSeconds)}
                        </td>
                        <td className="p-2">{percent(result.utilization)}</td>
                        <td className="p-2">{result.budget.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {simulation.assumptions.map((text, i) => (
                <p className="text-xs text-muted-foreground" key={i}>
                  {text}
                </p>
              ))}
              {simulation.scenarios.map((result) => (
                <div
                  className="space-y-3 rounded-xl border p-4"
                  key={result.id}
                >
                  <h3 className="font-medium">{result.label}</h3>
                  <SimulatedTimeline result={result} titles={titles} />
                  <p className="text-xs">
                    {result.budget.message} · 已知成本{" "}
                    {result.budget.known.tokens} Token /{" "}
                    {result.budget.known.modelCalls} 模型 /{" "}
                    {result.budget.known.toolCalls} 工具
                  </p>
                  {result.unknownTaskIds.length > 0 && (
                    <p className="text-xs text-amber-600">
                      未知耗时：
                      {result.unknownTaskIds
                        .map((id) => titles[id] ?? id)
                        .join("、")}
                    </p>
                  )}
                  {result.budget.missingTaskIds.length > 0 && (
                    <p className="text-xs text-amber-600">
                      缺少成本假设：
                      {result.budget.missingTaskIds
                        .map((id) => titles[id] ?? id)
                        .join("、")}
                    </p>
                  )}
                  {Object.entries(result.resourceUtilization).map(
                    ([name, value]) => (
                      <p className="text-xs" key={name}>
                        资源 {name} 利用率 {percent(value)}
                      </p>
                    ),
                  )}
                  {result.blockers.map((blocker, i) => (
                    <p className="text-xs text-amber-600" key={i}>
                      {blocker.code} · {blocker.message} · {blocker.evidence}
                    </p>
                  ))}
                  {result.warnings.map((warning, i) => (
                    <p className="text-xs text-muted-foreground" key={i}>
                      {warning}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}
      <Panel
        title="轮次证据比较"
        description="只对执行条件可比的任务显示耗时差；计划或目标变更会说明不能直接比较的原因。"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="对比左轮次">
            <NativeSelect
              value={left}
              onChange={(e) => {
                setLeft(e.target.value);
                setComparison(null);
              }}
            >
              <option value="">选择轮次</option>
              {runs.map((run) => (
                <option value={run.id} key={run.id}>
                  v{run.planVersion} · {run.id.slice(0, 12)} · {run.status}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="对比右轮次">
            <NativeSelect
              value={right}
              onChange={(e) => {
                setRight(e.target.value);
                setComparison(null);
              }}
            >
              <option value="">选择轮次</option>
              {runs.map((run) => (
                <option value={run.id} key={run.id}>
                  v{run.planVersion} · {run.id.slice(0, 12)} · {run.status}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <Button
          className="mt-3"
          variant="outline"
          disabled={busy || !left || !right || left === right}
          onClick={() =>
            void act(async () =>
              setComparison(await compareRunInsights(projectId, left, right)),
            )
          }
        >
          比较真实证据
        </Button>
        {comparison && (
          <div className="mt-4 space-y-2">
            {comparison.tasks.map((task) => (
              <div key={task.specId} className="rounded border p-3 text-sm">
                <strong>
                  {task.right?.title || task.left?.title || task.specId}
                </strong>{" "}
                · {task.change}
                <p className="mt-1 text-xs text-muted-foreground">
                  {task.comparable
                    ? `右减左耗时 ${seconds(task.durationDeltaSeconds)} · Token 差 ${task.tokenDelta?.toLocaleString() ?? "未知"}`
                    : task.reason || "任务执行条件不可比"}
                </p>
              </div>
            ))}
            {comparison.warnings.map((warning, i) => (
              <p className="text-xs text-amber-600" key={i}>
                {warning.code} · {warning.message}
              </p>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
