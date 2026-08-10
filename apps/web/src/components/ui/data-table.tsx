"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";

export type SortOrder = "asc" | "desc";

export type SortState = { sort: string; order: SortOrder };

/**
 * 列表页工具条：搜索框 + 若干筛选控件 + 右侧操作。
 * 控件统一 h-8，和 tool-calls 面板的筛选条保持一致。
 */
export function ListToolbar({
  children,
  actions,
  className,
}: {
  children: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2.5",
        className,
      )}
    >
      {children}
      {actions ? <div className="ml-auto flex items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

/**
 * 可排序表头。点击在 desc → asc → desc 之间切换；切到别的列时重置为 desc。
 */
export function SortableTableHead({
  columnKey,
  state,
  onSortChange,
  children,
  className,
  align = "left",
}: {
  columnKey: string;
  state: SortState;
  onSortChange: (next: SortState) => void;
  children: React.ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  const active = state.sort === columnKey;
  const Icon = !active ? ChevronsUpDown : state.order === "asc" ? ArrowUp : ArrowDown;

  return (
    <TableHead className={cn("p-0", className)}>
      <button
        type="button"
        aria-sort={active ? (state.order === "asc" ? "ascending" : "descending") : "none"}
        onClick={() =>
          onSortChange({
            sort: columnKey,
            order: active && state.order === "desc" ? "asc" : "desc",
          })
        }
        className={cn(
          "flex h-9 w-full items-center gap-1 px-3 text-xs font-medium transition-colors",
          "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          align === "right" && "justify-end",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <span className="truncate">{children}</span>
        <Icon className={cn("size-3 shrink-0", active ? "opacity-100" : "opacity-40")} />
      </button>
    </TableHead>
  );
}

/** 表内空态 / 加载态占位行 */
export function TableEmpty({
  colSpan,
  loading,
  message = "暂无数据",
}: {
  colSpan: number;
  loading?: boolean;
  message?: React.ReactNode;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="py-10 text-center text-sm text-muted-foreground">
        {loading ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin" />
            加载中…
          </span>
        ) : (
          message
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * 分页条：总数 + 当前区间 + 上/下一页 + 每页条数。
 * page 从 1 开始，与服务端 API 一致。
 */
export function DataTablePagination({
  page,
  pageSize,
  total,
  loading,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [20, 50, 100],
  className,
}: {
  page: number;
  pageSize: number;
  total: number;
  loading?: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
  className?: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground",
        className,
      )}
    >
      <span>
        共 {total} 条{total > 0 ? ` · 当前 ${from}–${to}` : ""}
      </span>
      <div className="flex items-center gap-2">
        {onPageSizeChange ? (
          <label className="flex items-center gap-1">
            <span className="sr-only">每页条数</span>
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="h-7 rounded-md border border-input bg-background px-1.5 text-[11px]"
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>
                  {n} / 页
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className="tabular-nums">
          {page} / {pageCount}
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={page <= 1 || loading}
          onClick={() => onPageChange(page - 1)}
        >
          上一页
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={page >= pageCount || loading}
          onClick={() => onPageChange(page + 1)}
        >
          下一页
        </Button>
      </div>
    </div>
  );
}
