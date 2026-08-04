/**
 * ConnectionCatalog 分发与 installRef 解析自检。
 */
import assert from "node:assert/strict";
import { CURATED_OAUTH_MCPS } from "@zakura/shared";

function parseInstallRef(source: string): { kind: string; rest: string } {
  const idx = source.indexOf(":");
  if (idx <= 0) return { kind: "auto", rest: source };
  return { kind: source.slice(0, idx), rest: source.slice(idx + 1) };
}

function kindFromProvider(providerId: string, config: Record<string, unknown>): string {
  if (providerId === "stdio-mcp") return "mcp-stdio";
  if (providerId === "generic-mcp") return "mcp-http";
  if (providerId === "google-workspace" || providerId === "microsoft-365" || providerId === "github" || providerId === "slack") return "platform";
  if (typeof config.mcpUrl === "string" && String(config.mcpUrl).startsWith("zakura://")) {
    return "platform";
  }
  return "mcp-http";
}

// installRef parsing
assert.deepEqual(parseInstallRef("curated:notion"), { kind: "curated", rest: "notion" });
assert.deepEqual(parseInstallRef("mcp:github-mcp:io.github.foo/bar"), {
  kind: "mcp",
  rest: "github-mcp:io.github.foo/bar",
});
assert.deepEqual(parseInstallRef("zakura:google-workspace/gmail"), {
  kind: "zakura",
  rest: "google-workspace/gmail",
});
assert.deepEqual(parseInstallRef("builtin:find-skills"), {
  kind: "builtin",
  rest: "find-skills",
});

// curated catalog non-empty + shared source
assert.ok(CURATED_OAUTH_MCPS.length >= 5);
assert.ok(CURATED_OAUTH_MCPS.some((m) => m.id === "notion"));

// provider → connection kind
assert.equal(kindFromProvider("stdio-mcp", {}), "mcp-stdio");
assert.equal(kindFromProvider("generic-mcp", {}), "mcp-http");
assert.equal(kindFromProvider("google-workspace", {}), "platform");
assert.equal(
  kindFromProvider("microsoft-365", { mcpUrl: "zakura://microsoft-365/outlook" }),
  "platform",
);

console.log("connection-catalog self-check ok");
