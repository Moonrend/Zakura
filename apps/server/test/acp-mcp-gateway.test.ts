import assert from "node:assert/strict";
import { test } from "node:test";

import { listHttpMcpServers } from "../src/services/acp/session.js";

/**
 * Regression tests for MCP gateway convergence.
 *
 * Context: every entry in `session/new.mcpServers` is REQUIRED by the ACP wire
 * protocol (`McpServer` has no optional/enabled flag), so one bad upstream
 * aborts the entire session with "Required MCP server '<name>' failed to
 * start". We therefore hand the agent a single aggregated endpoint - our own
 * gateway - instead of fanning out one entry per binding.
 */

function fakeAgentService(bindings: unknown[]) {
  return {
    listBindings: async () => bindings,
  } as never;
}

const GATEWAY = {
  baseUrl: "https://example.test",
  slug: "my-agent",
  apiKey: "zak_test_key",
};

test("gateway mode collapses all bindings into a single MCP entry", async () => {
  const svc = fakeAgentService([
    { instanceSlug: "grep", instanceName: "Grep", endpointUrl: "https://mcp.grep.app/" },
    { instanceSlug: "ctx7", instanceName: "Context7", endpointUrl: "https://ctx7.example/" },
    { instanceSlug: "gh", instanceName: "GitHub", endpointUrl: "https://gh.example/" },
  ]);

  const out = await listHttpMcpServers(svc, "t1", "a1", GATEWAY);

  assert.equal(out.length, 1, "three bindings must collapse to one endpoint");
  assert.equal(out[0]!.name, "zakura");
});

test("gateway URL targets the agent-scoped endpoint and carries bearer auth", async () => {
  const out = await listHttpMcpServers(fakeAgentService([]), "t1", "a1", GATEWAY);

  const entry = out[0] as { url: string; headers: { name: string; value: string }[] };
  assert.equal(entry.url, "https://example.test/mcp/agents/my-agent");
  assert.deepEqual(entry.headers, [
    { name: "Authorization", value: "Bearer zak_test_key" },
  ]);
});

test("gateway mode does not expose upstreams directly to the agent", async () => {
  // The whole point: mcp.grep.app answers `notifications/initialized` with a
  // bare 202 (no content-type), which fx rejects as MissingContentType. It
  // must not appear in what we hand the agent.
  const svc = fakeAgentService([
    { instanceSlug: "grep", instanceName: "Grep", endpointUrl: "https://mcp.grep.app/" },
  ]);

  const out = await listHttpMcpServers(svc, "t1", "a1", GATEWAY);

  const urls = out.map((s) => (s as { url: string }).url);
  assert.ok(
    !urls.some((u) => u.includes("grep.app")),
    "upstream must be fronted by the gateway, not handed over directly",
  );
});

test("trailing slashes in the base URL do not produce a doubled path separator", async () => {
  const out = await listHttpMcpServers(fakeAgentService([]), "t1", "a1", {
    ...GATEWAY,
    baseUrl: "https://example.test///",
  });

  assert.equal((out[0] as { url: string }).url, "https://example.test/mcp/agents/my-agent");
});

test("agent slugs are URL-encoded", async () => {
  const out = await listHttpMcpServers(fakeAgentService([]), "t1", "a1", {
    ...GATEWAY,
    slug: "weird slug/../x",
  });

  const url = (out[0] as { url: string }).url;
  assert.ok(!url.includes(" "), "spaces must be encoded");
  assert.ok(!url.includes("/../"), "path traversal must not survive encoding");
});

test("without gateway credentials it falls back to per-binding fan-out", async () => {
  const svc = fakeAgentService([
    { instanceSlug: "grep", instanceName: "Grep", endpointUrl: "https://mcp.grep.app/" },
    { instanceSlug: "ctx7", instanceName: "Context7", endpointUrl: "https://ctx7.example/" },
  ]);

  const out = await listHttpMcpServers(svc, "t1", "a1", undefined);

  assert.equal(out.length, 2, "legacy behaviour must be preserved for self-hosted setups");
  assert.deepEqual(out.map((s) => s.name).sort(), ["ctx7", "grep"]);
});

test("fallback still skips bindings without a usable http endpoint", async () => {
  const svc = fakeAgentService([
    { instanceSlug: "ok", instanceName: "Ok", endpointUrl: "https://ok.example/" },
    { instanceSlug: "empty", instanceName: "Empty", endpointUrl: "   " },
    { instanceSlug: "none", instanceName: "None", endpointUrl: null },
    { instanceSlug: "stdio", instanceName: "Stdio", endpointUrl: "stdio://local" },
  ]);

  const out = await listHttpMcpServers(svc, "t1", "a1", undefined);

  assert.deepEqual(out.map((s) => s.name), ["ok"]);
});