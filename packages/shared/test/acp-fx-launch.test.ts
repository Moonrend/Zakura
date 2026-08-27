import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACP_IMAGE_BIN_DIR,
  acpCommandResolveExpr,
  acpStdioArgv,
  lookupBuiltinAcpProfile,
  publicProfileForSetup,
  resolveAcpLaunch,
  type AcpAgentSetup,
} from "../src/acp.js";

/**
 * ACP adapters are launched with HOME pointed at a throwaway state dir, so any
 * PATH an installer appended to `~/.bashrc` / `~/.profile` is never sourced.
 * `fx.sh` does exactly that, which is why a bare `exec fx` used to die with
 * "fx: not found" even though the binary shipped in the image.
 *
 * The launch therefore resolves bare command names against ACP_IMAGE_BIN_DIR
 * *before* falling back to PATH. This is done in the container (so it also covers
 * user-supplied commands that live elsewhere) rather than by special-casing a
 * profile id on the server.
 */
describe("ACP adapter command resolution", () => {
  const baseSetup = (overrides: Partial<AcpAgentSetup> = {}): AcpAgentSetup => ({
    id: "fx",
    enabled: true,
    setupMode: "api_key",
    modelProvider: "zakura",
    managed: { zakura_api_key: "vck_test" },
    ...overrides,
  });

  it("keeps the profile's command as authored", () => {
    const profile = publicProfileForSetup(baseSetup());
    const { command, args } = resolveAcpLaunch(profile, baseSetup());
    assert.equal(command, "fx");
    assert.deepEqual(args, ["acp"]);
  });

  it("prefers the ACP bin dir over PATH for a bare name", () => {
    const expr = acpCommandResolveExpr("fx");
    assert.ok(
      expr.includes(`${ACP_IMAGE_BIN_DIR}/fx`),
      "must probe the install dir before PATH",
    );
    // The install-dir test has to come before the PATH lookup.
    assert.ok(
      expr.indexOf(`${ACP_IMAGE_BIN_DIR}/fx`) < expr.indexOf("command -v"),
      "install dir must be checked first",
    );
    assert.ok(expr.includes("command -v 'fx'"), "must still fall back to PATH");
    assert.ok(expr.includes("ZAKURA_BIN_MISSING:fx"), "must fail loudly when absent");
    assert.ok(expr.includes("exit 127"));
  });

  it("execs the resolved absolute path, not the bare name", () => {
    const argv = acpStdioArgv("fx", ["acp"]);
    assert.deepEqual(argv.slice(0, 2), ["/bin/bash", "-lc"]);
    const script = argv[2]!;
    assert.ok(script.includes(`${ACP_IMAGE_BIN_DIR}/fx`));
    assert.ok(
      script.includes(`exec "$ZAKURA_ACP_BIN" 'acp'`),
      `should exec the resolved binary, got: ${script}`,
    );
    // A bare `exec fx` is precisely the bug this guards against.
    assert.ok(!/exec 'fx'/.test(script));
  });

  it("passes an absolute command through without a PATH lookup", () => {
    const expr = acpCommandResolveExpr("/usr/local/bin/my-agent");
    assert.ok(expr.includes("/usr/local/bin/my-agent"));
    assert.ok(!expr.includes(ACP_IMAGE_BIN_DIR));
  });

  it("still honours a user's explicit custom command", () => {
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
    // and it must be resolvable from PATH when it is not one of ours
    assert.ok(acpCommandResolveExpr(command).includes("command -v 'opencode'"));
  });

  it("quotes commands containing shell metacharacters", () => {
    const script = acpStdioArgv("weird'name", ["--x"])[2]!;
    assert.ok(!script.includes("weird'name;"), "must not break out of quoting");
    assert.ok(script.includes(`'\\''`), "single quote must be escaped");
  });
});
