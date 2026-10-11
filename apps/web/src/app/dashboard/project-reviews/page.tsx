"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ClipboardCheck, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ErrorNotice, Field, NativeSelect, Panel } from "@/components/project-execution/shared";
import { friendlyError, getProjects, type Project } from "@/lib/project-execution";
import { fetchSpaces, type SpaceItem } from "@/lib/spaces";
import {
  getReviewInbox,
  getReviewSummary,
  recheckReview,
  reviewDate,
  reviewErrorLabels,
  reviewKindLabels,
  reviewItemKey,
  reviewStatusLabels,
  reviewWaitingLabel,
  type ReviewFilters,
  type ReviewItem,
  type ReviewKind,
  type ReviewList,
  type ReviewSummary,
} from "@/lib/project-review-inbox";

function ReviewCard({
  item,
  opening,
  blocked,
  note,
  onOpen,
}: {
  item: ReviewItem;
  opening: boolean;
  blocked: boolean;
  note?: string;
  onOpen: () => void;
}) {
  const error = item.errorCategory?.startsWith("http_")
    ? `下游返回 HTTP ${item.errorCategory.slice(5)}`
    : reviewErrorLabels[item.errorCategory ?? ""];
  return (
    <article className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge variant={item.risk >= 85 ? "warn" : "secondary"}>
              {reviewKindLabels[item.kind]}
            </Badge>
            <Badge variant={item.status === "unknown" ? "warn" : "secondary"}>
              {reviewStatusLabels[item.status] ?? item.status}
            </Badge>
            <span className="text-xs text-muted-foreground">
              已等待 {reviewWaitingLabel(item.waitingSeconds)}
            </span>
          </div>
          <h2 className="break-words font-semibold">{item.title || item.action}</h2>
          <Link
            className="mt-1 inline-block text-sm text-primary hover:underline"
            href={`/dashboard/project-executions/${encodeURIComponent(item.projectId)}`}
          >
            {item.projectName || "项目"}
          </Link>
          <p className="mt-2 text-sm text-muted-foreground">{item.summary}</p>
        </div>
        <Button variant="outline" disabled={blocked} onClick={onOpen}>
          {opening ? "检查当前状态…" : item.canAct ? item.action : "查看审核详情"}
        </Button>
      </div>
      <dl className="mt-3 grid gap-x-5 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
        <div>
          <dt className="inline">需要人工身份：</dt>
          <dd className="inline">
            {item.requiredRole === "owner_admin" ? "所有者或管理员" : "项目成员、管理员或所有者"}
          </dd>
        </div>
        <div>
          <dt className="inline">创建时间：</dt>
          <dd className="inline">{reviewDate(item.createdAt)}</dd>
        </div>
        <div>
          <dt className="inline">最近更新：</dt>
          <dd className="inline">{reviewDate(item.updatedAt)}</dd>
        </div>
        {item.revision > 0 && (
          <div>
            <dt className="inline">当前版本：</dt>
            <dd className="inline">{item.revision}</dd>
          </div>
        )}
      </dl>
      {item.toolName && (
        <div className="mt-3 rounded-lg bg-muted/50 p-3 text-xs">
          <p className="break-words">
            工具：<code>{item.toolName}</code> · 影响：
            {item.effect === "external_write"
              ? "可能修改外部系统"
              : item.effect === "workspace_write"
                ? "修改隔离工作分支"
                : item.effect === "read"
                  ? "读取数据"
                  : "需在详情确认"}
          </p>
          {!!item.argumentFields?.length && (
            <p className="mt-1 break-words">参数字段：{item.argumentFields.join("、")}</p>
          )}
          <p className="mt-1 text-muted-foreground">参数值需在对应审核页面核实。</p>
        </div>
      )}
      {item.hasError && (
        <p className="mt-3 flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error ?? "此记录包含执行错误；请在受权限控制的详情中检查。"}
        </p>
      )}
      {!item.canAct && (
        <p className="mt-3 text-xs text-muted-foreground">
          当前身份可以查看；实际审核需要符合上方要求的人工登录身份。
        </p>
      )}
      {note && (
        <div role="status" className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          {note}
          <Link className="ml-2 text-primary hover:underline" href={`/dashboard/project-executions/${encodeURIComponent(item.projectId)}`}>
            查看项目当前状态
          </Link>
        </div>
      )}
      <details className="mt-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer">查看关联标识</summary>
        <p className="mt-1 break-all">审核项：{item.id}</p>
        {item.runId && <p className="mt-1 break-all">执行：{item.runId}</p>}
        {item.taskId && <p className="mt-1 break-all">任务：{item.taskId}</p>}
        {item.snapshotId && <p className="mt-1 break-all">产物：{item.snapshotId}</p>}
      </details>
    </article>
  );
}

