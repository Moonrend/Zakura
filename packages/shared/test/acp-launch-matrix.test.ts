import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACP_BUILTIN_PROFILE_IDS,
  builtinAcpProfiles,
  lookupBuiltinAcpProfile,
  publicProfileForSetup,
  resolveAcpLaunch,
  type AcpAgentSetup,
} from "../src/acp.js";
import { acpAdapterSource, acpRegistryIdForProfile } from "../src/acp-sources.js";

/**
 * Black-box coverage for "the user clicks an agent and it starts".
 *
 * Until now only fx had a launch test (acp-fx-launch.test.ts), so the other 27
 * builtin profiles could ship a typo'd command, an empty args array or a
 * missing adapter source and nothing would catch it before a user clicked the
 * agent and got a runtime error.
 *
 * These tests walk every id in ACP_BUILTIN_PROFILE_IDS and assert the whole
 * chain a click depends on: the profile resolves, it declares a launchable
 * command, and it maps to an install source that can actually provision it.
 */
describe("every builtin ACP profile is launchable", () => {
  const setupFor = (id: string, overrides: Partial<AcpAgentSetup> = {}): AcpAgentSetup => ({
    id,
    enabled: true,
    setupMode: "api_key",
    modelProvider: "zakura",
    managed: { zakura_api_key: "vck_test" },
    ...overrides,
  });

  it("exposes a profile for every advertised id", () => {
    for (const id of ACP_BUILTIN_PROFILE_IDS) {
      const profile = lookupBuiltinAcpProfile(id);
      assert.ok(profile, `no builtin profile for advertised id "${id}"`);
      assert.equal(profile.id, id);
    }
  });

  it("resolves a non-empty launch command for every profile", () => {
    for (const id of ACP_BUILTIN_PROFILE_IDS) {
      const setup = setupFor(id);
      const profile = publicProfileForSetup(setup);
      const { command, args } = resolveAcpLaunch(profile, setup);
      assert.ok(
        typeof command === "string" && command.trim().length > 0,
        `profile "${id}" resolves to an empty command`,
      );
      assert.equal(
        command,
        command.trim(),
        `profile "${id}" command has stray whitespace: ${JSON.stringify(command)}`,
      );
      assert.ok(Array.isArray(args), `profile "${id}" args is not an array`);
      for (const arg of args) {
        assert.equal(
          typeof arg,
          "string",
          `profile "${id}" has a non-string arg: ${JSON.stringify(arg)}`,
        );
      }
    }
  });

  it("maps every profile to a usable adapter source", () => {
    for (const id of ACP_BUILTIN_PROFILE_IDS) {
      const source = acpAdapterSource(id);
      assert.ok(source, `profile "${id}" has no adapter source`);
      // `image` is the fallback for user-defined profiles that carry their own
      // command. A builtin landing there means nothing can provision it, so the
      // agent would fail the moment someone clicks it.
      assert.notEqual(
        source.kind,
        "image",
        `builtin profile "${id}" fell through to the "image" source and cannot be installed`,
      );
      if (source.kind === "registry") {
        // A registry-backed profile that cannot name its registry entry can
        // never be installed, which is exactly the dead-end the install button
        // used to hit.
        assert.ok(
          acpRegistryIdForProfile(id),
          `profile "${id}" claims the registry source but maps to no registry id`,
        );
      } else if (source.kind === "custom") {
        assert.ok(
          source.install.trim().length > 0,
          `custom profile "${id}" has an empty install script`,
        );
        assert.ok(
          source.bin.trim().length > 0,
          `custom profile "${id}" declares no binary name`,
        );
      }
    }
  });

  it("keeps ids unique and in sync with the profile list", () => {
    const ids = builtinAcpProfiles().map((p) => p.id);
    assert.equal(
      new Set(ids).size,
      ids.length,
      `duplicate builtin profile ids: ${ids.join(", ")}`,
    );
    assert.deepEqual(
      [...ids].sort(),
      [...ACP_BUILTIN_PROFILE_IDS].sort(),
      "builtinAcpProfiles() and ACP_BUILTIN_PROFILE_IDS disagree",
    );
  });

  it("marks every builtin as managed so its command stays read-only", () => {
    for (const profile of builtinAcpProfiles()) {
      assert.equal(
        profile.managed,
        true,
        `builtin profile "${profile.id}" is not managed`,
      );
    }
  });
});