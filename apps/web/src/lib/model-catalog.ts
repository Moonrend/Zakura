export type ModelCatalogRefreshResult = {
  catalogEntries: number;
  matched: number;
  updated: number;
  unchanged?: number;
  unmatched: number;
  unmatchedModels?: Array<{
    id: string;
    nativeModel: string;
    reason: "not_found" | "ambiguous";
  }>;
  failed?: Record<string, string>;
};

export function modelCatalogRefreshSummary(result: ModelCatalogRefreshResult): string {
  if (result.matched === 0) {
    return `已获取 ${result.catalogEntries} 条目录数据，没有匹配到已安装模型`;
  }
  const unchanged = result.unchanged ?? Math.max(0, result.matched - result.updated);
  const parts = result.updated > 0
    ? [`已更新 ${result.updated} 个模型的元数据`]
    : [`${result.matched} 个模型的元数据无变化`];
  if (result.updated > 0 && unchanged > 0) parts.push(`${unchanged} 个无变化`);
  if (result.unmatched > 0) parts.push(`${result.unmatched} 个未匹配`);
  return parts.join("，");
}

export function modelCatalogUnmatchedReason(reason: string): string {
  return reason === "ambiguous" ? "目录候选冲突" : "目录未收录此名称";
}
