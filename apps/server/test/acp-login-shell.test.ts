import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RunnerClient } from "@zakura/core";
import { AgentWorkspaceService } from "../src/services/agent-workspace.js";

/**
 * Regression guard for the ACP adapter login shell.
 *
 * The adapter images ship an /etc/profile that hard-assigns
 *   PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
 * which drops /opt/zakura/acp/bin — the directory the adapter CLI is installed
 * into. Opening the login terminal with a *login* shell (`sh -lc`, `bash -l`)
 * therefore sourced that profile and dropped the user at a prompt where
 * `codex` / `opencode` / ... were "command not found", making interactive
 * login impossible. The shell must stay non-login (`-i`).
 */
const SOURCES = [
  "src/services/agent-workspace.ts",
];

function loginShellCommands(src: string): string[] {
  const text = readFileSync(new URL(src, import.meta.url).pathname, "utf8");
  // Grab the default shell command used by the adapter login-shell helpers.
  const matches = text.match(/exec \/bin\/bash [^"']*/g) ?? [];
  return matches;
}

describe("ACP adapter login shell", () => {
  it("forwards the non-login shell through the Go runner", async () => {
    let command: string[] = [];
    const client = new RunnerClient({ workspaceKind: "host", hub: {
      rpc: async <T>(method: string, params: unknown) => {
        if (method === "sys.info") return { docker: { ok: true } } as T;
        assert.equal(method, "host.exec.start");
        command = (params as { command: string[] }).command;
        return { id: "login", running: true, stdout: "", stderr: "", exitCode: null } as T;
      },
    } });
    const workspace = Object.create(AgentWorkspaceService.prototype) as AgentWorkspaceService;
    Object.assign(workspace, { requireRunnerClient: async () => ({ client }) });
    await workspace.startAcpAdapterLoginShell({ id: "agent" } as never, "fx", "session");
    assert.deepEqual(command, [
      "docker", "exec", "-i", "zakura-acpa-agent-fx-session",
      "/bin/sh", "-c", "exec /bin/bash -i || exec /bin/sh -i",
    ]);
  });

  for (const src of SOURCES) {
    it(`does not use a PATH-clobbering login shell in ${src}`, () => {
      const cmds = loginShellCommands(`../${src}`);
      assert.ok(cmds.length > 0, `expected a bash fallback command in ${src}`);
      for (const cmd of cmds) {
        assert.ok(
          !/\bbash -l\b/.test(cmd),
          `login shell would source /etc/profile and lose the adapter PATH: ${cmd}`,
        );
        assert.ok(
          /\bbash -i\b/.test(cmd),
          `expected an interactive (non-login) shell, got: ${cmd}`,
        );
      }
    });
  }

  it("keeps the adapter bin dir first on the exec PATH", () => {
    const text = readFileSync(
      new URL("../src/services/agent-workspace.ts", import.meta.url).pathname,
      "utf8",
    );
    const m = text.match(/WORKSPACE_EXEC_PATH\s*=\s*\n?\s*"([^"]+)"/);
    assert.ok(m, "WORKSPACE_EXEC_PATH must be defined");
    assert.ok(
      m![1]!.startsWith("/opt/zakura/acp/bin:"),
      `adapter bin dir must come first, got ${m![1]}`,
    );
  });
});
