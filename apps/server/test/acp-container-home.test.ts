import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { acpRuntimeLayout } from "@zakura/shared";

const ADAPTER_HOME = "/opt/zakura/acp-home";

/**
 * Containerized ACP adapters keep credentials on a per (agent x adapter) Docker
 * volume mounted at ACP_ADAPTER_HOME. Before this contract existed the runtime
 * layout always rooted HOME under /tmp, which lives on the container's writable
 * layer: every interactive login was silently discarded when the adapter
 * container was torn down, and the credential volume stayed empty forever.
 */
describe("ACP containerized runtime layout", () => {
  it("roots the runtime tree on the credential volume when containerized", () => {
    const layout = acpRuntimeLayout("codex", "oauth", "rt1", ADAPTER_HOME);

    assert.ok(
      layout.runtimeDir.startsWith(ADAPTER_HOME),
      `runtimeDir must live on the persistent credential volume, got ${layout.runtimeDir}`,
    );
    assert.ok(
      !layout.runtimeDir.startsWith("/tmp"),
      "runtimeDir must not be on the container writable layer",
    );
  });

  it("points HOME at the credential volume so logins persist", () => {
    const layout = acpRuntimeLayout("codex", "oauth", "rt1", ADAPTER_HOME);
    const home = layout.env.HOME;

    assert.ok(home, "HOME must be set for the adapter process");
    assert.ok(
      home!.startsWith(ADAPTER_HOME),
      `HOME must resolve onto the credential volume, got ${home}`,
    );
  });

  it("keeps every XDG dir on the credential volume too", () => {
    const layout = acpRuntimeLayout("opencode", "oauth", "rt1", ADAPTER_HOME);
    for (const [key, value] of Object.entries(layout.env)) {
      if (!key.startsWith("XDG_")) continue;
      assert.ok(
        value.startsWith(ADAPTER_HOME),
        `${key} must live on the credential volume, got ${value}`,
      );
    }
  });

  it("still uses the tmp runtime for workspace-hosted adapters", () => {
    // Omitting the container home must preserve the legacy behaviour, so
    // non-containerized adapters keep their ephemeral, per-run sandbox.
    const layout = acpRuntimeLayout("codex", "oauth", "rt1");
    assert.ok(
      layout.runtimeDir.startsWith("/tmp/"),
      `workspace adapters keep the tmp runtime, got ${layout.runtimeDir}`,
    );
  });

  it("isolates adapters from each other on the same volume path", () => {
    const codex = acpRuntimeLayout("codex", "oauth", "rt1", ADAPTER_HOME);
    const opencode = acpRuntimeLayout("opencode", "oauth", "rt1", ADAPTER_HOME);
    assert.notEqual(codex.runtimeDir, opencode.runtimeDir);
  });

  it("is stable across runs so a login is found by the next session", () => {
    // The runtimeId changes every launch. If it leaked into the container path,
    // each session would get a fresh empty HOME and users would have to log in
    // again every time.
    const first = acpRuntimeLayout("codex", "oauth", "run-aaa", ADAPTER_HOME);
    const second = acpRuntimeLayout("codex", "oauth", "run-bbb", ADAPTER_HOME);
    assert.equal(
      first.env.HOME,
      second.env.HOME,
      "HOME must not depend on the per-run runtimeId",
    );
  });
});