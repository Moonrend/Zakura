/**
 * Agent hooks + plugin hooks.json 解析 / 运行时输出自检
 */
import assert from "node:assert/strict";
import {
  matcherHits,
  mergeHookPackages,
  parseHooksJson,
  parseAgentHookPackages,
  hookStdinToolName,
  hookIfHits,
  isGitCommitCommand,
} from "@zakura/shared";
import {
  collectInjectText,
  firstDeny,
  hookStdinPayload,
  parseHookCommandOutput,
} from "../src/services/agent-hooks.js";

const hooks = parseHooksJson({
  hooks: {
    PreToolUse: [
      {
        matcher: "shell_.*|Bash",
        hooks: [{ type: "command", command: "echo deny-check" }],
      },
    ],
    SessionStart: [
      {
        hooks: [{ type: "prompt", prompt: "Always prefer Chinese replies." }],
      },
    ],
  },
});

assert.ok(hooks.PreToolUse?.length === 1);
assert.ok(hooks.SessionStart?.length === 1);

const flat = parseHooksJson({
  hooks: {
    sessionStart: [{ type: "prompt", prompt: "Prefer the project README." }],
    PreToolUse: [{ type: "command", command: "echo pre", timeout: 5, matcher: "Bash" }],
  },
});
assert.equal(flat.SessionStart?.[0]?.hooks[0]?.prompt, "Prefer the project README.");
assert.equal(flat.PreToolUse?.[0]?.hooks[0]?.command, "echo pre");
assert.equal(flat.PreToolUse?.[0]?.hooks[0]?.timeoutMs, 5000);
assert.equal(flat.PreToolUse?.[0]?.matcher, "Bash");

assert.equal(matcherHits("shell_.*", "shell_exec"), true);
assert.equal(matcherHits("shell_.*", "web_search"), false);
assert.equal(matcherHits(undefined, "anything"), true);
assert.equal(matcherHits("Bash", "re_shell_exec"), true);
assert.equal(matcherHits("Write|Edit", "re_fs_write"), true);
assert.equal(matcherHits("Write|Edit", "re_fs_read"), false);
assert.equal(hookStdinToolName("re_shell_exec"), "Bash");
assert.equal(hookStdinToolName("re_fs_grep"), "Grep");
assert.equal(hookIfHits("Bash(git commit*)", "re_shell_exec", { command: "git commit -m x" }), true);
assert.equal(hookIfHits("Bash(git commit*)", "re_shell_exec", { command: "git status" }), false);
assert.equal(isGitCommitCommand("re_shell_exec", { command: "git commit -am 'x'" }), true);
assert.equal(isGitCommitCommand("re_shell_exec", { command: "git push" }), false);

const lifecycle = parseHooksJson({
  hooks: {
    PreCommit: [{ hooks: [{ type: "command", command: "pre-commit run" }] }],
    Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
    PreCompact: [{ matcher: "auto", hooks: [{ type: "prompt", prompt: "save notes" }] }],
  },
});
assert.ok(lifecycle.PreCommit?.length === 1);
assert.ok(lifecycle.Stop?.length === 1);
assert.ok(lifecycle.PreCompact?.length === 1);

const stopBlock = parseHookCommandOutput("Stop", JSON.stringify({ decision: "block", reason: "lint failed" }), "", 0);
assert.equal(stopBlock.deny, true);
assert.equal(stopBlock.reason, "lint failed");
const commitExit2 = parseHookCommandOutput("PreCommit", "", "hook failed", 2);
assert.equal(commitExit2.deny, true);

const nested = parseHookCommandOutput(
  "PreToolUse",
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "no rm",
      additionalContext: "blocked rm",
    },
  }),
  "",
  0,
);
assert.equal(nested.deny, true);
assert.equal(nested.reason, "no rm");
assert.equal(nested.injectText, "blocked rm");

const exit2 = parseHookCommandOutput("PreToolUse", "", "Blocked: rm", 2);
assert.equal(exit2.deny, true);
assert.equal(exit2.reason, "Blocked: rm");
assert.ok(firstDeny([exit2]));

const sessionOut = parseHookCommandOutput("SessionStart", "branch: main", "", 0);
assert.equal(sessionOut.injectText, "branch: main");
assert.equal(collectInjectText([sessionOut]), "branch: main");

const stdin = hookStdinPayload("PreToolUse", {
  toolName: "re_shell_exec",
  toolArgs: { command: "ls" },
  workingDir: "/workspace/projects/demo",
});
const payload = JSON.parse(stdin) as { tool_name: string; tool_input: { command: string } };
assert.equal(payload.tool_name, "Bash");
assert.equal(payload.tool_input.command, "ls");

const merged = mergeHookPackages(
  [],
  {
    id: "plugin:demo",
    name: "demo",
    source: "mcp:custom:1:demo",
    enabled: true,
    events: hooks,
  },
);
assert.equal(merged.length, 1);
const again = mergeHookPackages(merged, {
  id: "plugin:demo",
  name: "demo-v2",
  source: "mcp:custom:1:demo",
  enabled: true,
  events: hooks,
});
assert.equal(again.length, 1);
assert.equal(again[0]!.name, "demo-v2");

const packages = parseAgentHookPackages([
  { id: "x", name: "x", source: "manual", enabled: true, events: hooks },
  { bad: true },
]);
assert.equal(packages.length, 1);

console.log("agent-hooks self-check ok");
