"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  Network,
  Play,
  Download,
  Upload,
  Plus,
  Trash2,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import {
  parseWorkflowRequest,
  workflowDuration,
  workflowTimeline,
  type WorkflowNode,
  type WorkflowRequest,
  type WorkflowResult,
  type WorkflowTemplate,
  type WorkflowValidation,
} from "@zakura/shared";
import { Button } from "@/components/ui/button";
import {
  fetchWorkflowTemplates,
  planWorkflow,
  validateWorkflow,
  downloadWorkflow,
} from "@/lib/workflows";

const initial: WorkflowRequest = {
  definition: {
    version: 1,
    name: "新工作流",
    nodes: [{ id: "start", name: "开始", durationMs: 10000 }],
  },
  options: {
    maxParallel: 4,
    resources: {},
    concurrencyLimits: {},
    mode: "nominal",
    priority: "criticalPath",
  },
};
const inputClass = "w-full rounded-md border bg-background px-3 py-2 text-sm";

function Numeric({
  label,
  value,
  onChange,
  min = 0,
  max,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <label className="grid gap-1.5 text-xs text-muted-foreground">
      {label}
      <input
        className={inputClass}
        type="number"
        min={min}
        max={max}
        step="1"
        value={value}
        onChange={(event) => {
          const number = Number(event.target.value);
          if (Number.isSafeInteger(number)) onChange(number);
        }}
      />
    </label>
  );
}

function Diagnostics({ validation }: { validation: WorkflowValidation }) {
  return (
    <div className="space-y-2" aria-live="polite">
      {validation.valid && (
        <div className="flex items-center gap-2 text-sm text-green-600">
          <CheckCircle2 size={16} />
          结构与资源校验通过
        </div>
      )}
      {validation.diagnostics.map((item, index) => (
        <div
          key={`${item.code}-${index}`}
          className={`rounded-lg border p-3 text-sm ${item.severity === "error" ? "border-destructive/40 bg-destructive/5" : "border-amber-500/40 bg-amber-500/5"}`}
        >
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle size={15} />
            {item.code}
            {item.nodeIds?.length ? ` · ${item.nodeIds.join(", ")}` : ""}
          </div>
          <p className="mt-1">{item.message}</p>
          <p className="mt-1 text-xs text-muted-foreground">{item.path}</p>
        </div>
      ))}
    </div>
  );
}

