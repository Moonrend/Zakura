"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getBranches,
  getBranchFiles,
  getArtifactFile,
  compareTasks,
  friendlyError,
  type Branch,
  type Task,
  type FileEntry,
  type FilePreview,
  type ArtifactChange,
} from "@/lib/project-execution";
import { Code, ErrorNotice, Field, NativeSelect, Panel } from "./shared";
export function ArtifactExplorer({
  projectId,
  runId,
  tasks,
  snapshotId = "",
  initialPath = "",
}: {
  projectId: string;
  runId?: string;
  tasks: Task[];
  snapshotId?: string;
  initialPath?: string;
}) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [source, setSource] = useState<"snapshot" | "branch">(
    snapshotId ? "snapshot" : "branch",
  );
  const [snapshot, setSnapshot] = useState(snapshotId);
  const [path, setPath] = useState(initialPath);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [file, setFile] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [comparison, setComparison] = useState<Awaited<
    ReturnType<typeof compareTasks>
  > | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void getBranches(projectId)
      .then((data) => {
        if (alive) {
          setBranches(data.branches ?? []);
          setBranchId(data.branches?.[0]?.id ?? "");
        }
      })
      .catch((e) => {
        if (alive) setError(friendlyError(e));
      });
    return () => {
      alive = false;
    };
  }, [projectId]);
  useEffect(() => {
    if (snapshotId) {
      setSource("snapshot");
      setSnapshot(snapshotId);
      setPath(initialPath);
      setFile(null);
    }
  }, [snapshotId, initialPath]);
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
  const read = async () => {
    if (
      (source === "snapshot" && !snapshot) ||
      (source === "branch" && !branchId)
    )
      throw new Error("先选择快照或分支");
    const next = await getArtifactFile(
      projectId,
      source === "snapshot" ? { snapshotId: snapshot } : { branchId },
      path,
    );
    setFile(next);
  };
  const list = async () => {
    const next = await getBranchFiles(projectId, branchId, path);
    setFiles(next.entries ?? []);
    setFile(null);
  };
  const compareFile = async (change: ArtifactChange) => {
    if (!comparison) return;
    setBefore(null);
    setAfter(null);
    const a = change.before
      ? await getArtifactFile(
          projectId,
          { snapshotId: comparison.left.snapshotId },
          change.oldPath || change.path,
        )
      : null;
    const b = change.after
      ? await getArtifactFile(
          projectId,
          { snapshotId: comparison.right.snapshotId },
          change.path,
        )
      : null;
    setBefore(a?.content ?? "[此版本不存在此文件]");
    setAfter(b?.content ?? "[此版本不存在此文件]");
  };
  return (
    <div className="space-y-4">
      <Panel
        title="产物浏览器"
        description="快照内容固定；分支用于浏览当前任务文件。单文件预览最多 256 KiB。"
      >
        <ErrorNotice message={error} />
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <Field label="来源">
            <NativeSelect
              value={source}
              onChange={(e) => {
                setSource(e.target.value as typeof source);
                setFile(null);
              }}
            >
              <option value="snapshot">冻结快照</option>
              <option value="branch">任务分支</option>
            </NativeSelect>
          </Field>
          {source === "snapshot" ? (
            <Field label="快照标识">
              <Input
                value={snapshot}
                onChange={(e) => {
                  setSnapshot(e.target.value);
                  setFile(null);
                }}
              />
            </Field>
          ) : (
            <Field label="任务分支">
              <NativeSelect
                value={branchId}
                onChange={(e) => {
                  setBranchId(e.target.value);
                  setFile(null);
                  setFiles([]);
                }}
              >
                <option value="">选择分支</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {tasks.find((t) => t.branchId === b.id)?.spec.title ?? b.id}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field label="相对文件路径">
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="src/main.go"
              onKeyDown={(e) => {
                if (e.key === "Enter") void act(read);
              }}
            />
          </Field>
        </div>
        <div className="mt-3 flex gap-2">
          <Button disabled={busy || !path} onClick={() => void act(read)}>
            读取文件
          </Button>
          {source === "branch" && (
            <Button
              variant="outline"
              disabled={busy || !branchId}
              onClick={() => void act(list)}
            >
              列出目录
            </Button>
          )}
        </div>
        {files.length > 0 && (
          <div className="mt-3 grid max-h-60 gap-1 overflow-auto">
            {files.map((entry) => (
              <button
                type="button"
                key={entry.path}
                className="flex items-center justify-between gap-3 rounded border px-3 py-2 text-left text-xs hover:bg-muted"
                onClick={() => {
                  setPath(entry.path);
                  setFile(null);
                }}
              >
                <span className="break-all">
                  {entry.isDir ? "📁 " : ""}
                  {entry.path}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {entry.isDir ? "目录" : `${entry.size} B`}
                </span>
              </button>
            ))}
          </div>
        )}
        {file && (
          <div className="mt-4">
            <div className="mb-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
              <span>{file.path}</span>
              <span>{file.size} B</span>
              <code className="break-all">SHA-256: {file.revision}</code>
            </div>
            {file.content.includes("\0") ? (
              <p className="text-sm text-muted-foreground">
                二进制文件；内容哈希与字节数如上。
              </p>
            ) : (
              <Code value={file.content} limit={262144} />
            )}
          </div>
        )}
      </Panel>
      {runId && (
        <Panel
          title="比较两份任务产物"
          description="比较冻结快照的路径、内容哈希与实际文件，方便检查不同方案或前后阶段的变化。"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="左侧任务">
              <NativeSelect
                value={left}
                onChange={(e) => setLeft(e.target.value)}
              >
                <option value="">选择任务</option>
                {tasks
                  .filter((t) => t.snapshotId)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.spec.title}
                    </option>
                  ))}
              </NativeSelect>
            </Field>
            <Field label="右侧任务">
              <NativeSelect
                value={right}
                onChange={(e) => setRight(e.target.value)}
              >
                <option value="">选择任务</option>
                {tasks
                  .filter((t) => t.snapshotId)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.spec.title}
                    </option>
                  ))}
              </NativeSelect>
            </Field>
          </div>
          <Button
            className="mt-3"
            disabled={busy || !left || !right || left === right}
            onClick={() =>
              void act(async () => {
                setComparison(
                  await compareTasks(projectId, runId, left, right),
                );
                setBefore(null);
                setAfter(null);
              })
            }
          >
            比较冻结产物
          </Button>
          {comparison && (
            <div className="mt-4 space-y-2">
              <p className="text-sm">
                {comparison.diff.length} 项变化 · 左侧{" "}
                {
                  comparison.leftVerifications.filter(
                    (v) => v.status === "passed",
                  ).length
                }{" "}
                组验收通过 · 右侧{" "}
                {
                  comparison.rightVerifications.filter(
                    (v) => v.status === "passed",
                  ).length
                }{" "}
                组验收通过
              </p>
              {comparison.diff.slice(0, 200).map((change) => (
                <button
                  type="button"
                  key={`${change.kind}/${change.path}`}
                  disabled={busy}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border p-2 text-left text-xs hover:bg-muted"
                  onClick={() => void act(() => compareFile(change))}
                >
                  <span className="break-all">
                    {change.oldPath ? `${change.oldPath} → ` : ""}
                    {change.path}
                  </span>
                  <span>{change.kind}</span>
                </button>
              ))}
              {before !== null && after !== null && (
                <div className="grid gap-3 lg:grid-cols-2">
                  <div>
                    <h3 className="mb-2 text-sm font-medium">
                      {comparison.left.spec.title}
                    </h3>
                    <Code value={before} limit={262144} />
                  </div>
                  <div>
                    <h3 className="mb-2 text-sm font-medium">
                      {comparison.right.spec.title}
                    </h3>
                    <Code value={after} limit={262144} />
                  </div>
                </div>
              )}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
