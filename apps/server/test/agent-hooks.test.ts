/**
 * Agent hooks + plugin hooks.json 解析自检
 */
import assert from "node:assert/strict";
import {
  matcherHits,
  mergeHookPackages,
  parseHooksJson,
  parseAgentHookPackages,
} from "@zakura/shared";

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
assert.equal(matcherHits("shell_.*", "shell_exec"), true);
assert.equal(matcherHits("shell_.*", "web_search"), false);
assert.equal(matcherHits(undefined, "anything"), true);

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