function Graph({
  request,
  result,
}: {
  request: WorkflowRequest;
  result: WorkflowResult;
}) {
  const layers = result.validation.layers;
  const positions = new Map<string, { x: number; y: number }>();
  let rows = 1;
  layers.forEach((layer, col) => {
    rows = Math.max(rows, layer.length);
    layer.forEach((id, row) =>
      positions.set(id, { x: col * 210 + 20, y: row * 74 + 20 }),
    );
  });
  const critical = new Set(
    result.analysis?.nodes
      .filter((node) => node.critical)
      .map((node) => node.id),
  );
  return (
    <div className="overflow-auto rounded-lg border p-3">
      <svg
        role="img"
        aria-label="工作流依赖图；蓝色节点位于关键路径"
        width={Math.max(420, layers.length * 210)}
        height={Math.max(100, rows * 74 + 20)}
      >
        {request.definition.nodes.flatMap((node) =>
          (node.dependsOn ?? []).map((parent) => {
            const from = positions.get(parent),
              to = positions.get(node.id);
            if (!from || !to) return null;
            return (
              <path
                key={`${parent}-${node.id}`}
                d={`M ${from.x + 170} ${from.y + 25} C ${from.x + 195} ${from.y + 25}, ${to.x - 25} ${to.y + 25}, ${to.x} ${to.y + 25}`}
                fill="none"
                stroke="currentColor"
                opacity="0.35"
              />
            );
          }),
        )}
        {request.definition.nodes.map((node) => {
          const pos = positions.get(node.id);
          if (!pos) return null;
          return (
            <g key={node.id} transform={`translate(${pos.x},${pos.y})`}>
              <title>
                {node.name || node.id} · {workflowDuration(node.durationMs)}
              </title>
              <rect
                width="170"
                height="50"
                rx="9"
                fill={critical.has(node.id) ? "#3b82f6" : "#64748b"}
                opacity="0.13"
                stroke={critical.has(node.id) ? "#3b82f6" : "#64748b"}
              />
              <text x="10" y="21" fill="currentColor" fontSize="12">
                {(node.name || node.id).slice(0, 16)}
              </text>
              <text
                x="10"
                y="38"
                fill="currentColor"
                opacity="0.55"
                fontSize="10"
              >
                {node.id.slice(0, 22)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function PlanResult({
  result,
  title,
}: {
  result: WorkflowResult;
  title: string;
}) {
  const { analysis, schedule } = result;
  if (!analysis || !schedule)
    return <Diagnostics validation={result.validation} />;
  return (
    <section className="space-y-4 rounded-xl border p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            downloadWorkflow(result, `zakura-plan-${result.options.mode}.json`)
          }
        >
          <Download size={14} />
          导出计划
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["模拟完成", workflowDuration(schedule.makespanMs)],
          ["依赖关键路径", workflowDuration(analysis.criticalPathMs)],
          ["估算成本（货币单位）", (analysis.totalCostMicros / 1e6).toFixed(6)],
          ["并发利用率", `${(schedule.utilization * 100).toFixed(1)}%`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg bg-muted/50 p-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
              {value}
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        峰值并发 {schedule.peakParallel} ·{" "}
        {schedule.optimal ? "完成时间达到理论下界" : "启发式调度，未证明最优"} ·
        关键路径：{analysis.criticalPath.join(" → ")}
      </p>
      <Diagnostics validation={result.validation} />
      <div className="space-y-2" aria-label="任务时间线">
        {schedule.slots.map((slot) => {
          const geometry = workflowTimeline(slot, schedule.makespanMs);
          const node = analysis.nodes.find((item) => item.id === slot.nodeId);
          return (
            <div
              key={slot.nodeId}
              className="grid grid-cols-[100px_1fr] items-center gap-3 text-xs"
            >
              <span className="truncate" title={slot.nodeId}>
                {slot.nodeId}
              </span>
              <div
                className="relative h-7 rounded bg-muted/50"
                title={`${workflowDuration(slot.startMs)} → ${workflowDuration(slot.endMs)}；资源等待 ${workflowDuration(slot.waitMs)}`}
              >
                {geometry && (
                  <div
                    className={`absolute inset-y-1 rounded ${node?.critical ? "bg-blue-500" : "bg-emerald-500"}`}
                    style={{
                      left: `${geometry.left}%`,
                      width: `${geometry.width}%`,
                      minWidth: "2px",
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="overflow-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b text-muted-foreground">
              {["节点", "开始", "结束", "资源等待", "依赖余量", "资源"].map(
                (heading) => (
                  <th key={heading} className="p-2 font-medium">
                    {heading}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {schedule.slots.map((slot) => (
              <tr key={slot.nodeId} className="border-b">
                <td className="p-2">{slot.nodeId}</td>
                <td className="p-2">{workflowDuration(slot.startMs)}</td>
                <td className="p-2">{workflowDuration(slot.endMs)}</td>
                <td className="p-2">{workflowDuration(slot.waitMs)}</td>
                <td className="p-2">
                  {workflowDuration(
                    analysis.nodes.find((node) => node.id === slot.nodeId)
                      ?.slackMs ?? 0,
                  )}
                </td>
                <td className="p-2">
                  {Object.entries(slot.resources)
                    .map(([name, units]) => `${name}:${units}`)
                    .join(", ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function WorkflowsPage() {
  const [request, setRequest] = useState<WorkflowRequest>(initial);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [results, setResults] = useState<WorkflowResult[]>([]);
  const [validation, setValidation] = useState<WorkflowValidation | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [json, setJSON] = useState("");
  const controller = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const abort = new AbortController();
    fetchWorkflowTemplates(abort.signal)
      .then(setTemplates)
      .catch((err: unknown) => {
        if (!abort.signal.aborted)
          setError(err instanceof Error ? err.message : "无法加载模板");
      });
    return () => {
      abort.abort();
      controller.current?.abort();
    };
  }, []);

  function edit(next: WorkflowRequest) {
    revision.current++;
    controller.current?.abort();
    setBusy(false);
    setRequest(next);
    setResults([]);
    setValidation(null);
    setError("");
    setJSON(JSON.stringify(next, null, 2));
  }
  function updateNode(index: number, change: Partial<WorkflowNode>) {
    edit({
      ...request,
      definition: {
        ...request.definition,
        nodes: request.definition.nodes.map((node, i) =>
          i === index ? { ...node, ...change } : node,
        ),
      },
    });
  }
  function options(change: Partial<WorkflowRequest["options"]>) {
    edit({ ...request, options: { ...request.options, ...change } });
  }

  async function run(compare: boolean, validateOnly = false) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const token = revision.current;
    setBusy(true);
    setError("");
    setResults([]);
    setValidation(null);
    try {
      // Apply the same shape checks to edited inputs and imported files.
      const safe = parseWorkflowRequest(JSON.stringify(request));
      if (validateOnly) {
        const value = await validateWorkflow(safe, abort.signal);
        if (revision.current === token && !abort.signal.aborted)
          setValidation(value);
      } else {
        const modes = compare
          ? (["nominal", "retryBound"] as const)
          : [safe.options.mode || "nominal"];
        const values = await Promise.all(
          modes.map((mode) =>
            planWorkflow(
              { ...safe, options: { ...safe.options, mode } },
              abort.signal,
            ),
          ),
        );
        if (revision.current === token && !abort.signal.aborted)
          setResults(values);
      }
    } catch (err) {
      if (!abort.signal.aborted && revision.current === token)
        setError(err instanceof Error ? err.message : "预检失败");
    } finally {
      if (controller.current === abort) setBusy(false);
    }
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError("文件超过 2 MiB");
      return;
    }
    const token = revision.current;
    try {
      const imported = parseWorkflowRequest(await file.text());
      if (revision.current === token) edit(imported);
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    }
  }

  function addNode() {
    const ids = new Set(request.definition.nodes.map((node) => node.id));
    let index = 1;
    while (ids.has(`step${index}`)) index++;
    edit({
      ...request,
      definition: {
        ...request.definition,
        nodes: [
          ...request.definition.nodes,
          { id: `step${index}`, name: `步骤 ${index}`, durationMs: 10000 },
        ],
      },
    });
  }

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-7">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Network />
            工作流预检
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            先检查依赖、配额、时间和成本，再安排任务。这里仅做模拟，不执行 Agent
            或工具，也不会产生模型费用。
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => fileInput.current?.click()}>
            <Upload size={15} />
            导入
          </Button>
          <Button
            variant="outline"
            onClick={() => downloadWorkflow(request, "zakura-workflow.json")}
          >
            <Download size={15} />
            导出定义
          </Button>
        </div>
      </header>
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={importFile}
      />
      <section className="space-y-4 rounded-xl border p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            工作流名称
            <input
              className={inputClass}
              value={request.definition.name}
              maxLength={256}
              onChange={(event) =>
                edit({
                  ...request,
                  definition: {
                    ...request.definition,
                    name: event.target.value,
                  },
                })
              }
            />
          </label>
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            从模板开始
            <select
              className={inputClass}
              defaultValue=""
              onChange={(event) => {
                const template = templates.find(
                  (item) => item.id === event.target.value,
                );
                if (template) edit(structuredClone(template.request));
                event.target.value = "";
              }}
            >
              <option value="">选择模板…</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.request.definition.name} · {template.description}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Numeric
            label="最大并发"
            value={request.options.maxParallel ?? 4}
            min={1}
            max={128}
            onChange={(value) => options({ maxParallel: value })}
          />
          <Numeric
            label="预算（微单位；0 为不限）"
            value={request.options.budgetMicros ?? 0}
            max={1e15}
            onChange={(value) => options({ budgetMicros: value })}
          />
          <Numeric
            label="期限（毫秒；0 为不限）"
            value={request.options.deadlineMs ?? 0}
            max={1e15}
            onChange={(value) => options({ deadlineMs: value })}
          />
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            估算场景
            <select
              className={inputClass}
              value={request.options.mode ?? "nominal"}
              onChange={(event) =>
                options({
                  mode: event.target.value as "nominal" | "retryBound",
                })
              }
            >
              <option value="nominal">正常成功</option>
              <option value="retryBound">重试保守场景</option>
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <span>
            资源容量：
            {Object.entries(request.options.resources ?? {})
              .map(([name, units]) => `${name}=${units}`)
              .join("，") || "未配置"}
          </span>
          <span>
            并发分组：
            {Object.entries(request.options.concurrencyLimits ?? {})
              .map(([name, units]) => `${name}=${units}`)
              .join("，") || "未配置"}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          成本均使用同一种货币；1,000,000 微单位 = 1
          货币单位。容量、重试参数和分组可在下方 JSON 编辑器中修改。
        </p>
      </section>
      <section className="space-y-4 rounded-xl border p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">
            步骤 · {request.definition.nodes.length}/128
          </h2>
          <Button
            size="sm"
            variant="outline"
            onClick={addNode}
            disabled={request.definition.nodes.length >= 128}
          >
            <Plus size={14} />
            添加步骤
          </Button>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {request.definition.nodes.map((node, index) => (
            <article
              className="space-y-3 rounded-lg border p-4"
              key={`${index}-${node.id}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {node.id}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`删除步骤 ${node.id}`}
                  disabled={request.definition.nodes.length === 1}
                  onClick={() =>
                    edit({
                      ...request,
                      definition: {
                        ...request.definition,
                        nodes: request.definition.nodes
                          .filter((_, i) => i !== index)
                          .map((item) => ({
                            ...item,
                            dependsOn: (item.dependsOn ?? []).filter(
                              (id) => id !== node.id,
                            ),
                          })),
                      },
                    })
                  }
                >
                  <Trash2 size={14} />
                </Button>
              </div>
              <label className="grid gap-1 text-xs text-muted-foreground">
                名称
                <input
                  className={inputClass}
                  value={node.name ?? node.id}
                  onChange={(event) =>
                    updateNode(index, { name: event.target.value })
                  }
                />
              </label>
              <div className="grid grid-cols-3 gap-3">
                <Numeric
                  label="耗时（ms）"
                  min={1}
                  max={86400000}
                  value={node.durationMs}
                  onChange={(value) => updateNode(index, { durationMs: value })}
                />
                <Numeric
                  label="每次成本（微单位）"
                  value={node.costMicros ?? 0}
                  max={1e12}
                  onChange={(value) => updateNode(index, { costMicros: value })}
                />
                <Numeric
                  label="最多尝试"
                  min={1}
                  max={10}
                  value={node.maxAttempts ?? 1}
                  onChange={(value) =>
                    updateNode(index, { maxAttempts: value })
                  }
                />
              </div>
              <fieldset>
                <legend className="mb-2 text-xs text-muted-foreground">
                  前置步骤
                </legend>
                <div className="flex flex-wrap gap-3">
                  {request.definition.nodes
                    .filter((other) => other.id !== node.id)
                    .map((other) => (
                      <label
                        key={other.id}
                        className="flex items-center gap-1.5 text-xs"
                      >
                        <input
                          type="checkbox"
                          checked={(node.dependsOn ?? []).includes(other.id)}
                          onChange={(event) =>
                            updateNode(index, {
                              dependsOn: event.target.checked
                                ? [...(node.dependsOn ?? []), other.id]
                                : (node.dependsOn ?? []).filter(
                                    (id) => id !== other.id,
                                  ),
                            })
                          }
                        />
                        {other.id}
                      </label>
                    ))}
                  {request.definition.nodes.length === 1 && (
                    <span className="text-xs text-muted-foreground">
                      无其他步骤
                    </span>
                  )}
                </div>
              </fieldset>
            </article>
          ))}
        </div>
      </section>
      <details className="rounded-xl border p-5">
        <summary
          className="cursor-pointer text-sm font-medium"
          onClick={() => {
            if (!json) setJSON(JSON.stringify(request, null, 2));
          }}
        >
          高级 JSON 编辑器
        </summary>
        <p className="my-3 text-xs text-muted-foreground">
          可编辑节点 ID、资源容量、超时、退避与并发分组；点击应用后再预检。
        </p>
        <textarea
          className={`${inputClass} min-h-80 font-mono`}
          aria-label="工作流 JSON"
          spellCheck={false}
          value={json}
          onChange={(event) => setJSON(event.target.value)}
        />
        <Button
          className="mt-3"
          variant="outline"
          onClick={() => {
            try {
              edit(parseWorkflowRequest(json));
            } catch (err) {
              setError(err instanceof Error ? err.message : "JSON 无效");
            }
          }}
        >
          应用 JSON
        </Button>
      </details>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void run(false)}>
          <Play size={15} />
          {busy ? "计算中…" : "生成计划"}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void run(true)}
        >
          对比正常 / 重试场景
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void run(false, true)}
        >
          仅检查定义
        </Button>
      </div>
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
        >
          {error}
        </div>
      )}
      {validation && <Diagnostics validation={validation} />}
      {results[0]?.validation.valid && (
        <Graph request={request} result={results[0]} />
      )}
      <div
        className={`grid gap-5 ${results.length > 1 ? "xl:grid-cols-2" : ""}`}
      >
        {results.map((result, index) => (
          <PlanResult
            key={index}
            result={result}
            title={
              result.options.mode === "retryBound"
                ? "重试保守场景"
                : "正常成功场景"
            }
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        重试场景假设最后一次尝试成功，之前的尝试耗尽超时；资源在退避期间持续占用。不包含模型排队、网络延迟与未知失败，也不保证任务最终成功。预算和期限用于预警，不是执行限制。
      </p>
    </main>
  );
}
