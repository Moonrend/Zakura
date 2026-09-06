import { strict as assert } from "node:assert";
import { test } from "node:test";

import { resolveAcpLaunch } from "../src/acp.js";
import { acpAgents } from "../src/acp-registry-client.js";

/**
 * Regression tests for the 2026-09-06 report:
 *   - fast-agent: "无验证头"，重试后变回 Zakura/官方端点
 *   - dirac: npm ENOENT spawn sh in /workspace/.zakura/acp/... (host installer)
 *
 * fast-agent reads provider settings through pydantic-settings with
 * env_nested_delimiter="__".  Its `base_url` has NO flat env fallback, so
 * OPENAI_BASE_URL alone is silently ignored and it dials api.openai.com with
 * our gateway key -> 401 / "missing authentication header".
 *
 * Verified empirically against ghcr.io/moonrend/acp-registry/fast-agent:0.10.1:
 *   OPENAI__BASE_URL=... -> Settings().openai.base_url == that value.
 */

const BASE = "http://zakura:8787/v1";
const KEY = "sk-test-token";

function launchFastAgent() {
  const profile: any = {
    id: "fast-agent",
    command: "fast-agent",
    args: ["acp"],
    managedFields: [],
  };
  const setup: any = {
    modelProvider: "zakura",
    setupMode: "managed",
    managed: {
      zakura_api_key: KEY,
      zakura_base_url: BASE,
    },
  };
  return resolveAcpLaunch(profile, setup);
}

test("fast-agent receives the nested base_url override", () => {
  const { env } = launchFastAgent();
  assert.equal(
    env.OPENAI__BASE_URL,
    BASE,
    "fast-agent ignores the flat OPENAI_BASE_URL for base_url and falls back " +
      "to api.openai.com -> the reported 401 / 'reverts to Zakura'",
  );
});

test("fast-agent receives the nested api_key override", () => {
  const { env } = launchFastAgent();
  assert.equal(env.OPENAI__API_KEY, KEY);
});

test("every registry agent carries a container image", () => {
  const agents: any[] = acpAgents();
  assert.ok(agents.length > 0, "registry snapshot must not be empty");
  assert.deepEqual(
    agents.filter((a) => !a.image).map((a) => a.id),
    [],
    "an agent without an image falls through to the workspace npm/uvx " +
      "installer — the reported dirac ENOENT sharp failure",
  );
});

test("dist.kind is never 'image', so install must key on agent.image", () => {
  const agents: any[] = acpAgents();
  // The trap that made the earlier fix a silent no-op: guarding on
  // dist.kind === "image" matches ZERO agents, so all of them fell through
  // to the host installer.
  assert.equal(
    agents.filter((a) => a.dist?.kind === "image").length,
    0,
    "no agent uses dist.kind='image'; that guard matches nothing",
  );
});