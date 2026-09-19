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
  assert.equal(resolveApprovalPolicy({ policy: "ask" }), "ask");
  assert.equal(resolveConfidenceThreshold(undefined), 0.7);
  assert.equal(resolveConfidenceThreshold({ aiGate: { confidenceThreshold: 0.9 } }), 0.9);
  // 超时：0 / 缺省 = 不限时
  assert.equal(resolveAskTimeoutSeconds(undefined), null);
  assert.equal(resolveAskTimeoutSeconds({ askTimeoutSeconds: 0 }), null);
  assert.equal(resolveAskTimeoutSeconds({ askTimeoutSeconds: 60 }), 60);
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
