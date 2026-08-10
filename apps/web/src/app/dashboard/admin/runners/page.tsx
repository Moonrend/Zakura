"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { AdminRunnerRow } from "@/lib/admin";
import { formatAbsolute, formatRelative } from "@/lib/format";
import { usePagedList } from "@/hooks/use-paged-list";
import { SettingsHeader } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
import {
  DataTablePagination,
  ListToolbar,
  SortableTableHead,
  TableEmpty,
} from "@/components/ui/data-table";
import { SearchField } from "@/components/ui/search-field";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const COL_COUNT = 6;

/** SaaS-only — stripped from OSS builds. */
export default function AdminRunnersPage() {
  const [shared, setShared] = useState("all");
  const [status, setStatus] = useState("all");
  const filters = useMemo(() => ({ shared, status }), [shared, status]);

  const list = usePagedList<AdminRunnerRow>({
    path: "/api/admin/runners",
    defaultSort: "createdAt",
    filters,
  });

  const [busyId, setBusyId] = useState<string | null>(null);

  async function toggleShared(runner: AdminRunnerRow, isShared: boolean) {
    setBusyId(runner.id);
    try {
      const res = await api<{ runner: { id: string; isShared: boolean } }>(
        `/api/admin/runners/${runner.id}`,
        { method: "PATCH", json: { isShared } },
      );
      list.patchItem((r) => r.id === runner.id, { isShared: res.runner.isShared });
      toast.success(isShared ? "已设为共享 Runner" : "已取消共享");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <SettingsHeader
        title="共享 Runner"
        description="标记为共享后任意团队都可绑定；每团队同时仅允许 1 个活跃工作区，禁止宿主机容器分配与归档。"
      />

      <ListToolbar>
        <SearchField
          value={list.query}
          onValueChange={list.setQuery}
          placeholder="搜索名称、团队或创建者…"
          className="w-full sm:w-72"
          aria-label="搜索 Runner"
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          共享
          <select
            value={shared}
            onChange={(e) => setShared(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
          >
            <option value="all">全部</option>
            <option value="shared">已共享</option>
            <option value="private">未共享</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          状态
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
          >
            <option value="all">全部</option>
            <option value="online">在线</option>
            <option value="offline">离线</option>
          </select>
        </label>
      </ListToolbar>

      {list.error ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {list.error}
        </p>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            <SortableTableHead
              columnKey="name"
              state={list.sortState}
              onSortChange={list.setSortState}
            >
              名称
            </SortableTableHead>
            <TableHead>所属团队</TableHead>
            <TableHead>创建者</TableHead>
            <SortableTableHead
              columnKey="status"
              state={list.sortState}
              onSortChange={list.setSortState}
            >
              状态
            </SortableTableHead>
            <SortableTableHead
              columnKey="lastSeenAt"
              state={list.sortState}
              onSortChange={list.setSortState}
            >
              最后在线
            </SortableTableHead>
            <TableHead className="w-20">共享</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.loading || !list.items.length ? (
            <TableEmpty
              colSpan={COL_COUNT}
              loading={list.loading}
              message={
                list.query
                  ? `没有匹配「${list.query}」的 Runner`
                  : "暂无远程 Runner。请先在任一管理员团队下创建 Runner。"
              }
            />
          ) : (
            list.items.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <div className="font-medium">{r.name}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">{r.slug}</div>
                </TableCell>
                <TableCell className="text-xs">
                  <Link
                    href={`/dashboard/admin/tenants/${r.tenantId}`}
                    className="hover:underline"
                  >
                    {r.tenantName ?? r.tenantSlug ?? r.tenantId}
                  </Link>
                </TableCell>
                <TableCell className="text-xs">
                  {r.createdByUserId ? (
                    <Link
                      href={`/dashboard/admin/users/${r.createdByUserId}`}
                      className="hover:underline"
                    >
                      {r.createdByEmail ?? r.createdByUserId}
                    </Link>
                  ) : (
                    "—"
                  )}
                  {r.ownerIsPlatformAdmin ? (
                    <Badge variant="secondary" className="ml-1">
                      管理员
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{r.status}</Badge>
                </TableCell>
                <TableCell
                  className="text-xs text-muted-foreground"
                  title={formatAbsolute(r.lastSeenAt)}
                >
                  {formatRelative(r.lastSeenAt, "从未")}
                </TableCell>
                <TableCell>
                  <Switch
                    checked={r.isShared}
                    disabled={busyId === r.id}
                    onCheckedChange={(v) => void toggleShared(r, v)}
                  />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <DataTablePagination
        page={list.page}
        pageSize={list.pageSize}
        total={list.total}
        loading={list.loading}
        onPageChange={list.setPage}
        onPageSizeChange={list.setPageSize}
      />
    </div>
  );
}
