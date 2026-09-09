import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  builtinAcpProfiles,
  parseAcpAgentSetup,
  resolveAcpLaunch,
} from "../src/acp.js";
import { acpAgents } from "../src/acp-registry-client.js";

/**
 * Runtime integration regressions found with the real published images:
 * - fast-agent ignores generic OPENAI_MODEL and defaults to codex unless its
 *   generic provider plus nested GENERIC__ settings are selected;
 * - Dirac ignores OPENAI_* and falls back to OpenRouter unless DIRAC_* is set;
 * - Goose fails session/new without GOOSE_PROVIDER and its OpenAI host/path.
 *
 * These names are deliberately registry data, not another host-side adapter
 * switch. resolveAcpLaunch must expand `${managed.*}` templates from the synced
 * registry snapshot.
 */

const BASE = "http://zakura:8787/v1";
const KEY = "zak_test_token";
const MODEL = "deepseek-v4-flash";

function launch(profileId: string) {
  const profile = builtinAcpProfiles().find((candidate) => candidate.id === profileId);
  assert.ok(profile, `missing builtin profile ${profileId}`);
  return resolveAcpLaunch(profile, parseAcpAgentSetup(profileId, {
    enabled: true,
    setupMode: "managed",
    modelProvider: "zakura",
    managed: {
      zakura_api_key: KEY,
      zakura_base_url: BASE,
      model: MODEL,
    },
  }));
}

test("fast-agent selects its generic provider with the gateway key and model", () => {
  const { env } = launch("fast-agent");
  assert.equal(env.FAST_AGENT_MODEL, `generic.${MODEL}`);
  assert.equal(env.GENERIC__API_KEY, KEY);
  assert.equal(env.GENERIC__BASE_URL, BASE);
  assert.equal(env.GENERIC__DEFAULT_MODEL, MODEL);
});

test("Dirac selects OpenAI with its own provider variable names", () => {
  const { env } = launch("dirac");
  assert.equal(env.DIRAC_PROVIDER, "openai");
  assert.equal(env.DIRAC_API_KEY, KEY);
  assert.equal(env.DIRAC_BASE_URL, BASE);
  assert.equal(env.DIRAC_MODEL, MODEL);
});

test("Goose receives the provider, model, gateway host, and endpoint path", () => {
  const { env } = launch("goose");
  assert.equal(env.GOOSE_PROVIDER, "openai");
  assert.equal(env.GOOSE_MODEL, MODEL);
  assert.equal(env.OPENAI_API_KEY, KEY);
  assert.equal(env.OPENAI_HOST, BASE);
  assert.equal(env.OPENAI_BASE_PATH, "chat/completions");
});

test("native credentials do not resurrect a retained Zakura route", () => {
  const profile = builtinAcpProfiles().find((candidate) => candidate.id === "fast-agent");
  assert.ok(profile);
  const setup = parseAcpAgentSetup("fast-agent", {
    enabled: true,
    setupMode: "managed",
    modelProvider: "native",
    managed: {
      api_key: "native-key",
      model: MODEL,
      // Setup persistence retains old route-specific secrets by design.
      zakura_api_key: "stale-zakura-key",
      zakura_base_url: BASE,
    },
  });
  const { env } = resolveAcpLaunch(profile, setup);
  assert.equal(env.OPENAI_API_KEY, "native-key");
  assert.equal(env.FAST_AGENT_MODEL, undefined);
  assert.equal(env.GENERIC__API_KEY, undefined);
});

test("adapters proven to ignore generic gateway settings do not advertise Zakura routing", () => {
  const unsupported = new Set(["cline", "deepagents", "sigit"]);
  const falselyRouted = acpAgents()
    .filter((agent) => unsupported.has(agent.profileId) && agent.integration?.zakuraRoute)
    .map((agent) => agent.profileId);
  assert.deepEqual(falselyRouted, []);
});

test("every registry agent carries a container image", () => {
  const agents: any[] = acpAgents();
  assert.ok(agents.length > 0, "registry snapshot must not be empty");
  assert.deepEqual(
    agents.filter((agent) => !agent.image).map((agent) => agent.id),
    [],
    "an agent without an image falls through to the workspace installer",
  );
});

test("dist.kind is never 'image', so install must key on agent.image", () => {
  const agents: any[] = acpAgents();
  assert.equal(
    agents.filter((agent) => agent.dist?.kind === "image").length,
    0,
    "no agent uses dist.kind='image'; that guard matches nothing",
  );
});
