"use client";
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  getTask,
  retryTask,
  reviewTask,
  resolveOperation,
  friendlyError,
  CHECK_LABELS,
  type CheckKind,
  type TaskDetail,
  type Operation,
} from "@/lib/project-execution";
import {
  Code,
  ErrorNotice,
  Field,
  NativeSelect,
  Panel,
  Status,
} from "./shared";

export function TaskInspector({
  projectId,
  runId,
  taskId,
  refreshToken,
  onChanged,
  onArtifact,
}: {
  projectId: string;
  runId: string;
  taskId: string;
  refreshToken?: number;
  onChanged: () => void;
  onArtifact: (snapshotId: string, path?: string) => void;
}) {
  const [data, setData] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState("");
  const [selectedOperation, setSelectedOperation] = useState<Operation | null>(
    null,
  );
  const reload = useCallback(async () => {
    try {
      const next = await getTask(projectId, runId, taskId);
      setData(next);
      setError(null);
    } catch (error) {
      setError(friendlyError(error));
    }
  }, [projectId, runId, taskId]);
  useEffect(() => {
    let alive = true;
    setData(null);
    setComment("");
    setSelectedOperation(null);
    void getTask(projectId, runId, taskId)
      .then((value) => {
        if (alive) {
          setData(value);
          setError(null);
        }
      })
      .catch((error) => {
        if (alive) setError(friendlyError(error));
      });
    return () => {
      alive = false;
    };
  }, [projectId, runId, taskId]);
  useEffect(() => {
    if (refreshToken !== undefined) void reload();
  }, [refreshToken, reload]);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
      onChanged();
    } catch (error) {
      setError(friendlyError(error));
    } finally {
      setBusy(false);
    }
  };
  if (!data)
    return (
      <Panel title="任务详情">
        <ErrorNotice message={error} />
        <p className="text-sm text-muted-foreground">
          正在读取检查点、验收及操作记录…
        </p>
      </Panel>
    );
  const task = data.task;
  const verifications = data.verifications ?? [];
  const operations = data.operations ?? [];
  const reviews = data.reviews ?? [];
  const currentVerification = verifications.find(
    (v) => v.snapshotId === task.snapshotId && v.status === "passed",
  );
  return (
    <div className="space-y-4">
      <Panel
        title={task.spec.title}
        actions={
          <div className="flex items-center gap-2">
            <Status value={task.status} />
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="刷新任务详情"
              onClick={() => void reload()}
            >
              <RefreshCw />
            </Button>
          </div>
        }
      >
        <ErrorNotice message={error} />
        <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            尝试{" "}
            <strong>
              {task.attempt}/{task.spec.maxAttempts || 1}
            </strong>
          </div>
          <div>
            已存检查点 <strong>{data.checkpoint?.sequence ?? 0}</strong>
          </div>
          <div>
            独立分支{" "}
            <code className="break-all text-xs">
              {task.branchId || "尚未创建"}
            </code>
          </div>
        </div>
        {task.reusedFromRunId && (
          <p className="mt-3 rounded border border-success/30 bg-success/5 p-2 text-xs">
            复用上一轮已验收产物 ·{" "}
            <code className="break-all">{task.reusedFromRunId}</code>
            ；未重放模型或工具副作用。
          </p>
        )}
        {task.error && (
          <p className="mt-3 whitespace-pre-wrap text-sm text-destructive">
            {task.error}
          </p>
        )}
        {task.result && (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium">
              Agent 交付说明
            </summary>
            <Code value={task.result} />
          </details>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {["failed", "cancelled", "blocked"].includes(task.status) && (
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => void act(() => retryTask(projectId, runId, task))}
            >
              <RotateCcw />
              重新尝试
            </Button>
          )}
          {task.snapshotId && (
            <Button
              variant="outline"
              onClick={() =>
                onArtifact(
                  task.snapshotId,
                  task.spec.checks.find((c) => c.path)?.path,
                )
              }
            >
              查看冻结产物
            </Button>
          )}
        </div>
      </Panel>
      {task.status === "waiting_review" && (
        <Panel
          title="审核当前验收产物"
          description="决定绑定当前快照；后续产物变化后旧审核不会用于放行。"
        >
          <code className="block break-all rounded bg-muted p-2 text-xs">
            {task.snapshotId}
          </code>
          <div className="mt-3">
            <Field label="审核意见">
              <Textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="记录检查过的产物及通过或拒绝的理由"
              />
            </Field>
          </div>
          {!currentVerification && (
            <p className="mt-2 text-sm text-destructive">
              当前快照尚无通过的验收记录。
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <Button
              disabled={busy || !comment.trim() || !currentVerification}
              onClick={() =>
                void act(() =>
                  reviewTask(
                    projectId,
                    runId,
                    task.id,
                    task.snapshotId,
                    "approve",
                    comment,
                  ),
                )
              }
            >
              <ShieldCheck />
              批准此快照
            </Button>
            <Button
              disabled={busy || !comment.trim()}
              variant="destructive"
              onClick={() =>
                void act(() =>
                  reviewTask(
                    projectId,
                    runId,
                    task.id,
                    task.snapshotId,
                    "reject",
                    comment,
                  ),
                )
              }
            >
              拒绝并记录理由
            </Button>
          </div>
        </Panel>
      )}
      <Panel
        title="验收证据"
        description="每条条件都绑定文件内容哈希、冻结规则与快照；缺失、错误及截断会明确显示。"
      >
        {verifications.length ? (
          verifications.map((v) => (
            <details
              key={v.id}
              className="mb-3 rounded-lg border p-3"
              open={v.snapshotId === task.snapshotId}
            >
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                <Status value={v.status} />
                <span>{new Date(v.createdAt).toLocaleString("zh-CN")}</span>
                <code className="max-w-full break-all text-xs text-muted-foreground">
                  {v.snapshotId}
                </code>
              </summary>
              <div className="mt-3 space-y-3">
                {v.checks.map((check) => (
                  <div key={check.id} className="rounded-lg bg-muted/40 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Status value={check.status} />
                      <strong className="text-sm">
                        {task.spec.checks.find((c) => c.id === check.id)
                          ?.title ||
                          CHECK_LABELS[check.kind as CheckKind] ||
                          check.kind}
                      </strong>
                      <span className="text-xs text-muted-foreground">
                        {check.required ? "必需" : "可选"} · {check.durationMs}{" "}
                        ms
                      </span>
                    </div>
                    <p className="mt-2 text-sm">{check.summary}</p>
                    {check.output && <Code value={check.output} />}
                    {check.evidence && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          查看哈希与隔离证据
                          {check.evidence.truncated ? " · 输出截断" : ""}
                        </summary>
                        <Code value={check.evidence} />
                      </details>
                    )}
                  </div>
                ))}
              </div>
            </details>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            Agent 完成执行后会对冻结产物运行验收。
          </p>
        )}
      </Panel>
      <Panel
        title="工具操作与恢复"
        description="先记录意图再执行。结果不明的外部操作由成员核实，不能默认重新发送。"
      >
        {operations.length ? (
          <div className="space-y-3">
            {operations.map((operation) => (
              <div key={operation.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Status value={operation.status} />
                    <strong className="text-sm">{operation.call.name}</strong>
                    <span className="text-xs text-muted-foreground">
                      {operation.call.effect}
                    </span>
                  </div>
                  {["pending_approval", "unknown"].includes(
                    operation.status,
                  ) && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setSelectedOperation(operation)}
                    >
                      审核此操作
                    </Button>
                  )}
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    精确参数与结果
                  </summary>
                  <Code
                    value={{
                      arguments: operation.call.arguments,
                      argumentsHash: operation.argumentsHash,
                      result: operation.result,
                      error: operation.error,
                      operationId: operation.id,
                    }}
                  />
                </details>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">尚无工具操作。</p>
        )}
        {selectedOperation && (
          <OperationResolution
            key={selectedOperation.id}
            operation={selectedOperation}
            busy={busy}
            onClose={() => setSelectedOperation(null)}
            onSubmit={(decision, comment, result, error) =>
              void act(async () => {
                await resolveOperation(
                  projectId,
                  runId,
                  selectedOperation,
                  decision,
                  comment,
                  result,
                  error,
                );
                setSelectedOperation(null);
              })
            }
          />
        )}
      </Panel>
      <Panel
        title="检查点与上下文"
        description="展示已持久化的模型决定与下一步工具位置。"
      >
        <div className="flex flex-wrap gap-3 text-sm">
          <span>序列：{data.checkpoint?.sequence ?? 0}</span>
          <span>下一工具：{data.checkpoint?.nextTool ?? 0}</span>
        </div>
        <details className="mt-3">
          <summary className="cursor-pointer text-sm">
            查看最近的持久化决定
          </summary>
          <Code value={data.checkpoint?.decision ?? "暂无决定"} />
        </details>
        <details className="mt-3">
          <summary className="cursor-pointer text-sm">查看检查点消息</summary>
          <Code value={data.checkpoint?.messages ?? []} />
        </details>
      </Panel>
      {reviews.length > 0 && (
        <Panel title="人工审核记录">
          <div className="space-y-3">
            {reviews.map((review) => (
              <div key={review.id} className="rounded-lg border p-3">
                <div className="flex gap-2">
                  <Status value={review.decision} />
                  <span className="text-xs text-muted-foreground">
                    {new Date(review.createdAt).toLocaleString("zh-CN")}
                  </span>
                </div>
                <p className="mt-2 text-sm">{review.comment}</p>
                <code className="mt-1 block break-all text-xs text-muted-foreground">
                  {review.snapshotId}
                </code>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}
function OperationResolution({
  operation,
  busy,
  onClose,
  onSubmit,
}: {
  operation: Operation;
  busy: boolean;
  onClose: () => void;
  onSubmit: (
    decision: "approved" | "denied" | "completed" | "failed" | "not_performed",
    comment: string,
    result?: unknown,
    error?: string,
  ) => void;
}) {
  const approval = operation.status === "pending_approval";
  const [decision, setDecision] = useState<
    "approved" | "denied" | "completed" | "failed" | "not_performed"
  >(approval ? "approved" : "completed");
  const [comment, setComment] = useState("");
  const [resultText, setResultText] = useState("{}");
  const [failure, setFailure] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    setError(null);
    let result: unknown;
    if (decision === "completed") {
      try {
        result = JSON.parse(resultText);
      } catch {
        setError("实际结果必须是有效 JSON");
        return;
      }
    }
    onSubmit(decision, comment, result, failure || undefined);
  };
  return (
    <div className="mt-4 rounded-xl border border-primary/30 bg-primary/5 p-4">
      <h3 className="font-semibold">
        {approval ? "审查待执行操作" : "核实结果不明的操作"}
      </h3>
      <p className="my-2 text-sm text-muted-foreground">
        {approval
          ? "批准将允许执行以下精确参数。"
          : "核对目标系统的状态或日志，再说明操作实际是否发生。确认未执行会允许恢复后再次执行。"}
      </p>
      <Code
        value={{
          tool: operation.call.name,
          effect: operation.call.effect,
          arguments: operation.call.arguments,
        }}
      />
      <div className="mt-3 space-y-3">
        <Field label="决定">
          <NativeSelect
            value={decision}
            onChange={(e) => {
              setDecision(e.target.value as typeof decision);
              setConfirmed(false);
            }}
          >
            {approval ? (
              <>
                <option value="approved">批准执行</option>
                <option value="denied">拒绝执行</option>
              </>
            ) : (
              <>
                <option value="completed">已执行且成功</option>
                <option value="failed">已执行但失败</option>
                <option value="not_performed">
                  确认没有执行，可以恢复执行
                </option>
              </>
            )}
          </NativeSelect>
        </Field>
        {decision === "completed" && (
          <Field label="目标系统实际返回的结果 JSON">
            <Textarea
              className="font-mono"
              value={resultText}
              onChange={(e) => setResultText(e.target.value)}
            />
          </Field>
        )}
        {["failed", "denied"].includes(decision) && (
          <Field label="失败或拒绝原因">
            <Input
              value={failure}
              onChange={(e) => setFailure(e.target.value)}
            />
          </Field>
        )}
        <Field label="核实依据或审查意见">
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="例如：目标系统日志中的请求标识与实际状态"
          />
        </Field>
        <label className="flex items-start gap-2 text-sm">
          <input
            className="mt-1"
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>
            {approval
              ? "我已检查本次精确参数并确认此决定。"
              : "我已核实实际执行状态，此记录可用于恢复任务。"}
          </span>
        </label>
        <ErrorNotice message={error} />
        <div className="flex gap-2">
          <Button
            disabled={
              busy ||
              !confirmed ||
              !comment.trim() ||
              (["failed", "denied"].includes(decision) && !failure.trim())
            }
            onClick={submit}
          >
            提交决定
          </Button>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </div>
  );
}
