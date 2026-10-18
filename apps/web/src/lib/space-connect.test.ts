import assert from "node:assert/strict";
import test from "node:test";
import { buildConnectSnippets, connectKeyAccessLabel, connectKeyScopes, keySupportsProtocol } from "./space-connect";

test("shared connection keys grant MCP and Gateway access without general API access", () => {
  const scopes = connectKeyScopes("both");
  assert.equal(keySupportsProtocol(scopes, "mcp"), true);
  assert.equal(keySupportsProtocol(scopes, "gateway"), true);
  assert.equal(scopes.includes("*"), false);
  assert.equal(scopes.includes("api"), false);
  assert.equal(keySupportsProtocol(connectKeyScopes("mcp"), "gateway"), false);
  assert.equal(keySupportsProtocol(connectKeyScopes("gateway"), "mcp"), false);
});

test("existing wildcard and partial Gateway keys retain accurate access labels", () => {
  assert.equal(connectKeyAccessLabel(["*"]), "全部权限");
  assert.equal(keySupportsProtocol(["*"], "mcp"), true);
  assert.equal(keySupportsProtocol(["*"], "gateway"), true);
  assert.equal(connectKeyAccessLabel(["gateway:models"]), "AI Gateway");
  assert.equal(connectKeyAccessLabel(["gateway"]), "AI Gateway");
  assert.equal(connectKeyAccessLabel(["mcp"]), "MCP");
  assert.equal(keySupportsProtocol(["api"], "gateway"), false);
});

test("connection examples use the current space URL and selected credential", () => {
  const snippets = buildConnectSnippets({
    mcpUrl: "https://example.test/mcp/spaces/research",
    gatewayBaseUrl: "https://example.test/v1",
    spaceSlug: "research",
    key: "test-credential",
  });
  const mcp = JSON.parse(snippets.mcpServers).mcpServers["zakura-research"];
  assert.equal(mcp.url, "https://example.test/mcp/spaces/research");
  assert.equal(mcp.headers.Authorization, "Bearer test-credential");
  assert.equal(JSON.parse(snippets.servers).servers["zakura-research"].type, "http");
  assert.match(snippets.request, /Accept: application\/json, text\/event-stream/);
  assert.equal(snippets.gateway, "OPENAI_BASE_URL=https://example.test/v1\nOPENAI_API_KEY=test-credential");
  const placeholder = buildConnectSnippets({ mcpUrl: "mcp", gatewayBaseUrl: "gateway", spaceSlug: "" });
  assert.match(placeholder.mcpServers, /Bearer <access-key>/);
  assert.match(placeholder.gateway, /OPENAI_API_KEY=<access-key>/);
});
