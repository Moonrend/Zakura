"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  getMerges,
  getMerge,
  previewMerge,
  resolveMerge,
  reviewMerge,
  applyMerge,
  reconcileMerge,
  utf8Base64,
  friendlyError,
  type Run,
  type Task,
  type MergePreview,
  type MergeResolution,
} from "@/lib/project-execution";
import {
  Code,
  ErrorNotice,
  Field,
  NativeSelect,
  Panel,
  Status,
} from "./shared";
export function MergeWorkbench({
  projectId,
  run,
  tasks,
  onArtifact,
  initialPreviewId,
}: {
  projectId: string;
  run: Run;
  tasks: Task[];
  onArtifact: (snapshotId: string, path?: string) => void;
  initialPreviewId?: string;
}) {
  const [items, setItems] = useState<MergePreview[]>([]);
  const [selected, setSelected] = useState<MergePreview | null>(null);
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [confirmation, setConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [audit, setAudit] = useState<unknown[]>([]);
  const reload = useCallback(async () => {
    const response = await getMerges(projectId, run.id);
    setItems(response.items ?? []);
  }, [projectId, run.id]);
  useEffect(() => {
    let alive = true;
    void getMerges(projectId, run.id)
      .then((r) => {
        if (alive) setItems(r.items ?? []);
      })
      .catch((e) => {
        if (alive) setError(friendlyError(e));
      });
    return () => {
      alive = false;
    };
  }, [projectId, run.id]);
  useEffect(() => {
    if (!initialPreviewId) return;
    let active = true;
    setSelected(null);
    void getMerge(projectId, run.id, initialPreviewId)
      .then((data) => {
        if (active) {
          setSelected(data.preview);
          setAudit(data.audit);
          setConfirmation(false);
          setComment("");
        }
      })
      .catch(
        (e) =>
          active &&
          setError(`合并审核目标已删除或不可访问：${friendlyError(e)}`),
      );
    return () => {
      active = false;
    };
  }, [projectId, run.id, initialPreviewId]);
  const open = async (preview: MergePreview) => {
    setSelected(preview);
    setConfirmation(false);
    setComment("");
    setAudit([]);
    try {
      const data = await getMerge(projectId, run.id, preview.id);
      setSelected(data.preview);
      setAudit(data.audit);
    } catch (e) {
      setError(friendlyError(e));
    }
  };
  const act = async (fn: () => Promise<MergePreview>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      await reload();
      await open(next);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <Panel
        title="合并产物到原工作区"
        description="先选择已验收任务，生成冻结合并预览；合并后的完整产物会再次执行验收，然后由成员审核。"
      >
        <ErrorNotice message={error} />
        <div className="mt-3 flex flex-wrap gap-4">
          {tasks
            .filter((t) => t.status === "completed")
            .map((task) => (
              <label key={task.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={taskIds.includes(task.id)}
                  onChange={(e) =>
                    setTaskIds(
                      e.target.checked
                        ? [...taskIds, task.id]
                        : taskIds.filter((id) => id !== task.id),
                    )
                  }
                />
                {task.spec.title}
              </label>
            ))}
        </div>
        {run.status !== "completed" && (
          <p className="mt-3 text-sm text-muted-foreground">
            此轮所有任务完成后才能生成合并预览。
          </p>
        )}
        <div className="mt-3 flex gap-2">
          <Button
            disabled={busy || !taskIds.length || run.status !== "completed"}
            onClick={() =>
              void act(() => previewMerge(projectId, run, taskIds))
            }
          >
            {busy ? "处理产物与验收中…" : "生成合并预览"}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void reload().catch((e) => setError(friendlyError(e)))
            }
          >
            刷新预览列表
          </Button>
        </div>
        <div className="mt-4 space-y-2">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={busy}
              onClick={() => void open(item)}
              className={`flex w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-left ${selected?.id === item.id ? "border-primary" : "hover:bg-muted"}`}
            >
              <span className="text-sm">
                {Object.keys(item.taskSnapshots).length} 项任务 ·{" "}
                {new Date(item.createdAt).toLocaleString("zh-CN")}
              </span>
              <Status value={item.status} />
            </button>
          ))}
        </div>
      </Panel>
      {selected && (
        <Panel
          title="冻结合并预览"
          actions={<Status value={selected.status} />}
        >
          <div className="space-y-2 text-xs">
            <div>
              合并结果：
              <code className="break-all">{selected.plan.result.id}</code>
            </div>
            <div>
              原工作区基线：
              <code className="break-all">{selected.expectedBase}</code>
            </div>
            <div>
              {selected.plan.result.entries?.length ?? 0} 个文件 ·{" "}
              {selected.plan.result.totalBytes.toLocaleString()} 字节
            </div>
          </div>
          {selected.error && (
            <p className="mt-3 text-sm text-destructive">{selected.error}</p>
          )}
          {selected.status === "conflicted" && (
            <ConflictResolver
              key={selected.id}
              preview={selected}
              busy={busy}
              onResolve={(resolutions) =>
                void act(() => resolveMerge(projectId, selected, resolutions))
              }
            />
          )}
          <div className="mt-4">
            <Input
              aria-label="筛选合并文件"
              placeholder="筛选文件路径"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="mt-2 max-h-72 space-y-1 overflow-auto">
              {(selected.plan.result.entries ?? [])
                .filter((e) => e.path.includes(filter))
                .slice(0, 200)
                .map((entry) => (
                  <div
                    key={entry.path}
                    className="flex items-center justify-between gap-2 rounded border p-2"
                  >
                    <button
                      type="button"
                      className="min-w-0 break-all text-left font-mono text-xs text-primary hover:underline"
                      onClick={() =>
                        onArtifact(selected.plan.result.id, entry.path)
                      }
                    >
                      {entry.path}
                    </button>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {entry.size} B
                    </span>
                  </div>
                ))}
            </div>
          </div>
          <details
            className="mt-4"
            open={selected.status === "verification_failed"}
          >
            <summary className="cursor-pointer text-sm font-medium">
              合并产物验收（{selected.verifications?.length ?? 0} 组）
            </summary>
            <div className="mt-3 space-y-2">
              {(selected.verifications ?? []).map((v) => (
                <div className="rounded-lg border p-3" key={v.id}>
                  <div className="flex gap-2">
                    <Status value={v.status} />
                    <span className="text-xs">
                      {tasks.find((t) => t.id === v.taskId)?.spec.title ??
                        v.taskId}
                    </span>
                  </div>
                  {v.checks.map((check) => (
                    <div className="mt-2 text-xs" key={check.id}>
                      <Status value={check.status} />{" "}
                      <span>{check.summary}</span>
                      {check.output && <Code value={check.output} />}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </details>
          {selected.status === "ready" && (
            <div className="mt-4 space-y-3">
              <Field label="合并审核意见">
                <Textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="记录对合并后的完整产物与验收结果的审查"
                />
              </Field>
              <div className="flex gap-2">
                <Button
                  disabled={busy || !comment.trim()}
                  onClick={() =>
                    void act(() =>
                      reviewMerge(projectId, selected, "approved", comment),
                    )
                  }
                >
                  批准此冻结产物
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy || !comment.trim()}
                  onClick={() =>
                    void act(() =>
                      reviewMerge(projectId, selected, "rejected", comment),
                    )
                  }
                >
                  拒绝合并
                </Button>
              </div>
            </div>
          )}
          {selected.status === "approved" && (
            <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-3">
              <p className="text-sm">
                应用会将此冻结产物写入原工作区；若原工作区基线变化，服务端会拒绝。
              </p>
              <label className="my-3 flex items-start gap-2 text-sm">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={confirmation}
                  onChange={(e) => setConfirmation(e.target.checked)}
                />
                我确认将上述已审核产物合并到原工作区。
              </label>
              <Button
                disabled={busy || !confirmation}
                onClick={() => void act(() => applyMerge(projectId, selected))}
              >
                应用已审核合并
              </Button>
            </div>
          )}
          {["unknown", "applying"].includes(selected.status) && (
            <div className="mt-4 space-y-3">
              <p className="text-sm">
                上次应用的结果尚未确认。先读取 Runner
                持久化日志，或核实原工作区确实未变更。
              </p>
              <Field label="核实依据">
                <Textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy || !comment.trim()}
                  variant="outline"
                  onClick={() =>
                    void act(() =>
                      reconcileMerge(projectId, selected, "inspect", comment),
                    )
                  }
                >
                  读取 Runner 执行结果
                </Button>
                <Button
                  disabled={busy || !comment.trim()}
                  variant="destructive"
                  onClick={() =>
                    void act(() =>
                      reconcileMerge(
                        projectId,
                        selected,
                        "not_performed",
                        comment,
                      ),
                    )
                  }
                >
                  确认未应用并放弃此预览
                </Button>
              </div>
            </div>
          )}
          {audit.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm">
                审核与应用记录
              </summary>
              <Code value={audit} />
            </details>
          )}
        </Panel>
      )}
    </div>
  );
}
function ConflictResolver({
  preview,
  busy,
  onResolve,
}: {
  preview: MergePreview;
  busy: boolean;
  onResolve: (resolutions: MergeResolution[]) => void;
}) {
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [contents, setContents] = useState<Record<string, string>>({});
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const resolved = preview.plan.conflicts.every(
    (c) =>
      choices[c.id] &&
      (choices[c.id] !== "content" ||
        !/^(<<<<<<<|=======|>>>>>>>)/m.test(contents[c.id] ?? c.preview ?? "")),
  );
  const submit = () =>
    onResolve(
      preview.plan.conflicts.map((conflict) => ({
        conflictId: conflict.id,
        choice: choices[conflict.id] as MergeResolution["choice"],
        ...(choices[conflict.id] === "content"
          ? {
              content: utf8Base64(
                contents[conflict.id] ?? conflict.preview ?? "",
              ),
            }
          : {}),
        ...(choices[conflict.id] !== "delete" && destinations[conflict.id]
          ? { destination: destinations[conflict.id] }
          : {}),
      })),
    );
  return (
    <div className="mt-4 space-y-3">
      <h3 className="font-semibold">逐项处理合并冲突</h3>
      {preview.plan.conflicts.map((conflict) => (
        <div
          key={conflict.id}
          className="rounded-lg border border-warning/40 p-3"
        >
          <div className="mb-3 break-all text-sm font-medium">
            {conflict.path} · {conflict.kind}
          </div>
          <Field label="保留方案">
            <NativeSelect
              value={choices[conflict.id] ?? ""}
              onChange={(e) =>
                setChoices({ ...choices, [conflict.id]: e.target.value })
              }
            >
              <option value="">选择解决方式</option>
              <option value="ours">保留原工作区版本</option>
              <option value="theirs">采用任务产物版本</option>
              <option value="base">恢复共同基线</option>
              <option value="delete">删除此路径</option>
              <option value="content">手动编辑文本</option>
            </NativeSelect>
          </Field>
          {choices[conflict.id] === "content" ? (
            <div className="mt-3">
              <Field
                label="最终文本"
                hint="清除冲突标记，保存后将重新运行验收。"
              >
                <Textarea
                  className="min-h-48 font-mono"
                  value={contents[conflict.id] ?? conflict.preview ?? ""}
                  onChange={(e) =>
                    setContents({ ...contents, [conflict.id]: e.target.value })
                  }
                />
              </Field>
            </div>
          ) : (
            conflict.preview && (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs">
                  查看冲突文本
                </summary>
                <Code value={conflict.preview} />
              </details>
            )
          )}
          {choices[conflict.id] !== "delete" && (
            <div className="mt-3">
              <Field label="目标路径（留空沿用原路径）">
                <Input
                  value={destinations[conflict.id] ?? ""}
                  onChange={(e) =>
                    setDestinations({
                      ...destinations,
                      [conflict.id]: e.target.value,
                    })
                  }
                />
              </Field>
            </div>
          )}
        </div>
      ))}
      <Button disabled={busy || !resolved} onClick={submit}>
        生成解决冲突后的新预览
      </Button>
    </div>
  );
}
