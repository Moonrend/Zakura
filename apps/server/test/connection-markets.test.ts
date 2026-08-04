/**
 * 市场聚合与 storeRef 解析自检。
 */
import assert from "node:assert/strict";
import { BUILTIN_MARKETS, getBuiltinMarket } from "@zakura/shared";

function splitStoreRef(rest: string): { storeId: string; name: string } | null {
  for (const prefix of ["custom:", "market:"] as const) {
    if (rest.startsWith(prefix)) {
      const after = rest.slice(prefix.length);
      const i = after.indexOf(":");
      if (i < 0) return null;
      return { storeId: `${prefix}${after.slice(0, i)}`, name: after.slice(i + 1) };
    }
  }
  const i = rest.indexOf(":");
  if (i < 0) return null;
  return { storeId: rest.slice(0, i), name: rest.slice(i + 1) };
}

assert.deepEqual(splitStoreRef("market:claude-plugins-official:notion"), {
  storeId: "market:claude-plugins-official",
  name: "notion",
});
assert.deepEqual(splitStoreRef("custom:abc123:io.github/foo"), {
  storeId: "custom:abc123",
  name: "io.github/foo",
});
assert.deepEqual(splitStoreRef("official-registry:io.modelcontextprotocol/server"), {
  storeId: "official-registry",
  name: "io.modelcontextprotocol/server",
});

assert.ok(getBuiltinMarket("claude-plugins-official"));
assert.ok(getBuiltinMarket("skill-repo:openai/skills"));
assert.ok(BUILTIN_MARKETS.some((m) => m.id === "all") === false);
assert.ok(BUILTIN_MARKETS.some((m) => m.kind === "plugin-repo"));
assert.ok(BUILTIN_MARKETS.some((m) => m.kind === "skill-repo"));

console.log("connection-markets self-check ok");
