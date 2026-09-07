import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  acpAdapterLoginBootScript,
  acpManualSetupBootScript,
  acpManualSetupCommand,
  acpAgents,
} from "../src/index.js";

/**
 * A terminal login only works if it runs where the CLI and the credential
 * volume actually are. Two distinct boot scripts exist for the two possible
 * destinations, and mixing them up silently sends credentials into a directory
 * nobody reads -- the failure mode that made every containerized login vanish.
 */

test("the adapter login script never overrides HOME", () => {
  // Inside the adapter container HOME is already the credential volume. An
  // `export HOME=...` here would redirect the login to the workspace layout,
  // which the adapter process never reads from.
  for (const agent of acpAgents()) {
    const boot = acpAdapterLoginBootScript(agent.id);
    assert.ok(
      !/\bexport\s+HOME=/.test(boot.commandLine),
      `${agent.id}: adapter login must inherit the container HOME, got: ${boot.commandLine}`,
    );
    assert.ok(
      !/\bexport\s+XDG_/.test(boot.commandLine),
      `${agent.id}: adapter login must not override XDG dirs, got: ${boot.commandLine}`,
    );
  }
});

test("the workspace boot script still exports a HOME", () => {
  // The workspace shell has no ACP environment of its own, so the export is
  // required there. This guards the two scripts from being collapsed into one.
  const boot = acpManualSetupBootScript("codex");
  assert.match(boot.commandLine, /\bexport\s+HOME=/);
});

test("both scripts run the same login command", () => {
  // Routing must not change *what* the user is asked to run, only where.
  for (const id of ["codex", "hermes", "fx", "kiro"]) {
    const setup = acpManualSetupCommand(id);
    const adapter = acpAdapterLoginBootScript(id);
    const joined = setup.command.join(" ");
    assert.ok(
      adapter.commandLine.includes(joined),
      `${id}: expected the login command ${joined} in: ${adapter.commandLine}`,
    );
    assert.equal(adapter.initialInput, setup.initialInput);
    assert.equal(adapter.display, setup.display);
  }
});

test("the adapter script clears the screen before prompting", () => {
  // The exec lands in a shell that may carry adapter startup noise.
  const boot = acpAdapterLoginBootScript("codex");
  assert.match(boot.commandLine, /^clear;/);
});