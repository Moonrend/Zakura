"use client";

import { useMemo } from "react";
import Fuse, { type IFuseOptions } from "fuse.js";

/**
 * 前端模糊搜索。
 *
 * 统一用 Fuse 而不是 `toLowerCase().includes()`：后者要求逐字符连续命中，
 * 打错一个字母、少打一个连字符就搜不到（`gpt4o` 找不到 `gpt-4o`）。
 *
 * 默认参数的取舍：
 * - `threshold 0.34`：比 Fuse 默认的 0.6 严一些。列表里多是模型名 / slug 这类
 *   短字符串，0.6 会把不相干项也捞进来。
 * - `ignoreLocation`：默认只在前 60 个字符里找，长标题会漏。
 * - `minMatchCharLength 1`：留着 Fuse 默认值。设成 2 会让「只敲了一个字」的
 *   查询直接空结果，比噪声更难受。
 *
 * 中文注意：Fuse 按字符做 bitap，中文本来就是一字一词，效果尚可；
 * 但它不做分词，所以调用方要把可搜的字段都列进 `keys`（含 slug、别名等）。
 */
export type UseFuzzySearchOptions<T> = {
  /** 参与匹配的字段（支持 `a.b` 路径与权重） */
  keys: ReadonlyArray<string | { name: string; weight?: number }>;
  /** 0 = 完全匹配，1 = 什么都匹配 */
  threshold?: number;
  /** 查询为空时返回的列表，默认原样返回 */
  emptyReturnsAll?: boolean;
  /** 结果条数上限 */
  limit?: number;
  extra?: Omit<IFuseOptions<T>, "keys" | "threshold">;
};

/**
 * 返回按相关度排序的匹配项。查询为空时原样返回输入列表（保持原始顺序）。
 */
export function useFuzzySearch<T>(
  items: readonly T[],
  query: string,
  {
    keys,
    threshold = 0.34,
    emptyReturnsAll = true,
    limit,
    extra,
  }: UseFuzzySearchOptions<T>,
): T[] {
  // keys 常以字面量数组传入，每次渲染都是新引用；序列化成稳定的依赖值，
  // 否则 Fuse 索引会在每次渲染时重建。
  const keySignature = useMemo(() => JSON.stringify(keys), [keys]);

  const fuse = useMemo(
    () =>
      new Fuse(items as T[], {
        keys: JSON.parse(keySignature) as IFuseOptions<T>["keys"],
        threshold,
        ignoreLocation: true,
        ...extra,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keys 走序列化后的签名
    [items, keySignature, threshold, extra],
  );

  return useMemo(() => {
    const q = query.trim();
    if (!q) return emptyReturnsAll ? (items as T[]) : [];
    const hits = fuse.search(q, limit ? { limit } : undefined).map((r) => r.item);
    return hits;
  }, [fuse, query, items, emptyReturnsAll, limit]);
}

/**
 * 不依赖 React 的版本，供 `useMemo` 内部或非组件代码使用。
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  keys: ReadonlyArray<string | { name: string; weight?: number }>,
  opts?: { threshold?: number; limit?: number },
): T[] {
  const q = query.trim();
  if (!q) return items as T[];
  const fuse = new Fuse(items as T[], {
    keys: keys as IFuseOptions<T>["keys"],
    threshold: opts?.threshold ?? 0.34,
    ignoreLocation: true,
  });
  return fuse.search(q, opts?.limit ? { limit: opts.limit } : undefined).map((r) => r.item);
}
