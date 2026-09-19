/**
 * 工具调用审批系统（Codex / Claude Code 式）。
 *
 * 策略分层（按优先级）：
 * 1. deny 规则 / 记住的拒绝        → 直接拒绝
 * 2. 记住的允许（always allow）    → 直接允许
 * 3. ask 规则                      → 询问用户
 * 4. allow 规则                    → 直接允许
 * 5. 策略默认值（policy）：
 *    - allow_all  默认允许所有调用（yolo）
 *    - ask        只读工具放行，其余询问用户
 *    - ai         AI 审批门控（JEV System One / 传统 LLM），低置信度升级人工
 *
 * 规则匹配器复用 Claude 钩子语法：`Bash(git push*)`、`web_*`、`*`。
 */
import { hookIfHits } from "./agent-hooks.js";

export const TOOL_APPROVAL_POLICIES = ["allow_all", "ask", "ai"] as const;
export type ToolApprovalPolicy = (typeof TOOL_APPROVAL_POLICIES)[number];

export const TOOL_APPROVAL_RULE_ACTIONS = ["allow", "deny", "ask"] as const;
export type ToolApprovalRuleAction = (typeof TOOL_APPROVAL_RULE_ACTIONS)[number];

export type ToolApprovalRule = {
  id: string;
  /** 匹配器：`Bash(git push*)` / `shell_exec` / `*`；空 = 匹配所有 */
  matcher: string;
  action: ToolApprovalRuleAction;
  note?: string;
};

export type ToolApprovalAiProvider = "jev" | "llm";

export type ToolApprovalAiGateConfig = {
  /** AI 门控后端（默认 jev） */
  provider?: ToolApprovalAiProvider;
  /** TypeSafe System One 模型 id（默认 jev-latest） */
  jevModel?: string;
  /** TypeSafe API Base（默认 https://api.typesafe.ai） */
  jevBaseUrl?: string;
  /** TypeSafe API Key；留空优先用模型路由（evaluation），再回落环境变量 TYPESAFE_API_KEY */
  jevApiKey?: string;
  /** JEV 评估路由 alias：优先于直连配置（在「模型路由」里配置 typesafe 上游后填这里） */
  routeAlias?: string;
  /** 传统模型：模型路由 alias（provider=llm 时使用） */
  llmModel?: string;
  /** 0-1，低于该置信度升级人工（默认 0.7） */
  confidenceThreshold?: number;
  /** AI 判拒绝时是否转人工复核（默认 true；false = 直接拒绝） */
  escalateOnDeny?: boolean;
};

export type ToolApprovalConfig = {
  policy?: ToolApprovalPolicy;
  rules?: ToolApprovalRule[];
  /** 记住的允许：匹配器列表（「总是允许」写入此处） */
  alwaysAllow?: string[];
  /** 记住的拒绝：匹配器列表 */
  alwaysDeny?: string[];
  aiGate?: ToolApprovalAiGateConfig;
  /** 人工审批超时秒数（默认 300；0 = 不限时） */
  askTimeoutSeconds?: number;
};

export const DEFAULT_TOOL_APPROVAL: Required<Pick<ToolApprovalConfig, "policy">> = {
  policy: "allow_all",
};

export const DEFAULT_AI_CONFIDENCE_THRESHOLD = 0.7;
export const DEFAULT_ASK_TIMEOUT_SECONDS = 300;

export function parseToolApprovalPolicy(raw: unknown): ToolApprovalPolicy {
  return typeof raw === "string" &&
    (TOOL_APPROVAL_POLICIES as readonly string[]).includes(raw)
    ? (raw as ToolApprovalPolicy)
    : DEFAULT_TOOL_APPROVAL.policy;
}

