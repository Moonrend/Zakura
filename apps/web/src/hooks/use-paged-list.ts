"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { SortOrder, SortState } from "@/components/ui/data-table";

export type PagedResponse<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type PagedListOptions = {
  /** 不含 query string 的接口路径，如 `/api/admin/users` */
  path: string;
  defaultSort: string;
  defaultOrder?: SortOrder;
  defaultPageSize?: number;
  /** 额外筛选参数；空串会被忽略 */
  filters?: Record<string, string>;
  /** 关闭时不发请求（例如权限还没确认） */
  enabled?: boolean;
};

/**
 * 服务端分页列表：搜索 / 排序 / 筛选 / 翻页统一收口。
 *
 * 搜索输入做 300ms 防抖；任何会改变结果集的条件变化都会把 page 重置回 1，
 * 否则在第 3 页改筛选条件会落到空页。
 */
export function usePagedList<T>(options: PagedListOptions) {
  const {
    path,
    defaultSort,
    defaultOrder = "desc",
    defaultPageSize = 20,
    filters,
    enabled = true,
  } = options;

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [sortState, setSortState] = useState<SortState>({
    sort: defaultSort,
    order: defaultOrder,
  });
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  // filters 通常是内联字面量，用序列化后的值做依赖，避免每次渲染都重新请求
  const filterKey = useMemo(() => JSON.stringify(filters ?? {}), [filters]);

  // 条件变了就回到第一页（首次挂载不触发）
  const conditionKey = `${debouncedQuery}|${filterKey}|${sortState.sort}|${sortState.order}|${pageSize}`;
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setPage(1);
  }, [conditionKey]);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedQuery) params.set("q", debouncedQuery);
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    params.set("sort", sortState.sort);
    params.set("order", sortState.order);
    for (const [key, value] of Object.entries(JSON.parse(filterKey) as Record<string, string>)) {
      if (value) params.set(key, value);
    }
    return `${path}?${params.toString()}`;
  }, [path, debouncedQuery, page, pageSize, sortState.sort, sortState.order, filterKey]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await api<PagedResponse<T>>(url, { cacheTtlMs: false });
        if (cancelled) return;
        setItems(res.items ?? []);
        setTotal(res.total ?? 0);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setItems([]);
        setTotal(0);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, enabled, reloadToken]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  /** 就地替换一行，避免写操作后整页重拉 */
  const patchItem = useCallback((match: (item: T) => boolean, patch: Partial<T>) => {
    setItems((list) => list.map((item) => (match(item) ? { ...item, ...patch } : item)));
  }, []);

  return {
    query,
    setQuery,
    page,
    setPage,
    pageSize,
    setPageSize,
    sortState,
    setSortState,
    items,
    total,
    loading,
    error,
    reload,
    patchItem,
  };
}
