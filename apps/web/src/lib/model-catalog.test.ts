import assert from "node:assert/strict";
import test from "node:test";
import { modelCatalogRefreshSummary, modelCatalogUnmatchedReason } from "./model-catalog";

test("repeated refresh describes unchanged data rather than zero successful updates", () => {
  const summary = modelCatalogRefreshSummary({ catalogEntries: 9633, matched: 101, updated: 0, unchanged: 101, unmatched: 125 });
  assert.equal(summary, "101 个模型的元数据无变化，125 个未匹配");
  assert.equal(modelCatalogRefreshSummary({ catalogEntries: 9633, matched: 165, updated: 64, unchanged: 101, unmatched: 61 }), "已更新 64 个模型的元数据，101 个无变化，61 个未匹配");
});

test("no matches and ambiguous catalog entries explain the missing data", () => {
  assert.match(modelCatalogRefreshSummary({ catalogEntries: 50, matched: 0, updated: 0, unmatched: 2 }), /没有匹配/);
  assert.equal(modelCatalogUnmatchedReason("ambiguous"), "目录候选冲突");
  assert.equal(modelCatalogUnmatchedReason("not_found"), "目录未收录此名称");
});
