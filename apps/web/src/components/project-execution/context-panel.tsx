"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  friendlyError,
  getRun,
  getRuns,
  type Project,
  type Run,
  type Task,
} from "@/lib/project-execution";
import {
  contextPlainText,
  contextReasonLabels,
  getTaskContext,
  type TaskContextPack,
} from "@/lib/project-context";
import { Code, ErrorNotice, Field, NativeSelect, Panel } from "./shared";

type FrozenTask = Task & { baseSnapshot?: string };
export function ContextPanel({ project }: { project: Project }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState("");
  const [tasks, setTasks] = useState<FrozenTask[]>([]);
  const [taskId, setTaskId] = useState("");
  const [query, setQuery] = useState("");
  const [maxBytes, setMaxBytes] = useState(4000);
  const [pack, setPack] = useState<TaskContextPack | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    generation.current++;
    setLoading(true);
    setError(null);
    setPack(null);
    setTasks([]);
    setTaskId("");
    setRuns([]);
    setRunId("");
    getRuns(project.id)
      .then(({ items }) => {
        if (active) {
          setRuns(items ?? []);
          setRunId(items?.[0]?.id ?? "");
        }
      })
      .catch((e) => {
        if (active) setError(friendlyError(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      generation.current++;
    };
  }, [project.id]);
  useEffect(() => {
    let active = true;
    generation.current++;
    setPack(null);
    setCopied(null);
    setTasks([]);
    setTaskId("");
    if (!runId) return;
    setLoading(true);
    getRun(project.id, runId)
      .then(({ tasks: nextTasks }) => {
        if (!active) return;
        const frozen = nextTasks as FrozenTask[];
        setTasks(frozen);
        setTaskId(
          frozen.find((task) => task.baseSnapshot)?.id ?? frozen[0]?.id ?? "",
        );
      })
      .catch((e) => {
        if (active) setError(friendlyError(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      generation.current++;
    };
  }, [project.id, runId]);
  const task = tasks.find((item) => item.id === taskId);
  const invalidate = () => {
    generation.current++;
    setPack(null);
    setCopied(null);
    setError(null);
  };
  const build = async () => {
    if (!task || !task.baseSnapshot || inFlight.current) return;
    if (!Number.isInteger(maxBytes) || maxBytes < 512 || maxBytes > 16000) {
      setError("输出预算须为 512–16000 整数字节。");
      return;
    }
    const current = ++generation.current;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setPack(null);
    setCopied(null);
    try {
      const result = await getTaskContext(
        project.id,
        runId,
        task.id,
        query,
        maxBytes,
      );
      if (generation.current === current) {
        if (result.snapshotId !== task.baseSnapshot)
          throw new Error("任务的冻结基线已更新，请重新选择任务。");
        setPack(result);
      }
    } catch (e) {
      if (generation.current === current) setError(friendlyError(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const copy = async (format: "json" | "text") => {
    if (!pack) return;
    try {
      await navigator.clipboard.writeText(
        format === "json" ? JSON.stringify(pack) : contextPlainText(pack),
      );
      setCopied(format === "json" ? "已复制 JSON" : "已复制引用文本");
    } catch {
      setError("剪贴板不可用。可从下方 JSON 预览手动复制。");
    }
  };
  return (
    <Panel
      title="任务代码上下文"
      description="从任务冻结的基线查找词法命中和源码图相关片段。选择理由可核查，引用内容作为数据提供给 Agent。"
    >
      <ErrorNotice message={error} />
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="运行">
          <NativeSelect
            value={runId}
            disabled={busy || loading}
            onChange={(e) => {
              invalidate();
              setRunId(e.target.value);
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
        <Field label="任务">
          <NativeSelect
            value={taskId}
            disabled={busy || loading}
            onChange={(e) => {
              invalidate();
              setTaskId(e.target.value);
            }}
          >
            <option value="">选择任务</option>
            {tasks.map((item) => (
              <option key={item.id} value={item.id}>
                {item.spec.title} · {item.status}
                {item.baseSnapshot ? "" : " · 基线尚未冻结"}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          label="补充查询"
          hint="可留空，仍使用任务描述、写入范围和验收路径。"
        >
          <Input
            value={query}
            disabled={busy}
            maxLength={1024}
            onChange={(e) => {
              invalidate();
              setQuery(e.target.value);
            }}
            placeholder="例如 checkpoint scheduler"
          />
        </Field>
        <Field label="完整 JSON 输出预算（字节）">
          <Input
            type="number"
            min={512}
            max={16000}
            step={1}
            value={maxBytes}
            disabled={busy}
            onChange={(e) => {
              invalidate();
              setMaxBytes(Number(e.target.value));
            }}
          />
        </Field>
      </div>
      {task && (
        <div className="mt-3 space-y-1 text-xs text-muted-foreground">
          <p className="break-all">
            冻结基线：{task.baseSnapshot ?? "待任务启动后冻结"}
          </p>
          <p>写入范围：{task.spec.writes.join(", ") || "无"}</p>
          <p>
            验收路径：
            {task.spec.checks
              .flatMap((check) => (check.path ? [check.path] : []))
              .join(", ") || "无"}
          </p>
        </div>
      )}
      <div className="my-4 flex flex-wrap items-center gap-2">
        <Button
          disabled={busy || loading || !task?.baseSnapshot}
          onClick={() => void build()}
        >
          {busy ? "检索中…" : "组装上下文"}
        </Button>
        {pack && (
          <>
            <Button variant="outline" onClick={() => void copy("text")}>
              复制引用文本
            </Button>
            <Button variant="outline" onClick={() => void copy("json")}>
              复制 JSON
            </Button>
          </>
        )}
        {copied && (
          <span className="text-xs text-muted-foreground" role="status">
            {copied}
          </span>
        )}
      </div>
      {pack && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Badge>
              {pack.bytes} / {pack.maxBytes} 字节
            </Badge>
            <Badge>
              {pack.scannedFiles} 个文件 · {pack.scannedBytes} 源码字节
            </Badge>
            {pack.partial && <Badge variant="warn">分析有未解析边界</Badge>}
            {pack.truncated && <Badge variant="warn">预算内截取</Badge>}
          </div>
          {pack.snippets.length === 0 && (
            <p className="text-sm text-muted-foreground">
              当前查询或输出预算没有保留片段。可调整查询或增加预算。
            </p>
          )}
          {pack.snippets.map((snippet) => (
            <article
              key={`${snippet.path}:${snippet.range.start.offset}:${snippet.range.end.offset}`}
              className="space-y-2 rounded-lg border p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <strong className="break-all text-sm">{snippet.path}</strong>
                {snippet.generated && <Badge>生成代码</Badge>}
                {snippet.partial && <Badge variant="warn">部分索引</Badge>}
                {snippet.truncated && <Badge>文件节选</Badge>}
              </div>
              <p className="break-all text-xs text-muted-foreground">
                SHA-256 {snippet.hash}
                <br />
                字节 {snippet.range.start.offset}..{snippet.range.end.offset} ·
                行列 {snippet.range.start.line}:{snippet.range.start.column}..
                {snippet.range.end.line}:{snippet.range.end.column}
              </p>
              <ul className="list-inside list-disc text-xs text-muted-foreground">
                {snippet.reasons.map((reason, index) => (
                  <li key={index}>
                    {contextReasonLabels[reason.kind] ?? reason.kind}
                    {reason.via ? ` · ${reason.via}` : ""} · {reason.confidence}
                  </li>
                ))}
              </ul>
              <Code value={snippet.text} limit={16000} />
            </article>
          ))}
          {(pack.missingCount > 0 ||
            pack.boundaryCount > 0 ||
            pack.omittedCount > 0) && (
            <details className="rounded-lg border p-3">
              <summary className="cursor-pointer text-sm">
                缺失 {pack.missingCount} · 未解析边界 {pack.boundaryCount} ·
                未保留候选 {pack.omittedCount}
              </summary>
              <p className="my-2 text-xs text-muted-foreground">
                路径列表也受预算限制，数量包括未显示的项目。
              </p>
              <Code
                value={{
                  missing: pack.missing,
                  boundaries: pack.boundaries,
                  omittedPaths: pack.omittedPaths,
                }}
                limit={16000}
              />
            </details>
          )}
          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm">
              完整上下文 JSON
            </summary>
            <Code value={JSON.stringify(pack)} limit={16000} />
          </details>
        </div>
      )}
      {!runs.length && !loading && (
        <p className="text-sm text-muted-foreground">
          项目运行创建并冻结任务基线后，可查看任务专属上下文。
        </p>
      )}
    </Panel>
  );
}
