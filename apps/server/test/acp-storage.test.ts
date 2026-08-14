import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  acpApiKeyDotenv,
  acpRuntimeLayout,
  acpStageScript,
  acpSyncBackScript,
  buildCodexAuthJson,
  conversationRuntimeSwitch,
  parseAcpAgentConfig,
  parseAcpDefaultRuntime,
  preferNewerCodexAuth,
} from "@zakura/shared";

describe("ACP runtime storage", () => {
  it("stages only allowlisted files under durable and tmp runtime", () => {
    const layout = acpRuntimeLayout("codex", "oauth", "rt1");
    assert.equal(layout.durableDir, "/workspace/data/acp/codex");
    assert.equal(layout.runtimeDir, "/tmp/zakura-acp/codex/rt1");
    assert.equal(layout.env.CODEX_HOME, layout.stateDir);
    assert.equal(layout.env.HOME, layout.runtimeDir);
    assert.equal(layout.env.NO_BROWSER, "1");
    assert.ok(layout.artifacts.every((a) => !a.durableRel.includes("..")));
    const stage = acpStageScript(layout);
    assert.match(stage, /\/workspace\/data\/acp\/codex/);
    assert.match(stage, /\/tmp\/zakura-acp\/codex\/rt1/);
    assert.doesNotMatch(stage, /\/etc\//);
    assert.doesNotMatch(stage, /\/root\//);
    const sync = acpSyncBackScript(layout);
    assert.match(sync, /rm -rf '\/tmp\/zakura-acp\/codex\/rt1'/);
  });

  it("keeps Hermes and OpenCode homes off the workspace tree", () => {
    const hermes = acpRuntimeLayout("hermes", "api_key", "h1");
    assert.equal(hermes.env.HERMES_HOME, hermes.stateDir);
    assert.ok(hermes.env.HOME?.startsWith("/tmp/zakura-acp/"));
    const oc = acpRuntimeLayout("opencode", "self", "o1");
    assert.ok(oc.env.HOME?.startsWith("/tmp/zakura-acp/"));
    assert.ok(oc.env.XDG_CONFIG_HOME?.startsWith("/tmp/zakura-acp/"));
  });

  it("prefers the Codex auth.json with the newer last_refresh", () => {
    const older = JSON.stringify({ last_refresh: "2026-01-01T00:00:00.000Z", tokens: { access_token: "old" } });
    const newer = JSON.stringify({ last_refresh: "2026-08-01T00:00:00.000Z", tokens: { access_token: "new" } });
    assert.equal(JSON.parse(preferNewerCodexAuth(older, newer)).tokens.access_token, "new");
    assert.equal(JSON.parse(preferNewerCodexAuth(newer, older)).tokens.access_token, "new");
    assert.equal(JSON.parse(preferNewerCodexAuth("", newer)).tokens.access_token, "new");
  });

  it("writes Hermes .env from managed api_key fields", () => {
    const env = acpApiKeyDotenv("hermes", {
      provider: "openai",
      model: "gpt-4.1",
      api_key: "sk-h",
      base_url: "https://example.test",
    });
    assert.match(env ?? "", /LLM_API_KEY=sk-h/);
    assert.equal(acpApiKeyDotenv("codex", { api_key: "x" }), null);
  });

  it("builds Codex auth.json with last_refresh", () => {
    const raw = buildCodexAuthJson({
      id_token: "id",
      access_token: "at",
      refresh_token: "rt",
    });
    const parsed = JSON.parse(raw) as { last_refresh: string; tokens: { access_token: string } };
    assert.equal(parsed.tokens.access_token, "at");
    assert.ok(Date.parse(parsed.last_refresh));
  });
});

describe("ACP conversation runtime", () => {
  it("rebinds empty sessions and opens a new chat when history exists", () => {
    assert.equal(
      conversationRuntimeSwitch({
        currentRuntimeId: "zakura",
        nextRuntimeId: "zakura",
        hasUserMessage: true,
      }),
      "noop",
    );
    assert.equal(
      conversationRuntimeSwitch({
        currentRuntimeId: "zakura",
        nextRuntimeId: "codex",
        hasUserMessage: false,
      }),
      "rebind",
    );
    assert.equal(
      conversationRuntimeSwitch({
        currentRuntimeId: "codex",
        nextRuntimeId: "claude-code",
        hasUserMessage: true,
      }),
      "new_session",
    );
    assert.equal(parseAcpDefaultRuntime("Codex"), "codex");
    assert.equal(parseAcpAgentConfig({ acp: { defaultRuntime: "hermes" } }).defaultRuntime, "hermes");
  });
});