export default function ProjectReviews() {
  const router = useRouter();
  const [spaces, setSpaces] = useState<SpaceItem[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [filters, setFilters] = useState<ReviewFilters>({});
  const [search, setSearch] = useState("");
  const [data, setData] = useState<ReviewList | null>(null);
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const requestSequence = useRef(0);
  const reload = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setBusy(true);
    setLoadingMore(false);
    setError(null);
    try {
      const [list, counts] = await Promise.all([getReviewInbox(filters), getReviewSummary(filters)]);
      if (requestSequence.current !== sequence) return;
      setData(list);
      setSummary(counts);
      setNotes({});
    } catch (error) {
      if (requestSequence.current === sequence) setError(friendlyError(error));
    } finally {
      if (requestSequence.current === sequence) setBusy(false);
    }
  }, [filters]);
  useEffect(() => {
    void reload();
    return () => { requestSequence.current++; };
  }, [reload]);
  useEffect(() => {
    let active = true;
    void fetchSpaces()
      .then((value) => active && setSpaces(value))
      .catch((error) => active && setError(friendlyError(error)));
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    setProjects([]);
    if (!filters.spaceId) return;
    void getProjects(filters.spaceId)
      .then((value) => active && setProjects(value.items ?? []))
      .catch((error) => active && setError(friendlyError(error)));
    return () => { active = false; };
  }, [filters.spaceId]);
  const more = async () => {
    if (!data?.nextCursor || busy || loadingMore) return;
    const sequence = requestSequence.current;
    setLoadingMore(true);
    setError(null);
    try {
      const next = await getReviewInbox(filters, data.nextCursor);
      if (sequence !== requestSequence.current) return;
      setData((current) => {
        if (!current || current.snapshotAt !== next.snapshotAt) return current;
        const seen = new Set(current.items.map((item) => reviewItemKey(item)));
        return { ...next, items: [...current.items, ...next.items.filter((item) => !seen.has(reviewItemKey(item)))] };
      });
    } catch (error) {
      if (sequence === requestSequence.current) setError(friendlyError(error));
    } finally {
      if (sequence === requestSequence.current) setLoadingMore(false);
    }
  };
  const open = async (item: ReviewItem) => {
    if (opening) return;
    const key = reviewItemKey(item);
    setOpening(key);
    setError(null);
    try {
      const current = await recheckReview(item);
      if (!current) {
        setNotes((old) => ({ ...old, [key]: "该项已处理、修改或当前不可见。刷新列表可重新检查。" }));
        return;
      }
      router.push(current.href);
    } catch (error) {
      setNotes((old) => ({ ...old, [key]: `当前记录无法打开：${friendlyError(error)}` }));
    } finally {
      setOpening(null);
    }
  };
  const visibleKinds = data?.visibleKinds ?? summary?.visibleKinds ?? [];
  const operator = visibleKinds.includes("source");
  const totalByKind = new Map<ReviewKind, number>();
  for (const group of summary?.groups ?? []) totalByKind.set(group.kind, (totalByKind.get(group.kind) ?? 0) + group.count);
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <ClipboardCheck className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-semibold">项目人工审核</h1>
          </div>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            汇总待验收产物、外部调用、合并发布与项目决策。先处理可能影响外部系统和原工作区的记录，同类记录按等待时间排列。
          </p>
        </div>
        <Button variant="outline" disabled={busy} onClick={() => void reload()}>
          <RefreshCw className={`mr-2 h-4 w-4 ${busy ? "animate-spin" : ""}`} />
          {busy ? "刷新中…" : "刷新状态"}
        </Button>
      </div>
      <ErrorNotice message={error} />
      <Panel title="筛选审核范围">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="空间">
            <NativeSelect value={filters.spaceId ?? ""} onChange={(e) => setFilters((value) => ({ ...value, spaceId: e.target.value, projectId: "" }))}>
              <option value="">所有可访问空间</option>
              {spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
            </NativeSelect>
          </Field>
          <Field label="项目">
            <NativeSelect disabled={!filters.spaceId} value={filters.projectId ?? ""} onChange={(e) => setFilters((value) => ({ ...value, projectId: e.target.value }))}>
              <option value="">{filters.spaceId ? "空间内所有项目" : "先选择空间"}</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </NativeSelect>
          </Field>
          <Field label="审核类型">
            <NativeSelect value={filters.kind ?? ""} onChange={(e) => setFilters((value) => ({ ...value, kind: e.target.value as ReviewKind | "" }))}>
              <option value="">所有可见类型</option>
              {visibleKinds.map((kind) => <option key={kind} value={kind}>{reviewKindLabels[kind]}</option>)}
            </NativeSelect>
          </Field>
          <Field label="等待时间">
            <NativeSelect value={filters.minAgeSeconds ?? 0} onChange={(e) => setFilters((value) => ({ ...value, minAgeSeconds: Number(e.target.value) }))}>
              <option value={0}>全部等待时长</option>
              <option value={3600}>至少 1 小时</option>
              <option value={86400}>至少 1 天</option>
              <option value={604800}>至少 7 天</option>
            </NativeSelect>
          </Field>
          <Field label="状态">
            <NativeSelect value={filters.status ?? ""} onChange={(e) => setFilters((value) => ({ ...value, status: e.target.value }))}>
              <option value="">全部未处理状态</option>
              {Object.entries(reviewStatusLabels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}
            </NativeSelect>
          </Field>
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
            <div className="flex-1">
              <Field label="项目名称、审核类型或记录标识">
                <Input maxLength={256} value={search} placeholder="按项目或记录检索" onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") setFilters((value) => ({ ...value, q: search.trim() })); }} />
              </Field>
            </div>
            <Button variant="outline" disabled={busy} onClick={() => setFilters((value) => ({ ...value, q: search.trim() }))}>应用搜索</Button>
            <Button variant="ghost" disabled={busy} onClick={() => { setSearch(""); setFilters({}); }}>清空</Button>
          </div>
        </div>
      </Panel>
      <Panel title="当前待处理数量" description="计数覆盖筛选范围内的全部可见记录。">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg bg-primary/5 p-3">
            <p className="text-xs text-muted-foreground">合计</p>
            <p className="mt-1 text-2xl font-semibold">{summary?.total ?? "—"}</p>
          </div>
          {visibleKinds.map((kind) => (
            <button key={kind} type="button" className="rounded-lg border p-3 text-left hover:bg-muted/50" onClick={() => setFilters((value) => ({ ...value, kind }))}>
              <span className="text-xs text-muted-foreground">{reviewKindLabels[kind]}</span>
              <span className="mt-1 block text-2xl font-semibold">{totalByKind.get(kind) ?? 0}</span>
            </button>
          ))}
        </div>
        {summary && <p className="mt-3 text-xs text-muted-foreground">统计时间：{reviewDate(summary.snapshotAt)}</p>}
        {!operator && <p className="mt-3 text-xs text-muted-foreground">原工作区进程确认记录仅向人工登录的所有者与管理员显示。</p>}
      </Panel>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p>{busy ? "正在读取审核记录…" : `已加载 ${data?.items.length ?? 0} 项，本次列表共有 ${data?.total ?? 0} 项`}</p>
        {data && <p>列表抓取时间：{reviewDate(data.snapshotAt)}</p>}
      </div>
      <div className="space-y-3" aria-busy={busy}>
        {data?.items.map((item) => {
          const key = reviewItemKey(item);
          return <ReviewCard key={key} item={item} opening={opening === key} blocked={Boolean(opening)} note={notes[key]} onOpen={() => void open(item)} />;
        })}
        {!busy && data?.items.length === 0 && (
          <div className="rounded-xl border border-dashed p-8 text-center">
            <ShieldCheck className="mx-auto mb-3 h-7 w-7 text-muted-foreground" />
            <p className="font-medium">当前筛选范围没有待处理记录</p>
            <p className="mt-2 text-sm text-muted-foreground">可以放宽筛选条件，或在项目产生新产物后刷新。</p>
          </div>
        )}
      </div>
      {data?.nextCursor && <Button className="w-full" variant="outline" disabled={loadingMore || busy} onClick={() => void more()}>{loadingMore ? "加载中…" : "加载下一页"}</Button>}
      <p className="text-xs text-muted-foreground">
        打开审核前会重新核对当前状态。列表翻页保留首次抓取范围；已修改、已处理或新出现的记录请刷新后查看。审批与发布均在各项目的单项审核页面完成。
      </p>
    </div>
  );
}
