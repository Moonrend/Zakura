"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMeOptional } from "@/components/me-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError, type Run, type Task } from "@/lib/project-execution";
import {
  addKnowledgeComment,
  changeKnowledgeState,
  deleteKnowledge,
  getKnowledge,
  highlightedParts,
  knowledgeComments,
  knowledgeHistory,
  listKnowledge,
  saveKnowledge,
  searchKnowledge,
  type Highlight,
  type KnowledgeComment,
  type KnowledgeDraft,
  type KnowledgeEntry,
  type KnowledgeFilter,
  type KnowledgeRevision,
  type KnowledgeSearch,
  type KnowledgeSource,
} from "@/lib/project-workbench";
import { ErrorNotice, Field, NativeSelect, Panel, Status } from "./shared";

function Highlighted({ text, ranges }: { text: string; ranges: Highlight[] }) {
  return (
    <>
      {highlightedParts(text, ranges).map((part, i) =>
        part.matched ? (
          <mark
            key={i}
            className="rounded bg-amber-200/60 px-0.5 text-foreground"
          >
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

function SourcesEditor({
  value,
  onChange,
}: {
  value: KnowledgeSource[];
  onChange: (value: KnowledgeSource[]) => void;
}) {
  const update = (index: number, source: KnowledgeSource) =>
    onChange(value.map((item, i) => (i === index ? source : item)));
  return (
    <div className="space-y-3">
      {value.map((source, i) => (
        <div key={i} className="space-y-2 rounded-lg border p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label={`引用 ${i + 1} 类型`}>
              <NativeSelect
                value={source.kind}
                onChange={(e) =>
                  update(i, {
                    kind: e.target.value as KnowledgeSource["kind"],
                    label: source.label,
                    ...(e.target.value === "knowledge" ? { revision: 1 } : {}),
                  })
                }
              >
                <option value="snapshot">不可变产物快照</option>
                <option value="knowledge">知识历史版本</option>
                <option value="url">HTTPS 链接</option>
              </NativeSelect>
            </Field>
            <Field label="引用标题">
              <Input
                value={source.label ?? ""}
                onChange={(e) =>
                  update(i, { ...source, label: e.target.value })
                }
              />
            </Field>
          </div>
          {source.kind === "snapshot" ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="快照 ID">
                <Input
                  value={source.snapshotId ?? ""}
                  onChange={(e) =>
                    update(i, { ...source, snapshotId: e.target.value })
                  }
                />
              </Field>
              <Field label="快照内文件路径">
                <Input
                  value={source.path ?? ""}
                  onChange={(e) =>
                    update(i, { ...source, path: e.target.value })
                  }
                />
              </Field>
            </div>
          ) : source.kind === "knowledge" ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="知识条目 ID">
                <Input
                  value={source.entryId ?? ""}
                  onChange={(e) =>
                    update(i, { ...source, entryId: e.target.value })
                  }
                />
              </Field>
              <Field label="不可变修订号">
                <Input
                  type="number"
                  min={1}
                  value={source.revision ?? 1}
                  onChange={(e) =>
                    update(i, { ...source, revision: Number(e.target.value) })
                  }
                />
              </Field>
            </div>
          ) : (
            <Field label="HTTPS 来源地址">
              <Input
                type="url"
                value={source.url ?? ""}
                onChange={(e) => update(i, { ...source, url: e.target.value })}
              />
            </Field>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange(value.filter((_, index) => index !== i))}
          >
            删除引用
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        onClick={() => onChange([...value, { kind: "snapshot" }])}
      >
        添加可核对来源
      </Button>
    </div>
  );
}

const emptyDraft = (): KnowledgeDraft => ({
  kind: "note",
  title: "",
  body: "",
  format: "markdown",
  tags: [],
  sources: [],
});
const stateLabels: Record<string, string> = {
  active: "有效",
  proposed: "待决策",
  open: "未解决",
  resolved: "已解决",
  archived: "已归档",
  deleted: "已删除",
  approved: "已批准",
  rejected: "已拒绝",
};
const actionLabels: Record<string, string> = {
  approve: "批准决策",
  reject: "拒绝决策",
  resolve: "解决问题",
  reopen: "重新打开问题",
  archive: "归档条目",
  restore: "恢复条目",
  delete: "删除条目",
};

export function KnowledgePanel({
  projectId,
  runs,
  tasks,
  onArtifact,
  initialEntryId,
}: {
  projectId: string;
  runs: Run[];
  tasks: Task[];
  onArtifact: (snapshotId: string, path?: string) => void;
  initialEntryId?: string;
}) {
  const me = useMeOptional();
  const writable = Boolean(
    me && ["owner", "admin", "member"].includes(me.role ?? ""),
  );
  const human = Boolean(writable && me?.user?.id);
  const [filter, setFilter] = useState<KnowledgeFilter>({});
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [search, setSearch] = useState<KnowledgeSearch | null>(null);
  const [current, setCurrent] = useState<KnowledgeEntry>();
  const [historical, setHistorical] = useState(false);
  const [draft, setDraft] = useState<KnowledgeDraft | null>(null);
  const [history, setHistory] = useState<KnowledgeRevision[]>([]);
  const [comments, setComments] = useState<KnowledgeComment[]>([]);
  const [commentCursor, setCommentCursor] = useState<string>();
  const [comment, setComment] = useState("");
  const [editComment, setEditComment] = useState("");
  const [action, setAction] = useState("");
  const [actionComment, setActionComment] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedGeneration = useRef(0);
  const reload = useCallback(async () => {
    const result = await listKnowledge(projectId, filter);
    setEntries(result.items ?? []);
    setCursor(result.nextCursor);
    setSearch(null);
  }, [projectId, filter]);
  useEffect(() => {
    let alive = true;
    void listKnowledge(projectId, filter)
      .then((result) => {
        if (alive) {
          setEntries(result.items ?? []);
          setCursor(result.nextCursor);
          setSearch(null);
        }
      })
      .catch((e) => alive && setError(friendlyError(e)));
    return () => {
      alive = false;
    };
  }, [projectId, filter]);
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
  const open = async (entryId: string, revision?: number) => {
    const generation = ++selectedGeneration.current;
    const [entry, history, comments] = await Promise.all([
      getKnowledge(projectId, entryId, revision),
      knowledgeHistory(projectId, entryId),
      knowledgeComments(projectId, entryId),
    ]);
    if (generation !== selectedGeneration.current) return;
    setCurrent(entry);
    setHistorical(revision !== undefined);
    setHistory(history.items ?? []);
    setComments(comments.items ?? []);
    setCommentCursor(comments.cursor);
    setDraft(null);
    setAction("");
    setActionComment("");
    setConfirmed(false);
    setComment("");
  };
  useEffect(() => {
    if (initialEntryId)
      void open(initialEntryId).catch((e) =>
        setError(`审核目标已删除或不可访问：${friendlyError(e)}`),
      );
  }, [projectId, initialEntryId]);
  const actions =
    !current || historical
      ? []
      : current.status === "archived"
        ? ["restore", "delete"]
        : current.status === "deleted"
          ? []
          : [
              ...(current.kind === "decision" && current.status === "proposed"
                ? ["approve", "reject"]
                : []),
              ...(current.kind === "question"
                ? current.status === "open"
                  ? ["resolve"]
                  : ["reopen"]
                : []),
              "archive",
              "delete",
            ];
  const found = search
    ? search.items.map((hit) => ({ entry: hit.entry, hit }))
    : entries.map((entry) => ({ entry, hit: undefined }));
  return (
    <div className="space-y-4">
      <ErrorNotice message={error} />
      <Panel
        title="项目知识与决策"
        description="记录项目文档、提案、问题与可核对来源。每次修改都有不可变修订；内容不会自动成为 Agent 指令。"
        actions={
          <Button
            disabled={!writable || busy}
            onClick={() => {
              setCurrent(undefined);
              setHistorical(false);
              setDraft(emptyDraft());
              setHistory([]);
              setComments([]);
              setCommentCursor(undefined);
              setEditComment("");
            }}
          >
            新建条目
          </Button>
        }
      >
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="知识全文检索">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && query.trim())
                  void act(async () =>
                    setSearch(await searchKnowledge(projectId, query, filter)),
                  );
              }}
            />
          </Field>
          <Field label="类型筛选">
            <NativeSelect
              value={filter.kind ?? ""}
              onChange={(e) => setFilter({ ...filter, kind: e.target.value })}
            >
              <option value="">全部</option>
              <option value="note">文档 / 笔记</option>
              <option value="decision">决策提案</option>
              <option value="question">问题</option>
            </NativeSelect>
          </Field>
          <Field label="状态筛选">
            <NativeSelect
              value={filter.status ?? ""}
              onChange={(e) => setFilter({ ...filter, status: e.target.value })}
            >
              <option value="">全部有效条目</option>
              {Object.entries(stateLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="精确标签筛选">
            <Input
              value={filter.tag ?? ""}
              onChange={(e) => setFilter({ ...filter, tag: e.target.value })}
            />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={filter.includeArchived ?? false}
              onChange={(e) =>
                setFilter({ ...filter, includeArchived: e.target.checked })
              }
            />
            包含归档
          </label>
          <Button
            variant="outline"
            disabled={busy || !query.trim()}
            onClick={() =>
              void act(async () =>
                setSearch(await searchKnowledge(projectId, query, filter)),
              )
            }
          >
            BM25 检索
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void act(reload)}
          >
            恢复列表 / 刷新
          </Button>
        </div>
        {search && (
          <p className="mt-3 text-xs text-muted-foreground">
            {search.algorithm} · {search.items.length} 个结果 /{" "}
            {search.corpusSize} 条记录 · 搜索候选 {search.candidates}
            {search.truncated ? " · 已达到候选或结果上限，结果不完整" : ""}
          </p>
        )}
      </Panel>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(260px,0.7fr)_minmax(0,1.6fr)]">
        <Panel title="条目列表">
          <div className="space-y-2">
            {found.map(({ entry, hit }) => (
              <button
                key={entry.id}
                type="button"
                className={`w-full rounded-lg border p-3 text-left ${current?.id === entry.id ? "border-primary" : "hover:bg-muted"}`}
                onClick={() => void act(() => open(entry.id))}
              >
                <div className="flex items-start justify-between gap-2">
                  <strong className="text-sm">
                    {hit ? (
                      <Highlighted
                        text={entry.title}
                        ranges={hit.titleHighlights ?? []}
                      />
                    ) : (
                      entry.title
                    )}
                  </strong>
                  <span className="text-xs text-muted-foreground">
                    r{entry.revision}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {entry.kind} · {stateLabels[entry.status] ?? entry.status} ·{" "}
                  {entry.tags.join(" / ")}
                </p>
                {hit && (
                  <>
                    <p className="mt-2 whitespace-pre-wrap text-xs">
                      <Highlighted
                        text={hit.snippet.text}
                        ranges={hit.snippet.highlights ?? []}
                      />
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      相关度 {hit.score.toFixed(3)} ·{" "}
                      {hit.matchedTerms.join("、")}
                    </p>
                  </>
                )}
              </button>
            ))}
            {!found.length && (
              <p className="text-sm text-muted-foreground">
                没有符合条件的条目。
              </p>
            )}
            {!search && cursor && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const next = await listKnowledge(projectId, filter, cursor);
                    setEntries((previous) => [...previous, ...next.items]);
                    setCursor(next.nextCursor);
                  })
                }
              >
                加载下一页
              </Button>
            )}
          </div>
        </Panel>
        <div className="space-y-4">
          {draft ? (
            <Panel title={current ? "编辑并创建新修订" : "新建知识条目"}>
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="条目类型">
                    <NativeSelect
                      value={draft.kind}
                      disabled={Boolean(current)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          kind: e.target.value as KnowledgeDraft["kind"],
                        })
                      }
                    >
                      <option value="note">文档 / 笔记</option>
                      <option value="decision">决策提案</option>
                      <option value="question">待解决问题</option>
                    </NativeSelect>
                  </Field>
                  <Field label="条目标题">
                    <Input
                      value={draft.title}
                      onChange={(e) =>
                        setDraft({ ...draft, title: e.target.value })
                      }
                    />
                  </Field>
                </div>
                <Field label="正文（Markdown 原文）">
                  <Textarea
                    rows={12}
                    value={draft.body}
                    onChange={(e) =>
                      setDraft({ ...draft, body: e.target.value })
                    }
                  />
                </Field>
                <Field label="标签（以逗号分隔）">
                  <Input
                    value={draft.tags.join(", ")}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        tags: e.target.value
                          .split(/[,，]/)
                          .map((tag) => tag.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="关联执行轮次（可选）">
                    <NativeSelect
                      value={draft.runId ?? ""}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          runId: e.target.value || undefined,
                          taskId: undefined,
                        })
                      }
                    >
                      <option value="">不关联</option>
                      {runs.map((run) => (
                        <option key={run.id} value={run.id}>
                          {run.id.slice(0, 12)} · v{run.planVersion}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field label="关联任务（当前轮次可选）">
                    <NativeSelect
                      value={draft.taskId ?? ""}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          taskId: e.target.value || undefined,
                        })
                      }
                    >
                      <option value="">不关联</option>
                      {tasks
                        .filter((task) => task.runId === draft.runId)
                        .map((task) => (
                          <option value={task.id} key={task.id}>
                            {task.spec.title}
                          </option>
                        ))}
                    </NativeSelect>
                  </Field>
                </div>
                <SourcesEditor
                  value={draft.sources}
                  onChange={(sources) => setDraft({ ...draft, sources })}
                />
                {current && (
                  <Field label="修订说明">
                    <Input
                      value={editComment}
                      onChange={(e) => setEditComment(e.target.value)}
                    />
                  </Field>
                )}
                <div className="flex gap-2">
                  <Button
                    disabled={busy || !draft.title.trim() || !draft.body.trim()}
                    onClick={() =>
                      void act(async () => {
                        const saved = await saveKnowledge(
                          projectId,
                          draft,
                          current,
                          editComment,
                        );
                        await reload();
                        await open(saved.id);
                      })
                    }
                  >
                    保存不可变修订
                  </Button>
                  <Button variant="ghost" onClick={() => setDraft(null)}>
                    取消编辑
                  </Button>
                </div>
              </div>
            </Panel>
          ) : current ? (
            <Panel
              title={current.title}
              description={`${historical ? "历史版本（只读） · " : ""}修订 r${current.revision} · ${stateLabels[current.status] ?? current.status} · ${new Date(current.updatedAt).toLocaleString("zh-CN")}`}
              actions={
                <div className="flex gap-2">
                  {historical && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void act(() => open(current.id))}
                    >
                      打开最新版本
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    disabled={
                      !writable ||
                      historical ||
                      current.status === "deleted" ||
                      busy
                    }
                    onClick={() => {
                      setDraft({
                        kind: current.kind,
                        title: current.title,
                        body: current.body,
                        format: current.format,
                        tags: current.tags,
                        sources: current.sources,
                        runId: current.runId,
                        taskId: current.taskId,
                      });
                      setEditComment("");
                    }}
                  >
                    编辑
                  </Button>
                </div>
              }
            >
              <p className="mb-3 text-xs text-muted-foreground">
                {current.tags.join(" / ")} · {current.id}
              </p>
              <pre className="max-h-[600px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-4 font-sans text-sm leading-relaxed">
                {current.body}
              </pre>
              {current.sources.length > 0 && (
                <div className="mt-4 space-y-2">
                  <h3 className="text-sm font-medium">引用来源</h3>
                  {current.sources.map((source, i) => (
                    <div key={i} className="rounded border p-2 text-sm">
                      {source.kind === "url" &&
                      source.url?.startsWith("https://") ? (
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="break-all text-primary underline"
                        >
                          {source.label || source.url}
                        </a>
                      ) : source.kind === "snapshot" ? (
                        <button
                          className="break-all text-left text-primary underline"
                          onClick={() =>
                            source.snapshotId &&
                            onArtifact(source.snapshotId, source.path)
                          }
                        >
                          {source.label ||
                            `${source.snapshotId} / ${source.path}`}
                        </button>
                      ) : (
                        <button
                          className="break-all text-left text-primary underline"
                          onClick={() =>
                            void act(() =>
                              open(source.entryId ?? "", source.revision),
                            )
                          }
                        >
                          {source.label ||
                            `${source.entryId} · r${source.revision}`}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          ) : (
            <Panel title="选择知识条目">
              <p className="text-sm text-muted-foreground">
                查看版本、引用、讨论和决策状态，或新建项目记录。
              </p>
            </Panel>
          )}
          {current && !draft && (
            <>
              <Panel title="讨论">
                <div className="space-y-3">
                  {comments.map((item) => (
                    <div className="rounded border p-3" key={item.id}>
                      <p className="whitespace-pre-wrap text-sm">{item.body}</p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {item.authorId} · 对 r{item.revision} ·{" "}
                        {new Date(item.createdAt).toLocaleString("zh-CN")}
                      </p>
                    </div>
                  ))}
                  {!comments.length && (
                    <p className="text-sm text-muted-foreground">尚无讨论。</p>
                  )}
                  {commentCursor && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const next = await knowledgeComments(
                            projectId,
                            current.id,
                            commentCursor,
                          );
                          setComments((previous) => [
                            ...previous,
                            ...next.items,
                          ]);
                          setCommentCursor(next.cursor);
                        })
                      }
                    >
                      加载更多讨论
                    </Button>
                  )}
                  {!historical && current.status !== "deleted" && writable && (
                    <>
                      <Field label="新增讨论">
                        <Textarea
                          value={comment}
                          onChange={(e) => setComment(e.target.value)}
                        />
                      </Field>
                      <Button
                        disabled={busy || !comment.trim()}
                        onClick={() =>
                          void act(async () => {
                            await addKnowledgeComment(
                              projectId,
                              current,
                              comment,
                            );
                            await open(current.id);
                          })
                        }
                      >
                        发表评论
                      </Button>
                    </>
                  )}
                </div>
              </Panel>
              <Panel title="修订历史">
                <div className="space-y-2">
                  {history.map((revision) => (
                    <button
                      type="button"
                      key={revision.entry.revision}
                      className="block w-full rounded border p-2 text-left text-sm hover:bg-muted"
                      onClick={() =>
                        void act(() =>
                          open(current.id, revision.entry.revision),
                        )
                      }
                    >
                      r{revision.entry.revision} · {revision.action} ·{" "}
                      {revision.authorId}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {revision.comment || "无修订说明"}
                      </p>
                    </button>
                  ))}
                  {history.length > 0 && history.at(-1)!.entry.revision > 1 && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const result = await knowledgeHistory(
                            projectId,
                            current.id,
                            history.at(-1)!.entry.revision,
                          );
                          setHistory((previous) => [
                            ...previous,
                            ...result.items,
                          ]);
                        })
                      }
                    >
                      加载更早修订
                    </Button>
                  )}
                </div>
              </Panel>
              {actions.length > 0 && (
                <Panel
                  title="状态与人工决策"
                  description="批准、拒绝和问题处理要求真实成员会话；操作说明永久记录在修订历史。"
                >
                  <div className="space-y-3">
                    <Field label="状态操作">
                      <NativeSelect
                        value={action}
                        onChange={(e) => {
                          setAction(e.target.value);
                          setConfirmed(false);
                        }}
                      >
                        <option value="">选择操作</option>
                        {actions.map((item) => (
                          <option value={item} key={item}>
                            {actionLabels[item]}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                    <Field label="操作理由与结论">
                      <Textarea
                        value={actionComment}
                        onChange={(e) => setActionComment(e.target.value)}
                      />
                    </Field>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(e) => setConfirmed(e.target.checked)}
                      />
                      确认对当前 r{current.revision} 执行所选操作
                    </label>
                    <Button
                      variant={
                        action === "delete" || action === "reject"
                          ? "destructive"
                          : "default"
                      }
                      disabled={
                        busy ||
                        !writable ||
                        (["approve", "reject", "resolve", "reopen"].includes(
                          action,
                        ) &&
                          !human) ||
                        !action ||
                        !confirmed ||
                        !actionComment.trim()
                      }
                      onClick={() =>
                        void act(async () => {
                          const saved =
                            action === "delete"
                              ? await deleteKnowledge(
                                  projectId,
                                  current,
                                  actionComment,
                                )
                              : await changeKnowledgeState(
                                  projectId,
                                  current,
                                  action,
                                  actionComment,
                                );
                          await reload();
                          await open(saved.id);
                        })
                      }
                    >
                      {actionLabels[action] ?? "执行状态变更"}
                    </Button>
                  </div>
                </Panel>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