export function parseToolApprovalConfig(raw: unknown): ToolApprovalConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: ToolApprovalConfig = {};
  if ((TOOL_APPROVAL_POLICIES as readonly string[]).includes(o.policy as string)) {
    out.policy = o.policy as ToolApprovalPolicy;
  }
  if (Array.isArray(o.rules)) {
    const rules: ToolApprovalRule[] = [];
    for (const item of o.rules) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const r = item as Record<string, unknown>;
      const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : "";
      const matcher = typeof r.matcher === "string" ? r.matcher.trim() : "";
      if (!id || !matcher) continue;
      if (!(TOOL_APPROVAL_RULE_ACTIONS as readonly string[]).includes(r.action as string)) {
        continue;
      }
      rules.push({
        id,
        matcher,
        action: r.action as ToolApprovalRuleAction,
        ...(typeof r.note === "string" && r.note.trim() ? { note: r.note.trim() } : {}),
      });
    }
    if (rules.length) out.rules = rules;
  }
  out.alwaysAllow = parseMatcherList(o.alwaysAllow);
  out.alwaysDeny = parseMatcherList(o.alwaysDeny);
  if (o.aiGate && typeof o.aiGate === "object" && !Array.isArray(o.aiGate)) {
    const g = o.aiGate as Record<string, unknown>;
    const gate: ToolApprovalAiGateConfig = {};
    if (g.provider === "jev" || g.provider === "llm") gate.provider = g.provider;
    if (typeof g.jevModel === "string" && g.jevModel.trim()) gate.jevModel = g.jevModel.trim();
    if (typeof g.jevBaseUrl === "string" && g.jevBaseUrl.trim()) {
      gate.jevBaseUrl = g.jevBaseUrl.trim();
    }
    if (typeof g.jevApiKey === "string" && g.jevApiKey.trim()) {
      gate.jevApiKey = g.jevApiKey.trim();
    }
    if (typeof g.llmModel === "string" && g.llmModel.trim()) gate.llmModel = g.llmModel.trim();
    if (typeof g.routeAlias === "string" && g.routeAlias.trim()) {
      gate.routeAlias = g.routeAlias.trim();
    }
    if (
      typeof g.confidenceThreshold === "number" &&
      g.confidenceThreshold >= 0 &&
      g.confidenceThreshold <= 1
    ) {
      gate.confidenceThreshold = g.confidenceThreshold;
    }
    if (typeof g.escalateOnDeny === "boolean") gate.escalateOnDeny = g.escalateOnDeny;
    if (Object.keys(gate).length) out.aiGate = gate;
  }
  if (typeof o.askTimeoutSeconds === "number" && o.askTimeoutSeconds >= 0) {
    out.askTimeoutSeconds = Math.min(Math.floor(o.askTimeoutSeconds), 86_400);
  }
  return out;
}

function parseMatcherList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((s) => s.length > 0);
  return list.length ? [...new Set(list)] : undefined;
}

/** 策略生效值：未配置按 allow_all（默认允许所有调用） */
export function resolveApprovalPolicy(config: ToolApprovalConfig | undefined): ToolApprovalPolicy {
  return config?.policy ?? DEFAULT_TOOL_APPROVAL.policy;
}

export function resolveConfidenceThreshold(config: ToolApprovalConfig | undefined): number {
  const raw = config?.aiGate?.confidenceThreshold;
  return typeof raw === "number" && raw >= 0 && raw <= 1
    ? raw
    : DEFAULT_AI_CONFIDENCE_THRESHOLD;
}

export function resolveAskTimeoutSeconds(config: ToolApprovalConfig | undefined): number | null {
  const raw = config?.askTimeoutSeconds;
  if (typeof raw !== "number" || raw <= 0) return null;
  return raw;
}

/** 审批请求原因（事件与 UI 共用） */
export type ToolApprovalReason =
  | "rule_ask"
  | "policy_ask"
  | "ai_auto"
  | "ai_low_confidence"
  | "ai_deny_escalate";

export const TOOL_APPROVAL_REASON_LABEL: Record<ToolApprovalReason, string> = {
  rule_ask: "规则要求确认",
  policy_ask: "策略要求确认",
  ai_auto: "AI 自动决定",
  ai_low_confidence: "AI 置信度不足",
  ai_deny_escalate: "AI 建议拒绝，转人工复核",
};

/** AI 门控决策（随审批事件广播，供 UI 展示概率分布） */
export type ToolApprovalAiDecision = {
  provider: ToolApprovalAiProvider;
  model: string;
  decision: "allow" | "deny";
  confidence: number;
  probabilities?: Record<string, number>;
  rationale?: string;
  latencyMs?: number;
  /** AI 调用失败降级为人工审批时标记 */
  degraded?: boolean;
};

export type CloudAgentToolApprovalOption = {
  optionId: "allow" | "allow_always" | "deny";
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once";
};

export type CloudAgentToolApprovalRequestPayload = {
  requestId: string;
  toolCallId: string;
  /** 模型可见的工具名 */
  toolName: string;
  /** 限定名（provider:tool） */
  qualifiedName?: string;
  title?: string;
  argumentsJson: string;
  reason: ToolApprovalReason;
  /** AI 门控结果（ai 策略下总是携带；人工审批时若有 AI 预判也带上） */
  ai?: ToolApprovalAiDecision;
  options: CloudAgentToolApprovalOption[];
  expiresAt?: string | null;
};

export type CloudAgentToolApprovalResolvedPayload = {
  requestId: string;
  toolCallId?: string;
  decision: "approved" | "denied" | "timeout" | "cancelled";
  decidedBy: "user" | "ai" | "timeout" | "cancel";
  alwaysAllow?: boolean;
};

/** 规则是否命中（复用 Claude 钩子匹配语法） */
export function approvalRuleHits(
  matcher: string,
  toolName: string,
  toolArgs?: Record<string, unknown>,
): boolean {
  return hookIfHits(matcher, toolName, toolArgs);
}
