/**
 * chat-app 的纯函数助手与常量。
 *
 * 这些逻辑不依赖任何 React 状态，只做数据整形（会话分组、URL 同步、上下文窗口估算），
 * 从 chat-app.tsx 拆出以便单测与复用。行为保持不变。
 */
import {
  DEFAULT_CONTEXT_LIMIT_TOKENS,
  estimateEventPayloadTokens,
  estimateTextTokens,
  estimateTokensFromChars,
} from "@zakura/shared";
import type { CloudAgentEvent } from "@zakura/shared";
import {
  SESSION_KIND_LABELS,
  type ChatModelOption,
  type CloudAgentSessionKind,
  type CloudSession,
  type SessionKindsFilter,
} from "@/lib/cloud-agent";
import type { ContextWindowInfo } from "./context-window";

export const AGENT_KEY = "zakura_chat_agent";
export const REASONING_KEY = "zakura_chat_reasoning";
export const DRAFT_KEY_PREFIX = "zakura_chat_draft";

/** 对话列表：chat 过滤时仍拉项目里的子代理/系统会话，方便归组。 */
export function kindsForSidebar(filter: CloudAgentSessionKind | "all"): SessionKindsFilter {
  if (filter === "all") return "all";
  if (filter === "chat") return ["chat", "subagent", "delegate", "acp", "system"];
  return [filter];
}

/** 把当前 agent/session 写回地址栏，刷新后仍停在同一对话；新对话则清掉 session */
export function syncChatUrl(agentId: string | null, sessionId: string | null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (agentId) url.searchParams.set("agent", agentId);
  else url.searchParams.delete("agent");
  if (sessionId) url.searchParams.set("session", sessionId);
  else url.searchParams.delete("session");
  const next = url.searchParams.toString()
    ? `${url.pathname}?${url.searchParams.toString()}`
    : url.pathname;
  const current = `${window.location.pathname}${window.location.search}`;
  if (next !== current) window.history.replaceState({}, "", next);
}

/** 侧栏会话类型过滤选项（chat 为默认视图；其余为系统产生的对话记录） */
export const KIND_FILTER_OPTIONS: Array<{ value: CloudAgentSessionKind | "all"; label: string }> = [
  { value: "chat", label: SESSION_KIND_LABELS.chat },
  { value: "subagent", label: SESSION_KIND_LABELS.subagent },
  { value: "delegate", label: SESSION_KIND_LABELS.delegate },
  { value: "acp", label: SESSION_KIND_LABELS.acp },
  { value: "system", label: SESSION_KIND_LABELS.system },
  { value: "all", label: "全部类型" },
];

export function groupSessions(sessions: CloudSession[]): Array<{
  label: string;
  items: CloudSession[];
}> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups = [
    { label: "今天", items: [] as CloudSession[] },
    { label: "昨天", items: [] as CloudSession[] },
    { label: "近 7 天", items: [] as CloudSession[] },
    { label: "更早", items: [] as CloudSession[] },
  ];
  for (const s of sessions) {
    const t = +new Date(s.updatedAt);
    if (t >= startOfDay) groups[0]!.items.push(s);
    else if (t >= startOfDay - 86_400_000) groups[1]!.items.push(s);
    else if (t >= startOfDay - 6 * 86_400_000) groups[2]!.items.push(s);
    else groups[3]!.items.push(s);
  }
  return groups.filter((g) => g.items.length > 0);
}

export function latestCompaction(events: CloudAgentEvent[]) {
  return [...events].reverse().find((ev) => ev.type === "context_compacted") ?? null;
}

/** 最近一次模型调用的 measured prompt_tokens（run_log） */
export function latestMeasuredPromptTokens(events: CloudAgentEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!;
    if (ev.type !== "run_log") continue;
    const data = (ev.payload as { data?: Record<string, unknown> }).data;
    if (!data) continue;
    const n =
      typeof data.promptTokens === "number"
        ? data.promptTokens
        : typeof data.calibratedPromptTokens === "number"
          ? data.calibratedPromptTokens
          : null;
    if (n != null && n > 0) return n;
  }
  return null;
}

export function buildContextWindowInfo(
  events: CloudAgentEvent[],
  modelItem: ChatModelOption | undefined,
): ContextWindowInfo {
  const compaction = latestCompaction(events);
  const compactionSeq = compaction?.seq ?? 0;
  const compactionPayload = (compaction?.payload ?? {}) as Record<string, unknown>;
  const summary =
    typeof compactionPayload.summary === "string" ? compactionPayload.summary : "";

  // 与压缩点之后的事件 + 摘要，用 CJK 感知估算（与服务端一致）
  let estimatedTokens = events
    .filter((ev) => ev.seq > compactionSeq)
    .reduce(
      (sum, ev) => sum + estimateEventPayloadTokens(ev.payload as Record<string, unknown>),
      0,
    );
  if (summary) estimatedTokens += estimateTextTokens(summary) + 20;

  const measured = latestMeasuredPromptTokens(events);
  // 有 measured 时优先（更接近真实 prompt）；压缩后 measured 可能偏旧，仍作上限参考
  const usedTokens =
    measured != null && measured > 0
      ? Math.max(estimatedTokens, Math.min(measured, estimatedTokens * 2.2))
      : estimatedTokens;

  const limitTokens =
    modelItem?.contextLimit && modelItem.contextLimit > 0
      ? modelItem.contextLimit
      : DEFAULT_CONTEXT_LIMIT_TOKENS;

  const beforeTokens =
    typeof compactionPayload.beforeTokens === "number"
      ? compactionPayload.beforeTokens
      : typeof compactionPayload.beforeChars === "number"
        ? estimateTokensFromChars(compactionPayload.beforeChars)
        : 0;
  const afterTokens =
    typeof compactionPayload.afterTokens === "number"
      ? compactionPayload.afterTokens
      : typeof compactionPayload.afterChars === "number"
        ? estimateTokensFromChars(compactionPayload.afterChars)
        : 0;

  return {
    usedTokens: Math.max(0, Math.round(usedTokens)),
    limitTokens,
    ratio: limitTokens > 0 ? usedTokens / limitTokens : 0,
    messageCount: events.filter(
      (ev) => ev.type === "user_message" || ev.type === "assistant_message",
    ).length,
    toolResultCount: events.filter((ev) => ev.type === "tool_call_result").length,
    summaryCount: events.filter((ev) => ev.type === "context_compacted").length,
    lastSummary: summary || undefined,
    lastCompactedAt: compaction?.createdAt,
    lastSavedTokens:
      beforeTokens > afterTokens ? Math.round(beforeTokens - afterTokens) : undefined,
    systemSessionId:
      typeof compactionPayload.systemSessionId === "string"
        ? compactionPayload.systemSessionId
        : undefined,
    source: measured != null ? "measured" : modelItem?.contextLimit ? "model" : "estimated",
  };
}