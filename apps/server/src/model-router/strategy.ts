import type { ModelCapability, ModelRouteStrategy } from "@zakura/shared";
import type { ResolvedRoute } from "./types.js";

/** 无放回加权随机洗牌：同模型多供应商时按 weight 概率排序尝试 */
export function weightedShuffle<T extends { weight: number }>(items: T[]): T[] {
  if (items.length <= 1) return [...items];
  const pool = [...items];
  const result: T[] = [];
  while (pool.length > 0) {
    const total = pool.reduce((sum, item) => sum + Math.max(1, item.weight), 0);
    let cursor = Math.random() * total;
    let picked = 0;
    for (let i = 0; i < pool.length; i++) {
      cursor -= Math.max(1, pool[i]!.weight);
      if (cursor <= 0) {
        picked = i;
        break;
      }
      picked = i;
    }
    result.push(pool.splice(picked, 1)[0]!);
  }
  return result;
}

/**
 * 将候选链按 alias 分组：
 * - 默认 alias（含 isDefault）优先
 * - 组内按 strategy 排序（weighted 随机 / priority 保序）
 * - 组间按原 priority 顺序
 */
export function orderRoutesForStrategy(
  routes: ResolvedRoute[],
  strategy: ModelRouteStrategy,
  preferredAlias?: string,
): ResolvedRoute[] {
  if (routes.length <= 1) return routes;

  const groups = new Map<string, ResolvedRoute[]>();
  for (const r of routes) {
    const key = r.alias || r.model;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const aliasOrder: string[] = [];
  if (preferredAlias && groups.has(preferredAlias)) {
    aliasOrder.push(preferredAlias);
  }
  for (const r of routes) {
    const key = r.alias || r.model;
    if (!aliasOrder.includes(key)) aliasOrder.push(key);
  }

  const ordered: ResolvedRoute[] = [];
  for (const alias of aliasOrder) {
    const group = groups.get(alias) ?? [];
    if (strategy === "weighted" && group.length > 1) {
      ordered.push(...weightedShuffle(group));
    } else {
      ordered.push(...group);
    }
  }
  return ordered;
}

export type ResolveStrategyInput = {
  capability: ModelCapability;
  routeId?: string;
  slug?: string;
  /** 按逻辑模型别名解析（多供应商加权） */
  alias?: string;
  strategy?: ModelRouteStrategy;
};
