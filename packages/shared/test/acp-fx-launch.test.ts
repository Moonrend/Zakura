import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACP_IMAGE_BIN_DIR,
  lookupBuiltinAcpProfile,
  publicProfileForSetup,
  resolveAcpLaunch,
  type AcpAgentSetup,
} from "../src/acp.js";

// fx.sh installs fx to ACP_IMAGE_BIN_DIR and only adds that dir to PATH via
// ~/.bashrc, which ACP's empty HOME never sources. Launch must therefore
// resolve to the absolute path instead of a bare `fx` PATH lookup.
describe("resolveAcpLaunch fx absolute path", () => {
  const baseSetup = (overrides: Partial<AcpAgentSetup> = {}): AcpAgentSetup => ({
    id: "fx",
    enabled: true,
    setupMode: "api_key",
    modelProvider: "zakura",
    managed: { zakura_api_key: "vck_test" },
    ...overrides,
  });

  it("pins fx to ACP_IMAGE_BIN_DIR when command is unset", () => {
    const profile = publicProfileForSetup(baseSetup());
    const { command, args } = resolveAcpLaunch(profile, baseSetup());
    assert.equal(command, `${ACP_IMAGE_BIN_DIR}/fx`);
    assert.deepEqual(args, ["acp"]);
  });

  it("repins a legacy bare `fx` command to the absolute path", () => {
    const setup = baseSetup({ command: "fx", args: ["acp"] });
    const profile = publicProfileForSetup(setup);
    assert.equal(profile.command, "fx");
    const { command } = resolveAcpLaunch(profile, setup);
    assert.equal(command, `${ACP_IMAGE_BIN_DIR}/fx`);
  });

  it("leaves a user's explicit non-fx custom command untouched", () => {
    const profile = lookupBuiltinAcpProfile("opencode")!;
    const setup: AcpAgentSetup = {
      id: "opencode",
      enabled: true,
      setupMode: "api_key",
      modelProvider: "zakura",
      managed: { zakura_api_key: "k" },
      command: "opencode",
    };
    const { command } = resolveAcpLaunch(profile, setup);
    assert.equal(command, "opencode");
  });
});
