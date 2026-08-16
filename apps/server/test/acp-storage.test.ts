import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  acpApiKeyDotenv,
  acpGeneratedRuntimeFiles,
  acpManualSetupBootScript,
  acpManualSetupEnvironment,
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
    assert.equal(hermes.env.HERMES_HOME, `${hermes.stateDir}/home`);
    assert.ok(hermes.env.HOME?.startsWith("/tmp/zakura-acp/"));
    const oc = acpRuntimeLayout("opencode", "self", "o1");
    assert.ok(oc.env.HOME?.startsWith("/tmp/zakura-acp/"));
    assert.ok(oc.env.XDG_CONFIG_HOME?.startsWith("/tmp/zakura-acp/"));
    const grok = acpRuntimeLayout("grok", "oauth", "g1");
    assert.equal(grok.env.HOME, `${grok.stateDir}/home`);
    assert.equal(grok.artifacts[0]?.durableRel, "home");
    assert.equal(acpManualSetupEnvironment("grok").HOME, "/workspace/data/acp/grok/home");
    assert.equal(acpManualSetupEnvironment("pi").HOME, "/workspace/data/acp/pi/home");
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

  it("writes Zakura route credentials into the Hermes .env", () => {
    const env = acpApiKeyDotenv("hermes", {
      zakura_api_key: "zak_route_key",
      zakura_base_url: "https://zakura.example/v1",
      model: "gpt-code",
    });
    assert.match(env ?? "", /LLM_PROVIDER=openai/);
    assert.match(env ?? "", /LLM_API_KEY=zak_route_key/);
    assert.match(env ?? "", /OPENAI_API_KEY=zak_route_key/);
    assert.match(env ?? "", /LLM_BASE_URL=https:\/\/zakura.example\/v1/);
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

describe("ACP generated runtime config files", () => {
  it("generates an OpenCode provider config for custom base URLs", () => {
    const layout = acpRuntimeLayout("opencode", "api_key", "oc1");
    const files = acpGeneratedRuntimeFiles({
      layout,
      keyMode: "api_key",
      routed: false,
      managed: {
        api_key: "sk-oc-key",
        base_url: "https://api.moonshot.cn/v1",
        model: "kimi-k2.5",
      },
    });
    assert.equal(files.length, 1);
    assert.equal(files[0]!.dest, `${layout.env.XDG_CONFIG_HOME}/opencode/opencode.json`);
    const config = JSON.parse(files[0]!.content) as {
      model: string;
      provider: Record<string, { npm: string; options: { apiKey: string; baseURL: string }; models: Record<string, unknown> }>;
    };
    assert.equal(config.model, "openai-compatible/kimi-k2.5");
    const provider = config.provider["openai-compatible"]!;
    assert.equal(provider.npm, "@ai-sdk/openai-compatible");
    assert.equal(provider.options.apiKey, "sk-oc-key");
    assert.equal(provider.options.baseURL, "https://api.moonshot.cn/v1");
    assert.ok(provider.models["kimi-k2.5"]);
  });

  it("uses the Anthropic SDK for sk-ant keys", () => {
    const layout = acpRuntimeLayout("opencode", "api_key", "oc2");
    const files = acpGeneratedRuntimeFiles({
      layout,
      keyMode: "api_key",
      routed: false,
      managed: {
        api_key: "sk-ant-zzz",
        base_url: "https://anthropic-proxy.test",
        model: "claude-sonnet-4-5",
      },
    });
    const config = JSON.parse(files[0]!.content) as {
      model: string;
      provider: Record<string, { npm: string }>;
    };
    assert.equal(config.provider["anthropic-compatible"]!.npm, "@ai-sdk/anthropic");
    assert.equal(config.model, "anthropic-compatible/claude-sonnet-4-5");
  });

  it("fills the Zakura route provider from gateway models", () => {
    const layout = acpRuntimeLayout("opencode", "api_key", "oc3");
    const files = acpGeneratedRuntimeFiles({
      layout,
      keyMode: "api_key",
      routed: true,
      managed: {
        zakura_api_key: "zk-key",
        zakura_base_url: "https://zakura.example/v1",
      },
      gatewayModels: ["gpt-5.2", "kimi-k2.5"],
    });
    const config = JSON.parse(files[0]!.content) as {
      model: string;
      provider: { zakura: { options: { apiKey: string; baseURL: string }; models: Record<string, unknown> } };
    };
    assert.equal(config.model, "zakura/gpt-5.2");
    assert.equal(config.provider.zakura.options.baseURL, "https://zakura.example/v1");
    assert.ok(config.provider.zakura.models["kimi-k2.5"]);
  });

  it("keeps builtin OpenCode defaults (model only) without a base URL", () => {
    const layout = acpRuntimeLayout("opencode", "api_key", "oc4");
    const files = acpGeneratedRuntimeFiles({
      layout,
      keyMode: "api_key",
      routed: false,
      managed: { api_key: "sk-plain", model: "gpt-5.2" },
    });
    const config = JSON.parse(files[0]!.content) as { model: string };
    assert.equal(config.model, "openai/gpt-5.2");
    assert.equal(
      acpGeneratedRuntimeFiles({
        layout,
        keyMode: "api_key",
        routed: false,
        managed: { api_key: "sk-plain" },
      }).length,
      0,
    );
  });

  it("never overwrites self/oauth logins", () => {
    for (const keyMode of ["oauth", "self"] as const) {
      const layout = acpRuntimeLayout("opencode", keyMode, "oc5");
      assert.equal(
        acpGeneratedRuntimeFiles({
          layout,
          keyMode,
          routed: false,
          managed: { api_key: "sk-x", base_url: "https://x", model: "m" },
        }).length,
        0,
      );
    }
  });

  it("generates Codex config.toml with a chat wire provider and auth.json", () => {
    const layout = acpRuntimeLayout("codex", "api_key", "cx1");
    const files = acpGeneratedRuntimeFiles({
      layout,
      keyMode: "api_key",
      routed: true,
      managed: {
        zakura_api_key: "zk-codex",
        zakura_base_url: "https://zakura.example/v1",
      },
      gatewayModels: ["gpt-5.2-codex", "gpt-5.2"],
    });
    assert.equal(files.length, 2);
    const toml = files[0]!;
    assert.equal(toml.dest, `${layout.env.CODEX_HOME}/config.toml`);
    assert.match(toml.content, /model = "gpt-5.2-codex"/);
    assert.match(toml.content, /model_provider = "zakura"/);
    assert.match(toml.content, /base_url = "https:\/\/zakura.example\/v1"/);
    // Codex ≥1.2 只接受 responses wire API（chat 已移除，config 加载即报错）。
    assert.match(toml.content, /wire_api = "responses"/);
    const auth = JSON.parse(files[1]!.content) as { OPENAI_API_KEY: string };
    assert.equal(auth.OPENAI_API_KEY, "zk-codex");
  });

  it("writes a model-only Codex config for plain OpenAI keys", () => {
    const layout = acpRuntimeLayout("codex", "api_key", "cx2");
    const files = acpGeneratedRuntimeFiles({
      layout,
      keyMode: "api_key",
      routed: false,
      managed: { api_key: "sk-openai", model: "gpt-5.2-codex" },
    });
    assert.equal(files.length, 2);
    assert.match(files[0]!.content, /model = "gpt-5.2-codex"/);
    assert.doesNotMatch(files[0]!.content, /model_provider/);
    assert.equal(
      acpGeneratedRuntimeFiles({
        layout,
        keyMode: "api_key",
        routed: false,
        managed: { api_key: "sk-openai" },
      }).length,
      0,
    );
  });

  it("exports shell quoting in manual setup boot scripts", () => {
    const boot = acpManualSetupBootScript("opencode");
    assert.ok(boot.commandLine.includes("opencode auth login"));
    assert.ok(boot.commandLine.includes("export HOME='/workspace/data/acp/opencode/home'"));
    assert.ok(
      boot.commandLine.includes(
        "export XDG_CONFIG_HOME='/workspace/data/acp/opencode/home/.config'",
      ),
    );
  });

  it("points manual codex/claude logins at the durable dirs the runtime stages", () => {
    // staging 读取 <durable>/.codex 与 <durable>/.claude；手动登录环境必须一致，
    // 否则登录成功 ACP 进程也看不到凭证。
    assert.equal(
      acpManualSetupEnvironment("codex").CODEX_HOME,
      "/workspace/data/acp/codex/.codex",
    );
    assert.equal(
      acpManualSetupEnvironment("claude-code").CLAUDE_CONFIG_DIR,
      "/workspace/data/acp/claude-code/.claude",
    );
    const codexLayout = acpRuntimeLayout("codex", "self", "cx9");
    assert.equal(codexLayout.artifacts[0]?.durableRel, ".codex/auth.json");
    const claudeLayout = acpRuntimeLayout("claude-code", "self", "cc9");
    assert.ok(claudeLayout.artifacts.some((a) => a.durableRel === ".claude/.credentials.json"));
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
