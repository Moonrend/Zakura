/**
 * The point of the registry split is that Zakura holds no per-agent knowledge.
 * These tests pin that contract: layouts and sources must follow declarations,
 * and a brand-new agent must work without any code change here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { builtinAcpProfiles } from "../src/acp.js";
import {
  acpAdapterSource,
  acpAgentByProfile,
  acpAgents,
  acpEnabledAgents,
  acpRegistryIdForProfile,
  applyAcpRegistryIndex,
  resetAcpRegistry,
  acpRuntimeLayout,
  acpSnapshotVersion,
} from "../src/index.js";

test("registry snapshot ships with the expected shape", () => {
  const agents = acpAgents();
  assert.ok(agents.length >= 39, `expected >= 39 agents, got ${agents.length}`);
  for (const a of agents) {
    assert.match(a.id, /^[a-z0-9][a-z0-9-]*$/, `bad id: ${a.id}`);
    assert.ok(a.profileId, `${a.id} missing profileId`);
    assert.match(a.image, /^ghcr\.io\/moonrend\/acp-registry\//, `${a.id} bad image`);
    assert.ok(["home", "state-home", "files", "none"].includes(a.storage.mode));
  }
});

test("profile ids are unique across the registry", () => {
  const seen = new Set<string>();
  for (const a of acpAgents()) {
    assert.ok(!seen.has(a.profileId), `duplicate profileId: ${a.profileId}`);
    seen.add(a.profileId);
  }
});

test("enabled agents resolve to a container image", () => {
  const enabled = acpEnabledAgents();
  assert.ok(enabled.length > 0, "expected at least one enabled agent");
  for (const a of enabled) {
    const source = acpAdapterSource(a.profileId);
    assert.equal(source.kind, "container", `${a.id} should be containerized`);
    if (source.kind === "container") assert.equal(source.image, a.image);
  }
});

test("disabled agents fall back to on-demand provisioning", () => {
  const disabled = acpAgents().find((a) => !a.enabled);
  assert.ok(disabled, "expected a disabled agent in the registry");
  const source = acpAdapterSource(disabled.profileId);
  assert.equal(source.kind, "registry");
  if (source.kind === "registry") assert.equal(source.registryId, disabled.id);
});

test("gemini keeps its distinct profile id and registry id", () => {
  // These two differ, and getting it wrong silently breaks adapter resolution.
  assert.equal(acpRegistryIdForProfile("gemini-cli"), "gemini");
  assert.equal(acpAgentByProfile("gemini")?.profileId, undefined);
});

test("unknown profiles degrade to a bare image source", () => {
  assert.equal(acpAdapterSource("no-such-profile-xyz").kind, "image");
});

test("layout follows the declaration, including mode filters", () => {
  const layout = acpRuntimeLayout("codex", "api_key", "rt1");
  const configToml = layout.artifacts.find((a) => a.durableRel.endsWith("config.toml"));
  // Declared with sync "none" under api_key: present, but never written back.
  assert.ok(configToml, "expected config.toml artifact");
  assert.equal(configToml.sync, "none");

  const self = acpRuntimeLayout("codex", "self", "rt1");
  const selfToml = self.artifacts.find((a) => a.durableRel.endsWith("config.toml"));
  assert.equal(selfToml?.sync, "exit");
});

test("oauth injects declared no-browser env, other modes do not", () => {
  const oauth = acpRuntimeLayout("codex", "oauth", "rt1");
  assert.equal(oauth.env.NO_BROWSER, "1");
  assert.equal(acpRuntimeLayout("codex", "self", "rt1").env.NO_BROWSER, undefined);
});

test("state-home layouts point XDG vars at the persisted home", () => {
  const layout = acpRuntimeLayout("opencode", "self", "rt1");
  assert.equal(layout.env.HOME, `${layout.stateDir}/home`);
  assert.equal(layout.env.XDG_CONFIG_HOME, `${layout.stateDir}/home/.config`);
  assert.equal(layout.env.XDG_DATA_HOME, `${layout.stateDir}/home/.local/share`);
});

test("a new agent works with no code change here", () => {
  const index = {
    schemaVersion: 1,
    imagePrefix: "ghcr.io/moonrend/acp-registry",
    digest: "test",
    agents: [
      {
        id: "brand-new-agent",
        name: "Brand New",
        version: "1.0.0",
        enabled: true,
        profileId: "brand-new",
        image: "ghcr.io/moonrend/acp-registry/brand-new-agent:1.0.0",
        dist: { kind: "npx" as const },
        storage: {
          mode: "files" as const,
          env: { HOME: "${RUNTIME_DIR}", NEW_HOME: "${STATE_DIR}" },
          artifacts: [{ durable: "creds.json", runtime: "creds.json", sync: "exit" as const }],
        },
        auth: { modes: ["self" as const] },
      },
    ],
  };
  try {
    const applied = applyAcpRegistryIndex(index);
    assert.equal(applied.ok, true);

    const source = acpAdapterSource("brand-new");
    assert.equal(source.kind, "container");

    const layout = acpRuntimeLayout("brand-new", "self", "rt1");
    assert.equal(layout.env.NEW_HOME, layout.stateDir);
    assert.equal(layout.artifacts.length, 1);
    assert.equal(layout.artifacts[0]?.durableRel, "creds.json");
    assert.equal(layout.artifacts[0]?.runtimeRel, "creds.json");
  } finally {
    resetAcpRegistry();
  }
});

test("a malformed index is rejected and leaves the active one intact", () => {
  const before = acpAgents().length;
  for (const bad of [null, {}, { schemaVersion: 999, agents: [] }, { schemaVersion: 1, agents: [] }]) {
    const res = applyAcpRegistryIndex(bad);
    assert.equal(res.ok, false, `should reject: ${JSON.stringify(bad)}`);
  }
  assert.equal(acpAgents().length, before, "active index must survive bad input");
});

test("refreshing from the live index keeps container adapters enabled", (t) => {
  // The published dist/index.json carries no `enabled` field. Applying it
  // verbatim would empty acpEnabledAgents(), which does not merely hide rows:
  // acpAdapterSource() would demote every container adapter to workspace
  // provisioning and change how sessions actually run.
  t.after(() => resetAcpRegistry());
  const before = acpEnabledAgents().map((a) => a.id).sort();
  assert.ok(before.length > 0, "precondition: snapshot has enabled agents");

  const live = {
    schemaVersion: 1,
    imagePrefix: "ghcr.io/moonrend/acp-registry",
    digest: "live000000000000",
    agents: acpAgents().map(({ enabled: _enabled, ...rest }) => rest),
  };
  assert.ok(applyAcpRegistryIndex(live).ok, "live-shaped index must be accepted");

  assert.deepEqual(acpEnabledAgents().map((a) => a.id).sort(), before);
  for (const id of before) {
    const source = acpAdapterSource(acpAgents().find((a) => a.id === id)!.profileId);
    assert.equal(source.kind, "container", `${id} must stay a container adapter`);
  }
});

test("a published version bump reads as an available update", (t) => {
  // Container adapters launch the tag in `image`, so "installed" is the version
  // this build shipped with and an update is a newer tag we have not adopted.
  t.after(() => resetAcpRegistry());
  const target = acpEnabledAgents()[0];
  assert.equal(acpSnapshotVersion(target.id), target.version, "no update before refresh");

  applyAcpRegistryIndex({
    schemaVersion: 1,
    imagePrefix: "ghcr.io/moonrend/acp-registry",
    digest: "bumped0000000000",
    agents: acpAgents().map(({ enabled: _enabled, ...rest }) =>
      rest.id === target.id ? { ...rest, version: "99.0.0" } : rest,
    ),
  });

  const after = acpEnabledAgents().find((a) => a.id === target.id)!;
  assert.equal(after.version, "99.0.0", "active index must carry the new version");
  assert.equal(acpSnapshotVersion(target.id), target.version, "shipped version is immutable");
  assert.notEqual(acpSnapshotVersion(target.id), after.version, "difference drives updateAvailable");
});

test("an agent the registry explicitly disables is honoured", (t) => {
  t.after(() => resetAcpRegistry());
  const target = acpEnabledAgents()[0];
  applyAcpRegistryIndex({
    schemaVersion: 1,
    imagePrefix: "ghcr.io/moonrend/acp-registry",
    digest: "disabled00000000",
    agents: acpAgents().map((a) => (a.id === target.id ? { ...a, enabled: false } : a)),
  });
  assert.ok(!acpEnabledAgents().some((a) => a.id === target.id), "explicit false must win");
});

test("registry auth modes agree with the builtin profiles", () => {
  // The UI renders setup flows from the profile while the adapter reads them
  // from the registry; drift between the two silently breaks login.
  const mismatches: string[] = [];
  for (const profile of builtinAcpProfiles()) {
    const agent = acpAgentByProfile(profile.id);
    if (!agent) continue;
    const fromProfile = [...profile.setupModes].sort().join(",");
    const fromRegistry = [...agent.auth.modes].sort().join(",");
    if (fromProfile !== fromRegistry) {
      mismatches.push(`${profile.id}: profile=[${fromProfile}] registry=[${fromRegistry}]`);
    }
  }
  assert.deepEqual(mismatches, [], `setup mode drift:\n  ${mismatches.join("\n  ")}`);
});
