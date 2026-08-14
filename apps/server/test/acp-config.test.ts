import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  acpStdioArgv,
  acpManualSetupCommand,
  builtinAcpProfiles,
  isMaskedAcpSecret,
  maskAcpSecret,
  mergeAcpConfigUpdate,
  missingRequiredAcpField,
  grantMatches,
  isPathUnderRoots,
  parseAcpAgentConfig,
  pathPrefixFromLocations,
  pickGrantedOptionId,
  publicProfileForSetup,
  resolveAcpLaunch,
  parseAcpConfigOptions,
  parseAcpSessionModelState,
  ACP_UNSTABLE_MODEL_CONFIG_ID,
  scrubAcpConfigForResponse,
  upsertAcpGrant,
} from "@zakura/shared";

describe("ACP config", () => {
  it("maps verified interactive setup commands", () => {
    assert.deepEqual(acpManualSetupCommand("copilot"), {
      command: ["copilot"],
      initialInput: "/login\n",
      display: "copilot → /login",
    });
    assert.equal(acpManualSetupCommand("kimi-code").display, "kimi → /login");
    assert.equal(acpManualSetupCommand("opencode").display, "opencode auth login");
    assert.equal(acpManualSetupCommand("pi").display, "pi-acp --terminal-login");
    assert.equal(acpManualSetupCommand("grok").display, "grok");
  });

  it("parses enabled builtin setup and requires api key unless self", () => {
    const config = parseAcpAgentConfig({
      acp: {
        permissionPolicy: "ask",
        agents: {
          "claude-code": {
            enabled: true,
            setupMode: "api_key",
            managed: { api_key: "sk-ant-secret" },
          },
        },
      },
    });
    assert.equal(config.agents["claude-code"]?.enabled, true);
    const profile = publicProfileForSetup(config.agents["claude-code"]!);
    assert.equal(missingRequiredAcpField(profile, config.agents["claude-code"]!), null);
    const self = { ...config.agents["claude-code"]!, setupMode: "self" as const, managed: {} };
    assert.equal(missingRequiredAcpField(profile, self), null);
    const empty = { ...config.agents["claude-code"]!, managed: {} };
    assert.equal(missingRequiredAcpField(profile, empty)?.id, "api_key");
    const oauthEmpty = { ...config.agents["claude-code"]!, setupMode: "oauth" as const, managed: {} };
    assert.equal(missingRequiredAcpField(profile, oauthEmpty)?.id, "oauth_token");
    const oauthOk = {
      ...config.agents["claude-code"]!,
      setupMode: "oauth" as const,
      managed: { oauth_token: "sk-ant-oat-x" },
    };
    assert.equal(missingRequiredAcpField(profile, oauthOk), null);
    assert.equal(config.defaultRuntime, "zakura");
  });

  it("masks secrets on read and keeps previous value on masked write-back", () => {
    const existing = parseAcpAgentConfig({
      acp: {
        agents: {
          codex: {
            enabled: true,
            setupMode: "api_key",
            managed: { api_key: "sk-live-key-1234" },
          },
        },
      },
    });
    const scrubbed = scrubAcpConfigForResponse(existing);
    const shown = scrubbed.agents.codex!.managed.api_key;
    assert.ok(isMaskedAcpSecret(shown) || shown.includes("…"));
    assert.notEqual(shown, "sk-live-key-1234");

    const incoming = parseAcpAgentConfig({
      acp: {
        agents: {
          codex: {
            enabled: true,
            setupMode: "api_key",
            managed: { api_key: maskAcpSecret("sk-live-key-1234") },
          },
        },
      },
    });
    const merged = mergeAcpConfigUpdate(existing, incoming);
    assert.equal(merged.agents.codex!.managed.api_key, "sk-live-key-1234");
  });

  it("maps launch env for builtin profiles", () => {
    const claude = builtinAcpProfiles().find((p) => p.id === "claude-code")!;
    const launch = resolveAcpLaunch(claude, {
      id: "claude-code",
      enabled: true,
      setupMode: "api_key",
      managed: { api_key: "sk-ant-x", base_url: "https://example.test" },
    });
    assert.equal(launch.command, "claude-agent-acp");
    assert.equal(launch.env.ANTHROPIC_API_KEY, "sk-ant-x");
    assert.equal(launch.env.ANTHROPIC_BASE_URL, "https://example.test");
    assert.equal(claude.sessionModeId, "default");
    const oauthLaunch = resolveAcpLaunch(claude, {
      id: "claude-code",
      enabled: true,
      setupMode: "oauth",
      managed: { oauth_token: "sk-ant-oat-secret" },
    });
    assert.equal(oauthLaunch.env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat-secret");
    const ids = builtinAcpProfiles().map((p) => p.id);
    assert.deepEqual(ids, [
      "claude-code",
      "codex",
      "gemini-cli",
      "hermes",
      "grok",
      "copilot",
      "kimi-code",
      "pi",
      "opencode",
    ]);
    const gemini = builtinAcpProfiles().find((p) => p.id === "gemini-cli")!;
    assert.deepEqual(gemini.args, ["--acp"]);
    const geminiLaunch = resolveAcpLaunch(gemini, {
      id: "gemini-cli",
      enabled: true,
      setupMode: "api_key",
      managed: { api_key: "AIza-x", model: "gemini-2.5-pro" },
    });
    assert.equal(geminiLaunch.env.GEMINI_API_KEY, "AIza-x");
    assert.equal(geminiLaunch.env.GOOGLE_API_KEY, "AIza-x");
    assert.equal(geminiLaunch.env.GEMINI_MODEL, "gemini-2.5-pro");
    const hermes = builtinAcpProfiles().find((p) => p.id === "hermes")!;
    const hermesLaunch = resolveAcpLaunch(hermes, {
      id: "hermes",
      enabled: true,
      setupMode: "api_key",
      managed: { provider: "openai", model: "gpt-4.1", api_key: "sk-h", base_url: "https://x" },
    });
    assert.equal(hermesLaunch.command, "hermes-acp");
    assert.equal(hermesLaunch.env.LLM_API_KEY, "sk-h");
    const oc = builtinAcpProfiles().find((p) => p.id === "opencode")!;
    assert.deepEqual(oc.args, ["acp"]);
    const kimi = builtinAcpProfiles().find((p) => p.id === "kimi-code")!;
    assert.deepEqual(kimi.args, ["acp"]);
    const copilot = builtinAcpProfiles().find((p) => p.id === "copilot")!;
    assert.deepEqual(copilot.args, ["--acp"]);
    assert.ok(copilot.setupModes.includes("oauth"));
    const routed = resolveAcpLaunch(oc, {
      id: "opencode",
      enabled: true,
      setupMode: "self",
      modelProvider: "zakura",
      managed: {
        zakura_api_key: "zk-agent-key",
        zakura_base_url: "https://zakura.example/v1",
        model: "gpt-code",
      },
    });
    assert.equal(routed.env.OPENAI_API_KEY, "zk-agent-key");
    assert.equal(routed.env.OPENAI_BASE_URL, "https://zakura.example/v1");
    assert.equal(routed.env.OPENAI_MODEL, "gpt-code");
    for (const profile of builtinAcpProfiles()) {
      assert.equal(profile.installHint, undefined, `${profile.id} must stay image-pinned`);
    }
    assert.deepEqual(acpStdioArgv("codex-acp", []), ["/bin/bash", "-lc", "exec 'codex-acp'"]);
    assert.deepEqual(acpStdioArgv("gemini", ["--acp"]), [
      "/bin/bash",
      "-lc",
      "exec 'gemini' '--acp'",
    ]);
  });

  it("accepts custom command profiles", () => {
    const config = parseAcpAgentConfig({
      acp: {
        agents: {
          "my-cli": {
            enabled: true,
            setupMode: "self",
            displayName: "My CLI",
            command: "my-cli",
            args: ["acp"],
          },
        },
      },
    });
    const profile = publicProfileForSetup(config.agents["my-cli"]!);
    assert.equal(profile.builtin, false);
    assert.equal(profile.command, "my-cli");
    assert.deepEqual(profile.args, ["acp"]);
  });

  it("parses always-allow grants and matches by kind + path prefix", () => {
    const config = parseAcpAgentConfig({
      acp: {
        permissionGrants: [
          { kind: "edit", pathPrefix: "/workspace/projects/app/" },
          { kind: "execute" },
        ],
      },
    });
    assert.equal(config.permissionGrants.length, 2);
    assert.equal(
      grantMatches(config.permissionGrants[0]!, {
        kind: "edit",
        locations: [{ path: "/workspace/projects/app/src/a.ts" }],
      }),
      true,
    );
    assert.equal(
      grantMatches(config.permissionGrants[0]!, {
        kind: "edit",
        locations: [{ path: "/workspace/other/a.ts" }],
      }),
      false,
    );
    assert.equal(
      grantMatches(config.permissionGrants[0]!, { kind: "execute", locations: [] }),
      false,
    );
    assert.equal(
      pickGrantedOptionId(
        config.permissionGrants,
        { kind: "execute" },
        [
          { optionId: "once", kind: "allow_once" },
          { optionId: "always", kind: "allow_always" },
        ],
      ),
      "always",
    );
    assert.equal(
      pickGrantedOptionId(config.permissionGrants, { kind: "fetch" }, [
        { optionId: "once", kind: "allow_once" },
      ]),
      undefined,
    );
    const next = upsertAcpGrant(config.permissionGrants, {
      kind: "edit",
      pathPrefix: "/workspace/projects/app/",
    });
    assert.equal(next.length, 2);
    assert.equal(isPathUnderRoots("/workspace/projects/app/a.ts", ["/workspace"]), true);
    assert.equal(isPathUnderRoots("/tmp/secret", ["/workspace"]), false);
    assert.equal(
      pathPrefixFromLocations([{ path: "/workspace/projects/app/src/a.ts" }]),
      "/workspace/projects/app/src/",
    );
  });

  it("parses ACP model and thought config options", () => {
    const parsed = parseAcpConfigOptions([
      {
        type: "select",
        id: "model",
        category: "model",
        currentValue: "gemini-2.5-pro",
        options: [
          { value: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
          { group: "flash", name: "Flash", options: [{ value: "gemini-2.5-flash", name: "Flash" }] },
        ],
      },
      {
        type: "select",
        id: "thought_level",
        category: "thought_level",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
    ]);
    assert.equal(parsed.models?.configId, "model");
    assert.equal(parsed.models?.currentId, "gemini-2.5-pro");
    assert.equal(parsed.models?.available.length, 2);
    assert.equal(parsed.reasoning?.configId, "thought_level");
    assert.equal(parsed.reasoning?.current, "high");
  });

  it("parses Gemini session/new models.availableModels", () => {
    const parsed = parseAcpSessionModelState({
      sessionId: "s1",
      models: {
        currentModelId: "gemini-2.5-pro",
        availableModels: [
          { modelId: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
          { modelId: "gemini-2.5-flash", title: "Flash" },
        ],
      },
    });
    assert.equal(parsed.models?.configId, ACP_UNSTABLE_MODEL_CONFIG_ID);
    assert.equal(parsed.models?.currentId, "gemini-2.5-pro");
    assert.equal(parsed.models?.available.length, 2);
    assert.equal(parsed.models?.available[1]?.name, "Flash");
  });
});
