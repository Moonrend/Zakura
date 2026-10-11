"use client";
import { useId, useMemo, useState } from "react";
import type { Analysis, Task } from "@/lib/project-execution";
import { Input } from "@/components/ui/input";
import { Panel, Status } from "./shared";
export function TaskGraph({
  analysis,
  tasks = [],
  onSelect,
}: {
  analysis: Analysis;
  tasks?: Task[];
  onSelect?: (id: string) => void;
}) {
  const marker = useId().replaceAll(":", "");
  const [filter, setFilter] = useState("");
  const nodeMap = useMemo(
    () => new Map(analysis.nodes.map((n) => [n.id, n])),
    [analysis],
  );
  const states = new Map(tasks.map((t) => [t.spec.id, t]));
  const width = Math.max(500, ...analysis.nodes.map((n) => n.x + 280));
  const height = Math.max(150, ...analysis.nodes.map((n) => n.y + 110));
  return (
    <Panel
      title="依赖与关键路径"
      description={`最长依赖链 ${analysis.criticalLength} 个任务步；${analysis.maxLayerWidth} 个任务处于最宽层。关键路径是结构分析，不代表模型耗时预测。`}
    >
      <div className="mb-4 flex flex-wrap gap-2">
        {analysis.criticalPath.map((id) => (
          <span
            key={id}
            className="rounded border border-primary/30 bg-primary/5 px-2 py-1 text-xs"
          >
            {nodeMap.get(id)?.title ?? id}
          </span>
        ))}
      </div>
      {analysis.nodes.length <= 300 && (
        <div className="max-h-[500px] overflow-auto rounded-lg border bg-background">
          <svg
            width={width}
            height={height}
            role="img"
            aria-label="任务依赖图，紫色边与节点表示关键路径"
          >
            <defs>
              <marker
                id={marker}
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
              >
                <path d="M0,0 L8,4 L0,8" fill="currentColor" />
              </marker>
            </defs>
            {analysis.edges.map((edge) => {
              const a = nodeMap.get(edge.from),
                b = nodeMap.get(edge.to);
              if (!a || !b) return null;
              const x1 = a.x + 240,
                y1 = a.y + 50,
                x2 = b.x + 12,
                y2 = b.y + 50;
              return (
                <path
                  key={`${edge.from}/${edge.to}`}
                  d={`M${x1},${y1} C${x1 + 40},${y1} ${x2 - 40},${y2} ${x2},${y2}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={edge.critical ? 2.5 : 1}
                  className={edge.critical ? "text-primary" : "text-border"}
                  markerEnd={`url(#${marker})`}
                />
              );
            })}
            {analysis.nodes.map((node) => {
              const state = states.get(node.id);
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x + 12},${node.y + 12})`}
                  role={onSelect ? "button" : undefined}
                  tabIndex={onSelect ? 0 : undefined}
                  aria-label={`${node.title}，${node.critical ? "关键任务，" : ""}${state?.status ?? "未开始"}`}
                  className={onSelect ? "cursor-pointer outline-none" : ""}
                  onClick={() => onSelect?.(node.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect?.(node.id);
                    }
                  }}
                >
                  <rect
                    width="230"
                    height="80"
                    rx="10"
                    className={
                      node.critical
                        ? "fill-card stroke-primary"
                        : "fill-card stroke-border"
                    }
                    strokeWidth={node.critical ? 2 : 1}
                  />
                  <text x="12" y="26" className="fill-foreground" fontSize="13">
                    {node.title.length > 18
                      ? `${node.title.slice(0, 18)}…`
                      : node.title}
                  </text>
                  <text
                    x="12"
                    y="48"
                    className="fill-muted-foreground"
                    fontSize="11"
                  >
                    {node.ancestors} 前置 · {node.descendants} 后续
                  </text>
                  <text
                    x="12"
                    y="65"
                    className="fill-muted-foreground"
                    fontSize="11"
                  >
                    {node.critical ? "关键任务" : `余量 ${node.slack} 步`}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}
      <div className="mt-4 space-y-2">
        <Input
          aria-label="搜索图中任务"
          placeholder="搜索任务名称或标识"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {analysis.nodes
          .filter((n) =>
            `${n.title} ${n.id}`.toLowerCase().includes(filter.toLowerCase()),
          )
          .slice(0, 100)
          .map((node) => {
            const state = states.get(node.id);
            return (
              <button
                type="button"
                key={node.id}
                className="flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm hover:bg-muted"
                onClick={() => onSelect?.(node.id)}
                disabled={!onSelect}
              >
                <span>
                  {node.title}
                  <span className="ml-2 text-xs text-muted-foreground">
                    第 {node.layer + 1} 层{node.critical ? " · 关键" : ""}
                  </span>
                </span>
                {state && <Status value={state.status} />}
              </button>
            );
          })}
      </div>
      {analysis.conflicts?.length > 0 && (
        <details className="mt-4 rounded-lg border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {analysis.conflicts.length} 组写入范围重叠
          </summary>
          <div className="mt-2 max-h-60 space-y-2 overflow-auto">
            {analysis.conflicts.slice(0, 100).map((c) => (
              <div key={`${c.leftTask}/${c.rightTask}`} className="text-xs">
                <span className="font-medium">
                  {nodeMap.get(c.leftTask)?.title ?? c.leftTask} /{" "}
                  {nodeMap.get(c.rightTask)?.title ?? c.rightTask}
                </span>{" "}
                · {c.ordered ? "依赖已确定先后" : "需要串行或显式处理合并"}
                <code className="ml-2 break-all">{c.witness}</code>
              </div>
            ))}
          </div>
        </details>
      )}
    </Panel>
  );
}
