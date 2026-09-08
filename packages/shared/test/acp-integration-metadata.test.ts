import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acpAgentByProfile,
  acpAgents,
  acpApiKeyDotenv,
  builtinAcpProfiles,
  supportsAcpZakuraRoute,
} from "../src/index.js";

/**
 * Zakura reads its ACP catalogue and wiring from the registry. These tests
 * pin that contract: adding an agent must be a registry-only change, and the
 * per-agent behaviour we used to hardcode must keep coming from `integration`.
 */

test("the catalogue is the registry, not a local list", () => {
  const profiles = builtinAcpProfiles().map((p) => p.id).sort();
  const registry = acpAgents().map((a) => a.profileId).sort();
  assert.deepEqual(profiles, registry);
  // Guard against the catalogue silently collapsing to a handful of entries.
  assert.ok(profiles.length >= 40, `expected the full registry, got ${profiles.length}`);
});

test("agents that exist only in the registry are still offered", () => {
  // None of these have hand-written form copy in acp.ts; they must appear
  // anyway, otherwise adding an agent would still require a Zakura edit.
  const ids = new Set(builtinAcpProfiles().map((p) => p.id));
  for (const id of ["harn", "kilo", "dimcode", "minion-code", "qoder", "stakpak", "vtcode"]) {
    assert.ok(ids.has(id), `${id} should be offered straight from the registry`);
  }
});

test("agents with hand-written copy keep their richer form", () => {
  const byId = new Map(builtinAcpProfiles().map((p) => [p.id, p]));
  for (const id of ["claude-code", "codex", "gemini-cli", "hermes", "opencode"]) {
    const p = byId.get(id);
    assert.ok(p, `${id} missing`);
    assert.ok(p.displayName && p.displayName !== id, `${id} lost its display name`);
    assert.ok((p.managedFields ?? []).length > 0, `${id} lost its form fields`);
  }
});

test("wiring comes from the registry's integration block", () => {
  const byId = new Map(builtinAcpProfiles().map((p) => [p.id, p]));

  // opencode is the agent whose model ids are provider/model shaped.
  assert.equal(acpAgentByProfile("opencode")?.integration?.modelPrefix, "zakura/");
  assert.equal(byId.get("opencode")?.supportsZakuraRoute, true);
  assert.equal(supportsAcpZakuraRoute(byId.get("opencode")!), true);

  // A session mode that used to be keyed off the agent name.
  assert.equal(byId.get("claude-code")?.sessionModeId, "default");

  // Every profile flagged for the Zakura route must say so in the registry,
  // so the two can never drift apart again.
  for (const p of builtinAcpProfiles()) {
    const declared = acpAgentByProfile(p.id)?.integration?.zakuraRoute ?? false;
    assert.equal(p.supportsZakuraRoute, declared, `${p.id} route flag drifted`);
  }

  // The decisive check: agents with no hand-written table entry at all must
  // still be fully formed. If the catalogue ever reverts to a local table
  // these disappear entirely, which no amount of field-by-field comparison
  // would reveal (the table and the registry currently agree by construction).
  const ids = new Set(builtinAcpProfiles().map((p) => p.id));
  for (const id of ["harn", "kilo", "dimcode", "qoder", "stakpak", "vtcode"]) {
    assert.ok(ids.has(id), `${id} is registry-only and must survive`);
  }
  // And their wiring must be the registry's answer, not a stale default.
  for (const p of builtinAcpProfiles()) {
    const agent = acpAgentByProfile(p.id);
    assert.ok(agent, `${p.id} has no registry agent backing it`);
    assert.equal(p.sessionModeId, agent.integration?.sessionModeId);
    assert.equal(p.forceHttpMcp, agent.integration?.forceHttpMcp ?? false);
  }
});

test("dotenv is rendered from the registry template", () => {
  // Routed through Zakura: provider is forced to openai and the gateway
  // credentials are used.
  const routed = acpApiKeyDotenv("hermes", {
    zakura_api_key: "zk-1",
    zakura_base_url: "https://gw/v1",
    model: "gpt-4",
  });
  assert.ok(routed);
  assert.match(routed, /^LLM_PROVIDER=openai$/m);
  assert.match(routed, /^LLM_API_KEY=zk-1$/m);
  assert.match(routed, /^HERMES_BASE_URL=https:\/\/gw\/v1$/m);

  // Self-managed: the user's own provider survives.
  const own = acpApiKeyDotenv("hermes", {
    api_key: "sk-2",
    base_url: "https://api/v1",
    provider: "anthropic",
  });
  assert.ok(own);
  assert.match(own, /^LLM_PROVIDER=anthropic$/m);

  // Placeholders with no value must not emit blank assignments.
  const partial = acpApiKeyDotenv("hermes", { api_key: "sk-3" });
  assert.ok(partial);
  assert.ok(!/BASE_URL=$/m.test(partial), "emitted an empty base url");
  assert.ok(!partial.includes("${"), "left an unsubstituted placeholder");

  // Nothing to write, and agents with no template declared get nothing.
  assert.equal(acpApiKeyDotenv("hermes", {}), null);
  assert.equal(acpApiKeyDotenv("codex", { api_key: "sk-4" }), null);
});