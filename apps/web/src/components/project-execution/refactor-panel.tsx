"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  friendlyError,
  getRun,
  getRuns,
  type Project,
  type Run,
} from "@/lib/project-execution";
import { semanticSearch, type SemanticSymbol } from "@/lib/project-workbench";
import {
  createRenameBranch,
  inspectRenameCandidate,
  previewRename,
  runRenameCandidate,
  type RenameCandidate,
  type RenamePreview,
} from "@/lib/project-refactor";
import { Code, ErrorNotice, Field, NativeSelect, Panel } from "./shared";
type SnapshotChoice = { id: string; label: string };
const isSnapshot = (id: string) => /^[a-f0-9]{64}$/.test(id);
export function RefactorPanel({ project }: { project: Project }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState("");
  const [snapshots, setSnapshots] = useState<SnapshotChoice[]>([]);
  const [snapshot, setSnapshot] = useState("");
  const [query, setQuery] = useState("");
  const [symbols, setSymbols] = useState<SemanticSymbol[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<SemanticSymbol | null>(null);
  const [newName, setNewName] = useState("");
  const [preview, setPreview] = useState<RenamePreview | null>(null);
  const [candidate, setCandidate] = useState<RenameCandidate | null>(null);
  const [accept, setAccept] = useState(false);
  const [startedRun, setStartedRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookupId, setLookupId] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    generation.current++;
    setLoading(true);
    setRunId("");
    setSnapshot("");
    setSnapshots([]);
    setSymbols([]);
    setSelected(null);
    setPreview(null);
    setCandidate(null);
    setStartedRun(null);
    setError(null);
    getRuns(project.id)
      .then(({ items }) => {
        if (active) {
          setRuns(items ?? []);
          setRunId(items?.[0]?.id ?? "");
        }
      })
      .catch((error) => {
        if (active) setError(friendlyError(error));
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
    if (!runId) {
      setSnapshots([]);
      return;
    }
    setLoading(true);
    getRun(project.id, runId)
      .then(({ run, tasks }) => {
        if (!active) return;
        const choices: SnapshotChoice[] = [];
        if (run.baseSnapshot)
          choices.push({ id: run.baseSnapshot, label: "本次运行基线" });
        for (const task of tasks)
          if (task.snapshotId && !choices.some((x) => x.id === task.snapshotId))
            choices.push({
              id: task.snapshotId,
              label: `${task.spec.title} · ${task.status}`,
            });
        setSnapshots(choices);
        setSnapshot(choices.at(-1)?.id ?? "");
        setSelected(null);
        setSymbols([]);
        setPreview(null);
        setCandidate(null);
        setAccept(false);
      })
      .catch((error) => {
        if (active) setError(friendlyError(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [project.id, runId]);
  const invalidatePreview = () => {
    setPreview(null);
    setCandidate(null);
    setStartedRun(null);
    setAccept(false);
    setError(null);
  };
  const act = async (action: () => Promise<void>) => {
    if (busy) return;
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
  const search = () =>
    act(async () => {
      const epoch = generation.current;
      const result = await semanticSearch(project.id, snapshot, { q: query });
      if (epoch !== generation.current) return;
      setSymbols(result.symbols.filter((s) => s.path.endsWith(".go")));
      setTotal(result.total);
    });
  const validate = () =>
    act(async () => {
      if (!selected) return;
      const epoch = generation.current;
      const result = await previewRename(project.id, {
        snapshotId: snapshot,
        path: selected.path,
        symbolId: selected.id,
        newName,
      });
      if (epoch !== generation.current) return;
      setPreview(result);
      setAccept(false);
      setCandidate(null);
    });
  return (
    <div className="space-y-4">
      <Panel
        title="Go 符号重命名"
        description="在不可变产物上检查符号绑定与全部本地 Go 包，预览精确修改；确认后创建隔离分支。"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            第三方依赖缺失、条件构建或平台文件无法确定时会停止预览。标准库需要节点安装完整
            Go 源码。字符串、注释与当前运行中的任务分支不会被重写。
          </p>
          <ErrorNotice message={error} />
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="产物所在运行">
              <NativeSelect
                value={runId}
                disabled={busy || loading}
                onChange={(e) => {
                  setRunId(e.target.value);
                  invalidatePreview();
                }}
              >
                <option value="">选择运行</option>
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.id.slice(0, 12)} · {run.status}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="不可变快照">
              <NativeSelect
                value={snapshot}
                disabled={busy || loading}
                onChange={(e) => {
                  setSnapshot(e.target.value);
                  setSymbols([]);
                  setSelected(null);
                  invalidatePreview();
                }}
              >
                <option value="">选择快照</option>
                {snapshots.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label} · {choice.id.slice(0, 12)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="符号名称">
              <Input
                value={query}
                maxLength={256}
                disabled={busy}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && isSnapshot(snapshot)) void search();
                }}
                placeholder="查找函数、方法、类型或局部变量"
              />
            </Field>
            <div className="flex items-end">
              <Button
                disabled={busy || !isSnapshot(snapshot)}
                onClick={() => void search()}
              >
                查找 Go 定义
              </Button>
            </div>
          </div>
          {symbols.length > 0 && (
            <div className="max-h-72 space-y-2 overflow-auto">
              {symbols.map((symbol) => (
                <button
                  key={symbol.id}
                  type="button"
                  disabled={busy}
                  aria-pressed={selected?.id === symbol.id}
                  className={`w-full rounded-lg border p-3 text-left text-sm ${selected?.id === symbol.id ? "border-primary bg-primary/5" : "hover:bg-muted/40"}`}
                  onClick={() => {
                    setSelected(symbol);
                    setNewName(symbol.name);
                    invalidatePreview();
                  }}
                >
                  <strong>{symbol.name}</strong> · {symbol.kind}
                  <div className="mt-1 text-xs text-muted-foreground">
                    {symbol.path}:{symbol.selection.start.line} · 字节偏移{" "}
                    {symbol.selection.start.offset}
                  </div>
                  <code className="mt-1 block break-all text-xs">
                    {symbol.signature}
                  </code>
                </button>
              ))}
            </div>
          )}
          {total > symbols.length && (
            <p className="text-xs text-muted-foreground">
              返回 {symbols.length} 个 Go 定义；搜索共 {total}{" "}
              项。缩小名称范围可查看其余结果。
            </p>
          )}
          {selected && (
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <Field
                label="新名称"
                hint="支持 Go Unicode 标识符，服务端会检查重名与引用捕获。"
              >
                <Input
                  value={newName}
                  disabled={busy}
                  maxLength={128}
                  onChange={(e) => {
                    setNewName(e.target.value);
                    invalidatePreview();
                  }}
                />
              </Field>
              <div className="flex items-end pb-5">
                <Button
                  disabled={
                    busy || !newName.trim() || newName === selected.name
                  }
                  onClick={() => void validate()}
                >
                  {busy ? "检查中…" : "检查并预览修改"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Panel>
      {preview && (
        <Panel
          title={`${preview.selection.name} → ${preview.newName}`}
          description={`${preview.files.length} 个文件，${preview.references} 处引用，${preview.checkedPackages.length} 个本地包通过重写前后的类型检查。`}
        >
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Badge variant="success">类型绑定已验证</Badge>
              {preview.exportedApiChanged && (
                <Badge variant="warn">导出 API 变化：外部消费者可能中断</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              类型检查覆盖当前快照中的本地调用。反射、序列化名称与快照外的消费者仍需人工检查；候选不会继承验收或合并审批。
            </p>
            {preview.files.map((file) => (
              <details key={file.path} className="rounded-lg border p-3" open>
                <summary className="cursor-pointer text-sm font-medium">
                  {file.path} · {file.edits.length} 处修改
                </summary>
                <div className="mt-2">
                  <Code
                    value={file.edits.map(
                      (edit) =>
                        `字节 ${edit.start}..${edit.end}: ${edit.oldText} → ${edit.newText}`,
                    )}
                  />
                </div>
              </details>
            ))}
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={accept}
                disabled={busy || Boolean(candidate)}
                onChange={(e) => setAccept(e.target.checked)}
                className="mt-1"
              />
              我已检查修改及 API 影响，确认创建隔离分支。
            </label>
            <Button
              disabled={busy || !accept || Boolean(candidate)}
              onClick={() =>
                void act(async () => {
                  const epoch = generation.current;
                  const result = await createRenameBranch(project.id, preview);
                  if (epoch !== generation.current) return;
                  setCandidate(result);
                  setLookupId(result.id);
                })
              }
            >
              创建重构候选分支
            </Button>
            <p className="text-xs text-muted-foreground">
              生成候选只保存隔离产物。原工作区发布仍需执行验收和正式合并审批。
            </p>
          </div>
        </Panel>
      )}
      <Panel
        title="恢复或验收候选"
        description="候选凭已完成的节点操作凭证恢复。用项目当前计划、预算和验收规则启动新运行。"
      >
        <div className="space-y-3">
          <Field label="候选凭证 ID">
            <Input
              value={lookupId}
              disabled={busy}
              onChange={(e) => setLookupId(e.target.value)}
              placeholder="创建分支后返回的候选 ID"
            />
          </Field>
          <Button
            variant="outline"
            disabled={busy || !lookupId.trim()}
            onClick={() =>
              void act(async () => {
                const epoch = generation.current;
                const result = await inspectRenameCandidate(
                  project.id,
                  lookupId.trim(),
                );
                if (epoch !== generation.current) return;
                setCandidate(result);
                setStartedRun(null);
              })
            }
          >
            检查候选凭证
          </Button>
          {candidate && (
            <div className="space-y-3 rounded-lg border p-3">
              <dl className="grid gap-2 text-sm">
                <div>
                  <dt className="text-muted-foreground">候选 ID</dt>
                  <dd className="break-all font-mono text-xs">
                    {candidate.id}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">隔离分支</dt>
                  <dd className="break-all font-mono text-xs">
                    {candidate.branchId}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">候选快照</dt>
                  <dd className="break-all font-mono text-xs">
                    {candidate.snapshotId}
                  </dd>
                </div>
              </dl>
              <Button
                disabled={busy || Boolean(startedRun)}
                onClick={() =>
                  void act(async () => {
                    const epoch = generation.current;
                    const result = await runRenameCandidate(
                      project.id,
                      candidate.id,
                      project.revision,
                    );
                    if (epoch !== generation.current) return;
                    setStartedRun(result);
                  })
                }
              >
                从候选启动验收运行
              </Button>
              {startedRun && (
                <p className="text-sm">
                  已创建运行 {startedRun.id}。
                  <Link
                    className="ml-2 text-primary underline"
                    href={`/dashboard/project-executions/${project.id}`}
                  >
                    查看项目运行
                  </Link>
                </p>
              )}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
