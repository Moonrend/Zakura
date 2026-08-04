/**
 * StorePackage 归一化自检：计数与插件分组。
 */
import assert from "node:assert/strict";
import type { StorePackageComponent } from "@zakura/shared";

function countsFrom(components: StorePackageComponent[]) {
  const counts: Partial<Record<StorePackageComponent["kind"], number>> = {};
  for (const c of components) {
    counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  }
  return counts;
}

const sample: StorePackageComponent[] = [
  { id: "app:notion", kind: "app", name: "Notion", installRef: "plugin:custom:notion" },
  { id: "mcp:1", kind: "mcp", name: "Notion MCP", installRef: "mcp:custom:notion" },
  { id: "skill:a", kind: "skill", name: "Knowledge Capture", installRef: "github:x/y/a" },
  { id: "skill:b", kind: "skill", name: "Meeting Intelligence", installRef: "github:x/y/b" },
  { id: "skill:c", kind: "skill", name: "Research", installRef: "github:x/y/c" },
  { id: "skill:d", kind: "skill", name: "Spec", installRef: "github:x/y/d" },
  { id: "hooks:1", kind: "hook", name: "Hooks", installRef: "hooks:custom:notion" },
];

const counts = countsFrom(sample);
assert.equal(counts.app, 1);
assert.equal(counts.mcp, 1);
assert.equal(counts.skill, 4);
assert.equal(counts.hook, 1);

// 分项安装：去掉 app 后应有 6 个可装组件
const installable = sample.filter((c) => c.kind !== "app");
assert.equal(installable.length, 6);

console.log("connection-packages self-check ok");
