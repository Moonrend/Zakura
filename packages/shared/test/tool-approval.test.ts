import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvalRuleHits,
  parseToolApprovalConfig,
  resolveApprovalPolicy,
  resolveAskTimeoutSeconds,
  resolveConfidenceThreshold,
} from "../src/tool-approval.js";

test("parseToolApprovalConfig 未配置时为空对象", () => {
  assert.deepEqual(parseToolApprovalConfig(null), {});
  assert.deepEqual(parseToolApprovalConfig("x"), {});
  assert.deepEqual(parseToolApprovalConfig([]), {});
});

test("parseToolApprovalConfig 解析合法字段并丢弃非法项", () => {
  const parsed = parseToolApprovalConfig({
    policy: "ai",
    askTimeoutSeconds: 120,
    rules: [
      { id: "r1", matcher: "Bash(git push*)", action: "deny", note: "生产保护" },
      { id: "", matcher: "x", action: "allow" }, // 缺 id → 丢弃
      { id: "r2", matcher: "", action: "allow" }, // 缺 matcher → 丢弃
      { id: "r3", matcher: "web_*", action: "nope" }, // 非法 action → 丢弃
    ],
    alwaysAllow: ["workspace:re_shell_exec", "", "workspace:re_shell_exec"],
    aiGate: {
      provider: "jev",
      jevModel: "jev-latest",
      confidenceThreshold: 0.8,
      escalateOnDeny: false,
      jevApiKey: "  k  ",
    },
  });
  assert.equal(parsed.policy, "ai");
  assert.equal(parsed.askTimeoutSeconds, 120);
  assert.equal(parsed.rules?.length, 1);
  assert.equal(parsed.rules?.[0]?.matcher, "Bash(git push*)");
  assert.deepEqual(parsed.alwaysAllow, ["workspace:re_shell_exec"]);
  assert.equal(parsed.aiGate?.confidenceThreshold, 0.8);
  assert.equal(parsed.aiGate?.jevApiKey, "k");
});

test("策略与阈值解析：缺省回落 allow_all / 0.7", () => {
  assert.equal(resolveApprovalPolicy(undefined), "allow_all");
  assert.equal(resolveApprovalPolicy({}), "allow_all");
  assert.equal(resolveApprovalPolicy({ policy: "always_ask" }), "always_ask");
  assert.equal(parseToolApprovalConfig({ policy: "ask" }).policy, "always_ask");
  assert.equal(resolveConfidenceThreshold(undefined), 0.7);
  assert.equal(resolveConfidenceThreshold({ aiGate: { confidenceThreshold: 0.9 } }), 0.9);
  // Only explicit zero disables the default timeout.
  assert.equal(resolveAskTimeoutSeconds(undefined), 300);
  assert.equal(resolveAskTimeoutSeconds({}), 300);
  assert.equal(resolveAskTimeoutSeconds({ askTimeoutSeconds: -1 }), 300);
  assert.equal(resolveAskTimeoutSeconds({ askTimeoutSeconds: NaN }), 300);
  assert.equal(resolveAskTimeoutSeconds({ askTimeoutSeconds: 0 }), null);
  assert.equal(resolveAskTimeoutSeconds({ askTimeoutSeconds: 60 }), 60);
});

test("strict policy normalization preserves explicit choices and legacy restrictions", () => {
  for (const policy of ["ask", "always_ask"]) {
    const config = parseToolApprovalConfig({ policy, alwaysAllow: ["*"], alwaysDeny: ["delete"], rules: [{ id: "allow", matcher: "*", action: "allow" }] });
    assert.equal(config.policy, "always_ask");
    assert.deepEqual(config.alwaysAllow, ["*"]);
    assert.deepEqual(config.alwaysDeny, ["delete"]);
    assert.equal(config.rules?.length, 1);
  }
  assert.equal(parseToolApprovalConfig({ policy: "allow_all" }).policy, "allow_all");
  assert.equal(parseToolApprovalConfig({ policy: "ai" }).policy, "ai");
  assert.equal(parseToolApprovalConfig({ policy: "invalid" }).policy, undefined);
  assert.deepEqual(parseToolApprovalConfig({ aiGate: { routeId: " route-1 ", routeAlias: " legacy " } }).aiGate, { routeId: "route-1", routeAlias: "legacy" });
  assert.equal(parseToolApprovalConfig({ askTimeoutSeconds: Infinity }).askTimeoutSeconds, undefined);
  assert.equal(parseToolApprovalConfig({ askTimeoutSeconds: 0 }).askTimeoutSeconds, 0);
});

test("AI approval scope preserves explicit choices and defaults to Space inheritance", () => {
  for (const scope of ["inherit", "risky", "all"] as const) {
    assert.equal(parseToolApprovalConfig({ aiGate: { scope } }).aiGate?.scope, scope);
  }
  assert.equal(parseToolApprovalConfig({ aiGate: { scope: "unknown" } }).aiGate, undefined);
});

test("approvalRuleHits 复用 Claude 钩子匹配语法", () => {
  const args = { command: "git push origin main" };
  assert.equal(approvalRuleHits("Bash(git push*)", "re_shell_exec", args), true);
  assert.equal(approvalRuleHits("Bash(git commit*)", "re_shell_exec", args), false);
  assert.equal(approvalRuleHits("shell_exec", "re_shell_exec"), true);
  assert.equal(approvalRuleHits("Bash", "re_shell_exec"), true);
  assert.equal(approvalRuleHits("*", "anything"), true);
  assert.equal(approvalRuleHits("", "anything"), true);
  assert.equal(approvalRuleHits("web_search", "re_shell_exec"), false);
});
