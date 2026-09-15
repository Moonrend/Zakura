/**
 * 事件日志 ↔ 模型消息的转换与上下文预算控制。
 * 会话事件流是权威源；这里负责把它确定性地还原为模型输入。
 */
import type {
  CloudAgentAttachment,
  ModelChatContentPart,
  ModelChatMessage,
  ModelToolCall,
} from "@zakura/shared";
import {
  estimateCharsFromTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  resolveContextWindowBudget,
} from "@zakura/shared";
import { newId } from "../../db/schema.js";

/** 历史消息总字符数超过该值 → 同步 LLM 摘要压缩（硬阈值） */
export const COMPACT_THRESHOLD_CHARS = 60_000;
/** 软阈值 = hard × 该比例：Run 结束后预压缩，降低下一轮硬压概率 */
export const COMPACT_SOFT_RATIO = 0.7;
/** 压缩后保留的最近消息条数上限 */
export const COMPACT_KEEP_RECENT = 16;
/** 压缩后尽量保留的最近上下文字符量（优先完整 user turn） */
export const COMPACT_KEEP_RECENT_CHARS = 24_000;
/** 循环内消息总量超过该值时就地压缩旧工具结果 */
export const INLOOP_COMPACT_CHARS = 90_000;
/** 单条工具结果默认上限（进入模型前） */
export const MAX_TOOL_RESULT_CHARS = 12_000;
/** 工具参数摘要上限（摘要 digest 用） */
export const SUMMARY_ARG_CHARS = 400;

export type CompactBudget = {
  /** 硬阈值字符（turn 切分与旧逻辑兼容） */
  thresholdChars: number;
  softThresholdChars: number;
  keepRecent: number;
  keepRecentChars: number;
  inLoopChars: number;
  maxToolResultChars: number;
  /** token 硬阈值：压缩决策优先用这个 */
  thresholdTokens: number;
  softThresholdTokens: number;
  keepRecentTokens: number;
  inLoopTokens: number;
  contextLimitTokens: number | null;
  reserveTokens: number;
};

function budgetFromWindow(
  overrides: Partial<CompactBudget> | null | undefined,
  contextLimitTokens?: number | null,
  reserveTokens?: number,
): CompactBudget {
  const o = overrides ?? {};
  const win = resolveContextWindowBudget({
    contextLimitTokens: contextLimitTokens ?? undefined,
    reserveTokens,
    thresholdChars: o.thresholdChars,
    softThresholdChars: o.softThresholdChars,
    keepRecentChars: o.keepRecentChars,
    maxToolResultChars: o.maxToolResultChars,
    softRatio: COMPACT_SOFT_RATIO,
  });
  const keepRecent =
    typeof o.keepRecent === "number" && o.keepRecent >= 4
      ? Math.min(Math.floor(o.keepRecent), 64)
      : COMPACT_KEEP_RECENT;

  // 若用户只配了 char 而未给窗口，仍用默认窗口算出 token 侧
  return {
    thresholdChars: Math.max(8_000, win.hardChars),
    softThresholdChars: Math.max(4_000, win.softChars),
    keepRecent,
    keepRecentChars: Math.max(4_000, win.keepRecentChars),
    inLoopChars: Math.max(win.hardChars, win.inLoopChars),
    maxToolResultChars: win.maxToolResultChars,
    thresholdTokens: win.hardTokens,
    softThresholdTokens: win.softTokens,
    keepRecentTokens: win.keepRecentTokens,
    inLoopTokens: win.inLoopTokens,
    contextLimitTokens: win.contextLimitTokens,
    reserveTokens: win.reserveTokens,
  };
}

export const DEFAULT_COMPACT_BUDGET: CompactBudget = budgetFromWindow({
  thresholdChars: COMPACT_THRESHOLD_CHARS,
  keepRecentChars: COMPACT_KEEP_RECENT_CHARS,
  maxToolResultChars: MAX_TOOL_RESULT_CHARS,
});

/** 从 CloudAgentConfig / 调用方覆盖解析压缩预算（无模型窗口时用默认 128k） */
export function resolveCompactBudget(overrides?: Partial<CompactBudget> | null): CompactBudget {
  return budgetFromWindow(overrides, null);
}

/**
 * 按模型上下文窗口收紧预算（token 优先，字符为镜像）。
 * 用户显式 thresholdChars 会换算后与窗口可用量取更严。
 */
export function resolveCompactBudgetForContextWindow(
  overrides: Partial<CompactBudget> | null | undefined,
  contextLimitTokens: number | null | undefined,
  opts?: { reserveTokens?: number },
): CompactBudget {
  return budgetFromWindow(overrides, contextLimitTokens, opts?.reserveTokens);
}

/** 消息体积：优先 token 估算；chars 仅作兼容 */
export function messageApproxChars(m: ModelChatMessage): number {
  return estimateCharsFromTokens(estimateMessageTokens(m));
}

/** 当前上下文是否超过硬阈值（token） */
export function isOverHardBudget(
  messages: ModelChatMessage[],
  budget: CompactBudget,
  opts?: { toolsTokens?: number; calibratedTokens?: number },
): boolean {
  const tokens =
    typeof opts?.calibratedTokens === "number"
      ? opts.calibratedTokens
      : estimateMessagesTokens(messages) + (opts?.toolsTokens ?? 0);
  return tokens > budget.thresholdTokens;
}

/** 是否超过软阈值 */
export function isOverSoftBudget(
  messages: ModelChatMessage[],
  budget: CompactBudget,
  opts?: { toolsTokens?: number; calibratedTokens?: number },
): boolean {
  const tokens =
    typeof opts?.calibratedTokens === "number"
      ? opts.calibratedTokens
      : estimateMessagesTokens(messages) + (opts?.toolsTokens ?? 0);
  return tokens > budget.softThresholdTokens;
}

/**
 * 在完整 user turn 边界切分：recent 从某个 user 消息起保留，older 交给 LLM 摘要。
 * 前缀 system 消息始终归入 systemPrefix，不参与摘要/截断。
 * 单 turn 极大时允许从该 turn 内的 assistant 边界切开（绝不拆开 tool_call 与 result）。
 */
export function splitMessagesForCompaction(
  messages: ModelChatMessage[],
  budget?: Partial<CompactBudget> | null,
): {
  systemPrefix: ModelChatMessage[];
  older: ModelChatMessage[];
  recent: ModelChatMessage[];
  cutIndex: number;
} {
  const b = resolveCompactBudget(budget);
  let sysEnd = 0;
  while (sysEnd < messages.length && messages[sysEnd]!.role === "system") sysEnd += 1;
  const systemPrefix = messages.slice(0, sysEnd);
  const body = messages.slice(sysEnd);
  if (body.length === 0) {
    return { systemPrefix, older: [], recent: [], cutIndex: sysEnd };
  }

  const userIdxs: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    if (body[i]!.role === "user") userIdxs.push(i);
  }

  let start = 0;
  if (userIdxs.length === 0) {
    // 无 user：从尾部按字符回退，并对齐到 assistant（避免 orphan tool）
    start = body.length;
    let chars = 0;
    let count = 0;
    for (let i = body.length - 1; i >= 0; i -= 1) {
      chars += messageApproxChars(body[i]!);
      count += 1;
      start = i;
      if (chars >= b.keepRecentChars || count >= b.keepRecent) break;
    }
    while (start > 0 && body[start]!.role === "tool") start -= 1;
  } else {
    // 从最新 user turn 往前扩，直到达到 keep 预算
    start = userIdxs[userIdxs.length - 1]!;
    for (let t = userIdxs.length - 1; t >= 0; t -= 1) {
      const candidate = userIdxs[t]!;
      const slice = body.slice(candidate);
      const chars = approxMessagesChars(slice);
      const turnsKept = userIdxs.length - t;
      // 已超过预算且至少保留了 1 个 turn → 用上一次 start
      if (
        t < userIdxs.length - 1 &&
        (chars > b.keepRecentChars || slice.length > b.keepRecent || turnsKept > 6)
      ) {
        break;
      }
      start = candidate;
      if (chars >= b.keepRecentChars || slice.length >= b.keepRecent) {
        // 单个 turn 过大：在 turn 内尽量保留尾部，对齐 assistant
        if (chars > b.keepRecentChars * 1.5 && slice.length > 6) {
          start = shrinkTurnKeepStart(body, candidate, b);
        }
        break;
      }
    }
  }

  // 安全：cut 不能落在 tool 上
  while (start > 0 && body[start]!.role === "tool") start -= 1;

  return {
    systemPrefix,
    older: body.slice(0, start),
    recent: body.slice(start),
    cutIndex: sysEnd + start,
  };
}

/** 超大 turn：从 turnStart 起保留尾部，切点落在 assistant 或 user */
function shrinkTurnKeepStart(
  body: ModelChatMessage[],
  turnStart: number,
  b: CompactBudget,
): number {
  let start = body.length;
  let chars = 0;
  let count = 0;
  for (let i = body.length - 1; i >= turnStart; i -= 1) {
    chars += messageApproxChars(body[i]!);
    count += 1;
    start = i;
    if (chars >= b.keepRecentChars || count >= b.keepRecent) break;
  }
  while (start > turnStart && body[start]!.role === "tool") start -= 1;
  // 若落在 assistant，检查其 tool_calls 是否都在 recent 内——start 就是该 assistant，tool 在后面，OK
  return start;
}

/** 上游「上下文超长」类错误（用于 compact 后重试） */
export function isContextOverflowError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const code = String(
    (err as { code?: unknown; status?: unknown; statusCode?: unknown })?.code ??
      (err as { status?: unknown })?.status ??
      (err as { statusCode?: unknown })?.statusCode ??
      "",
  );
  if (/^(400|413)$/.test(code) && /context|token|length|prompt/i.test(msg)) return true;
  return /context[_ ]?length|maximum context|context window|too many tokens|prompt is too long|token limit|exceeds?\s*(the\s*)?(max|context)|max_tokens|string_above_max|请求过长|上下文.{0,6}(过长|超限|超出)|input.*too long/i.test(
    msg,
  );
}

function shrinkText(text: string, keep: number, label: string): string {
  if (text.length <= keep) return text;
  const head = Math.max(200, Math.floor(keep * 0.7));
  const tail = Math.max(80, keep - head - 40);
  return `${text.slice(0, head)}\n…(${label}，原 ${text.length} 字)\n${text.slice(-tail)}`;
}

export type StoredEvent = {
  type: string;
  runId?: string | null;
  payload: Record<string, unknown>;
};

/** 事件负载中的附件数组解析（宽容非法数据） */
export function parseAttachments(raw: unknown): CloudAgentAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: CloudAgentAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.path !== "string" || !o.path) continue;
    out.push({
      name: typeof o.name === "string" && o.name ? o.name : o.path.split("/").pop() || o.path,
      path: o.path,
      mime: typeof o.mime === "string" ? o.mime : "application/octet-stream",
      size: typeof o.size === "number" ? o.size : 0,
      kind: o.kind === "image" ? "image" : "file",
    });
    if (out.length >= 10) break;
  }
  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 图片部件占位 URL 前缀：模型调用前由 WorkspaceFs 解析为 data URI */
export const WORKSPACE_IMAGE_PREFIX = "workspace:";

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

export function guessImageMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME_BY_EXT[ext] ?? "image/png";
}

/**
 * 构建带附件的用户消息：
 * - 全部附件以文本注记进入 content（模型可用 fs_* 工具处理任意类型）
 * - 图片附件额外生成 image_url 部件（占位 URL，运行时读文件转 data URI）
 */
export function buildUserMessage(
  content: string,
  attachments: CloudAgentAttachment[],
): ModelChatMessage {
  if (attachments.length === 0) return { role: "user", content };
  const notes = attachments
    .map((a) => `- ${a.path}（${a.mime}，${formatBytes(a.size)}）`)
    .join("\n");
  const text = `${content}${content ? "\n\n" : ""}[用户上传了 ${attachments.length} 个附件，位于工作区：]\n${notes}`;
  const parts: ModelChatContentPart[] = [{ type: "text", text }];
  for (const a of attachments) {
    if (a.kind !== "image") continue;
    parts.push({
      type: "image_url",
      imageUrl: { url: `${WORKSPACE_IMAGE_PREFIX}${a.path}` },
    });
  }
  return {
    role: "user",
    content: text,
    ...(parts.length > 1 ? { parts } : {}),
  };
}

/**
 * 会话消息树的链式上下文重建。
 * 从目标用户消息沿 parentRunId → replyToMessageId 回溯到根，
 * 只包含当前分支路径上的回答（重新生成的旧变体、其他分支自然被排除）。
 * 旧事件缺少 parentRunId / replyToMessageId 时按 seq 线性推断，向后兼容。
 */
export function buildChainMessages(
  events: StoredEvent[],
  targetMessageId: string,
): { messages: ModelChatMessage[]; userContent: string; turns: number } {
  const userMsgs = new Map<
    string,
    { content: string; parentRunId: string | null; attachments: CloudAgentAttachment[] }
  >();
  const runReplyTo = new Map<string, string | null>();
  const failedRuns = new Set<string>();
  const runEvents = new Map<string, StoredEvent[]>();
  let lastUserMessageId: string | null = null;
  let lastRunId: string | null = null;

  for (const ev of events) {
    const p = ev.payload;
    if (ev.type === "user_message") {
      const mid = typeof p.messageId === "string" ? p.messageId : null;
      if (!mid) continue;
      // 同 Run 注入：挂在 runEvents，不当新回合锚点
      if (p.steer === true && ev.runId) {
        let list = runEvents.get(ev.runId);
        if (!list) {
          list = [];
          runEvents.set(ev.runId, list);
        }
        list.push(ev);
        continue;
      }
      const parentRunId =
        "parentRunId" in p
          ? typeof p.parentRunId === "string"
            ? p.parentRunId
            : null
          : lastRunId; // 旧事件：线性推断为上一个 Run
      userMsgs.set(mid, {
        content: typeof p.content === "string" ? p.content : "",
        parentRunId,
        attachments: parseAttachments(p.attachments),
      });
      lastUserMessageId = mid;
      continue;
    }
    if (ev.type === "run_start") {
      const rid = ev.runId ?? (typeof p.runId === "string" ? p.runId : null);
      if (!rid) continue;
      const replyTo =
        typeof p.replyToMessageId === "string" ? p.replyToMessageId : lastUserMessageId;
      runReplyTo.set(rid, replyTo);
      lastRunId = rid;
      continue;
    }
    if (ev.type === "run_end" && p.status === "failed" && ev.runId) {
      failedRuns.add(ev.runId);
      continue;
    }
    // Gateway 等无 Run 的事件流：合成 run，让线性 user/assistant 能串成链
    if (ev.type === "assistant_message" && !ev.runId) {
      const mid = typeof p.messageId === "string" ? p.messageId : null;
      if (!mid || !lastUserMessageId) continue;
      const rid = `orphan:${mid}`;
      runReplyTo.set(rid, lastUserMessageId);
      lastRunId = rid;
      runEvents.set(rid, [ev]);
      continue;
    }
    if (
      ev.runId &&
      (ev.type === "assistant_delta" ||
        ev.type === "assistant_message" ||
        ev.type === "assistant_rollback" ||
        ev.type === "tool_call_start" ||
        ev.type === "tool_call_args" ||
        ev.type === "tool_call_result")
    ) {
      let list = runEvents.get(ev.runId);
      if (!list) {
        list = [];
        runEvents.set(ev.runId, list);
      }
      list.push(ev);
    }
  }

  if (!userMsgs.has(targetMessageId)) {
    throw new Error("目标用户消息不存在");
  }

  // 回溯路径：target → parentRun → 其 replyTo 消息 → …
  const chain: Array<{
    messageId: string;
    content: string;
    viaRunId: string | null;
    attachments: CloudAgentAttachment[];
  }> = [];
  let mid: string | null = targetMessageId;
  const seen = new Set<string>();
  while (mid && !seen.has(mid)) {
    seen.add(mid);
    const um = userMsgs.get(mid);
    if (!um) break;
    chain.unshift({
      messageId: mid,
      content: um.content,
      viaRunId: um.parentRunId,
      attachments: um.attachments,
    });
    if (!um.parentRunId) break;
    mid = runReplyTo.get(um.parentRunId) ?? null;
  }

  const messages: ModelChatMessage[] = [];
  for (let k = 0; k < chain.length; k += 1) {
    messages.push(buildUserMessage(chain[k]!.content, chain[k]!.attachments));
    // 回答本回合的 Run = 下一回合的 parentRunId；失败 Run 的输出不进上下文
    const answeringRun = k + 1 < chain.length ? chain[k + 1]!.viaRunId : null;
    if (answeringRun && !failedRuns.has(answeringRun)) {
      messages.push(...eventsToMessages(runEvents.get(answeringRun) ?? []));
    }
  }

  return {
    messages,
    userContent: chain[chain.length - 1]?.content ?? "",
    turns: chain.length,
  };
}

/**
 * 将事件日志还原为模型消息（不含 system）。
 * 失败 Run 的 assistant/tool 事件会被跳过（用户消息保留），
 * 避免半截输出污染后续上下文；取消的 Run 保留已产出内容。
 */
export function eventsToMessages(events: StoredEvent[]): ModelChatMessage[] {
  const failedRuns = new Set<string>();
  /** 被 assistant_rollback 丢弃的流式消息：其 delta 不进上下文 */
  const rolledBack = new Set<string>();
  for (const ev of events) {
    if (ev.type === "run_end" && ev.payload.status === "failed" && ev.runId) {
      failedRuns.add(ev.runId);
    }
    if (ev.type === "assistant_rollback" && typeof ev.payload.messageId === "string") {
      rolledBack.add(ev.payload.messageId);
    }
  }

  const messages: ModelChatMessage[] = [];
  /** toolCallId → name */
  const toolNames = new Map<string, string>();
  let pendingAssistant: {
    content: string;
    toolCalls: ModelToolCall[];
  } | null = null;

  const flushAssistant = () => {
    if (!pendingAssistant) return;
    if (pendingAssistant.content || pendingAssistant.toolCalls.length) {
      messages.push({
        role: "assistant",
        content: pendingAssistant.content || null,
        toolCalls: pendingAssistant.toolCalls.length ? pendingAssistant.toolCalls : undefined,
      });
    }
    pendingAssistant = null;
  };

  for (const ev of events) {
    const p = ev.payload;
    if (ev.type === "user_message") {
      flushAssistant();
      messages.push(
        buildUserMessage(
          typeof p.content === "string" ? p.content : "",
          parseAttachments(p.attachments),
        ),
      );
      continue;
    }
    if (ev.runId && failedRuns.has(ev.runId)) continue;
    if (ev.type === "assistant_delta") {
      if (typeof p.messageId === "string" && rolledBack.has(p.messageId)) continue;
      if (!pendingAssistant) pendingAssistant = { content: "", toolCalls: [] };
      if (typeof p.delta === "string") pendingAssistant.content += p.delta;
      continue;
    }
    if (ev.type === "assistant_message") {
      if (typeof p.messageId === "string" && rolledBack.has(p.messageId)) continue;
      if (!pendingAssistant) pendingAssistant = { content: "", toolCalls: [] };
      if (typeof p.content === "string") pendingAssistant.content = p.content;
      // 旧 Gateway 把 toolCalls 写在 assistant_message 上，无 start/args
      if (Array.isArray(p.toolCalls)) {
        for (const raw of p.toolCalls) {
          if (!raw || typeof raw !== "object") continue;
          const tc = raw as {
            id?: unknown;
            function?: { name?: unknown; arguments?: unknown };
          };
          const id = typeof tc.id === "string" ? tc.id : "";
          if (!id || pendingAssistant.toolCalls.some((c) => c.id === id)) continue;
          const name = typeof tc.function?.name === "string" ? tc.function.name : "tool";
          const args =
            typeof tc.function?.arguments === "string" ? tc.function.arguments : "{}";
          pendingAssistant.toolCalls.push({
            id,
            type: "function",
            function: { name, arguments: args },
          });
          toolNames.set(id, name);
        }
      }
      flushAssistant();
      continue;
    }
    if (ev.type === "tool_call_start") {
      if (!pendingAssistant) pendingAssistant = { content: "", toolCalls: [] };
      const id = typeof p.toolCallId === "string" ? p.toolCallId : newId();
      const name = typeof p.name === "string" ? p.name : "tool";
      toolNames.set(id, name);
      continue;
    }
    if (ev.type === "tool_call_args") {
      if (!pendingAssistant) pendingAssistant = { content: "", toolCalls: [] };
      const id = typeof p.toolCallId === "string" ? p.toolCallId : "";
      const name = toolNames.get(id) ?? "tool";
      const args = typeof p.arguments === "string" ? p.arguments : "{}";
      if (id && !pendingAssistant.toolCalls.some((c) => c.id === id)) {
        pendingAssistant.toolCalls.push({
          id,
          type: "function",
          function: { name, arguments: args },
        });
      }
      continue;
    }
    if (ev.type === "tool_call_result") {
      flushAssistant();
      const id = typeof p.toolCallId === "string" ? p.toolCallId : "";
      const name =
        (typeof p.name === "string" ? p.name : null) ?? toolNames.get(id) ?? "tool";
      messages.push({
        role: "tool",
        content: typeof p.resultText === "string" ? p.resultText : "",
        toolCallId: id || undefined,
        name,
      });
    }
  }
  flushAssistant();
  patchOrphanToolCalls(messages);
  return messages;
}

/**
 * 为没有对应结果的 tool_call 补上占位 tool 消息（取消/中断的 Run 会留下孤儿调用）。
 * OpenAI 兼容上游要求 assistant.tool_calls 必须跟随对应的 tool 消息，否则整个请求 400。
 */
export function patchOrphanToolCalls(messages: ModelChatMessage[]): void {
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    const answered = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === "tool") {
      const id = messages[j]!.toolCallId;
      if (id) answered.add(id);
      j += 1;
    }
    const missing = m.toolCalls.filter((c) => !answered.has(c.id));
    if (missing.length) {
      messages.splice(
        j,
        0,
        ...missing.map(
          (c): ModelChatMessage => ({
            role: "tool",
            content: "（该工具调用未执行完成：Run 被取消或中断）",
            toolCallId: c.id,
            name: c.function.name,
          }),
        ),
      );
    }
  }
}

export function approxMessagesChars(messages: ModelChatMessage[]): number {
  let n = 0;
  for (const m of messages) n += messageApproxChars(m);
  return n;
}

export function messageTextForSummary(message: ModelChatMessage, limit = 600): string {
  const chunks: string[] = [];
  if (message.content) chunks.push(message.content);
  if (message.toolCalls?.length) {
    for (const call of message.toolCalls) {
      chunks.push(formatToolCallForDigest(call));
    }
  }
  if (message.role === "tool" && message.name) {
    return `[${message.name}] ${chunks.join("\n")}`.slice(0, limit);
  }
  return chunks.join("\n").slice(0, limit);
}

// ── Coding-oriented compaction（摘要体系）────────────────────────────────

/** 确定性文件轨迹：跨压缩轮次累积，保障 coding 续写时知道改过/读过什么 */
export type CompactionFileOps = {
  readFiles: string[];
  modifiedFiles: string[];
};

export const EMPTY_FILE_OPS: CompactionFileOps = { readFiles: [], modifiedFiles: [] };

/** 摘要正文建议上限（结构化优先，允许略长于旧版散文 800 字） */
export const COMPACTION_SUMMARY_MAX_CHARS = 1_800;

const PATH_ARG_KEYS = [
  "path",
  "file",
  "file_path",
  "filepath",
  "filename",
  "from",
  "to",
  "target",
  "source",
  "dest",
  "destination",
] as const;

function toolLocalName(name: string): string {
  // re_fs_read / fs_read / namespace__fs_read
  const bare = name.includes("__") ? (name.split("__").pop() ?? name) : name;
  return bare.replace(/^re_/, "");
}

function isPathLike(s: string): boolean {
  if (!s || s.length > 512) return false;
  if (s.includes("\n") || s.includes("\0")) return false;
  // 工作区相对/绝对路径或带扩展名的源文件
  if (s.startsWith("/") || s.startsWith("./") || s.startsWith("../")) return true;
  if (/^[A-Za-z]:[\\/]/.test(s)) return true;
  return /\.[a-zA-Z0-9]{1,12}$/.test(s) && !s.includes(" ");
}

function pushUniquePath(list: string[], raw: string): void {
  const p = raw.trim().replace(/\\/g, "/");
  if (!p || !isPathLike(p)) return;
  if (!list.includes(p)) list.push(p);
  if (list.length > 80) list.splice(80);
}

function collectPathsFromValue(value: unknown, into: string[], depth = 0): void {
  if (depth > 4 || into.length >= 80) return;
  if (typeof value === "string") {
    pushUniquePath(into, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathsFromValue(item, into, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (PATH_ARG_KEYS.some((pk) => key === pk || key.endsWith(`_${pk}`) || key.endsWith(pk))) {
      collectPathsFromValue(v, into, depth + 1);
    } else if (key === "patches" || key === "files" || key === "paths" || key === "edits") {
      collectPathsFromValue(v, into, depth + 1);
    } else if (typeof v === "object") {
      collectPathsFromValue(v, into, depth + 1);
    }
  }
}

function parseArgsObject(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return {};
}

/**
 * 从消息链确定性抽取读写文件轨迹（不依赖 LLM）。
 * 覆盖 re_fs_* / apply_patch 等原生工具，以及参数里带 path 的通用工具。
 */
export function extractFileOpsFromMessages(messages: ModelChatMessage[]): CompactionFileOps {
  const readFiles: string[] = [];
  const modifiedFiles: string[] = [];

  for (const m of messages) {
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    for (const call of m.toolCalls) {
      const local = toolLocalName(call.function.name);
      const args = parseArgsObject(call.function.arguments);
      const paths: string[] = [];
      collectPathsFromValue(args, paths);

      const isWrite =
        local === "fs_write" ||
        local === "fs_edit" ||
        local === "apply_patch" ||
        local === "write" ||
        local === "edit" ||
        local.includes("write") ||
        local.includes("edit") ||
        local.includes("patch") ||
        local === "fs_delete" ||
        local === "fs_move" ||
        local === "fs_mkdir";
      const isRead =
        local === "fs_read" ||
        local === "fs_list" ||
        local === "fs_stat" ||
        local === "fs_grep" ||
        local === "read" ||
        local === "grep" ||
        local === "glob" ||
        local.includes("read") ||
        local.includes("grep") ||
        local.includes("search") ||
        local.includes("list");

      if (isWrite) {
        for (const p of paths) pushUniquePath(modifiedFiles, p);
        // move: from 也算读过旧路径
        if (local === "fs_move" && typeof args.from === "string") {
          pushUniquePath(readFiles, args.from);
        }
      } else if (isRead) {
        for (const p of paths) pushUniquePath(readFiles, p);
      } else {
        // shell 等：只从参数里捡明显路径，一律记为 read（避免误标修改）
        for (const p of paths) pushUniquePath(readFiles, p);
      }
    }
  }

  // 已改文件不必再出现在「已读」里重复占位
  const modSet = new Set(modifiedFiles);
  return {
    readFiles: readFiles.filter((p) => !modSet.has(p)),
    modifiedFiles,
  };
}

/** 合并多轮文件轨迹（后出现的路径排在后面，去重保序） */
export function mergeFileOps(...parts: Array<CompactionFileOps | null | undefined>): CompactionFileOps {
  const readFiles: string[] = [];
  const modifiedFiles: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    for (const p of part.readFiles ?? []) pushUniquePath(readFiles, p);
    for (const p of part.modifiedFiles ?? []) pushUniquePath(modifiedFiles, p);
  }
  const modSet = new Set(modifiedFiles);
  return {
    readFiles: readFiles.filter((p) => !modSet.has(p)).slice(0, 80),
    modifiedFiles: modifiedFiles.slice(0, 80),
  };
}

/** 从已有摘要正文解析 <read-files>/<modified-files> 或「### 已读文件」列表 */
export function parseFileOpsFromSummary(summary: string): CompactionFileOps {
  const readFiles: string[] = [];
  const modifiedFiles: string[] = [];
  if (!summary?.trim()) return { readFiles, modifiedFiles };

  const tag = (name: string, into: string[]) => {
    const re = new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, "i");
    const m = re.exec(summary);
    if (!m?.[1]) return;
    for (const line of m[1].split(/\r?\n/)) {
      const p = line.replace(/^[-*•]\s*/, "").trim();
      pushUniquePath(into, p);
    }
  };
  tag("read-files", readFiles);
  tag("modified-files", modifiedFiles);

  const sectionPaths = (heading: RegExp, into: string[]) => {
    const m = heading.exec(summary);
    if (!m || m.index == null) return;
    const rest = summary.slice(m.index + m[0].length);
    const next = rest.search(/\n##[\s#]|\n###\s(?!已)/);
    const body = next >= 0 ? rest.slice(0, next) : rest.slice(0, 2_000);
    for (const line of body.split(/\r?\n/)) {
      const p = line.replace(/^[-*•\d.)\s]+/, "").trim();
      pushUniquePath(into, p);
    }
  };
  sectionPaths(/###\s*已读文件\b/, readFiles);
  sectionPaths(/###\s*已改文件\b/, modifiedFiles);

  return mergeFileOps({ readFiles, modifiedFiles });
}

export function formatFileOpsBlock(ops: CompactionFileOps): string {
  const reads = ops.readFiles.length ? ops.readFiles.map((p) => `- ${p}`).join("\n") : "- （无）";
  const mods = ops.modifiedFiles.length
    ? ops.modifiedFiles.map((p) => `- ${p}`).join("\n")
    : "- （无）";
  return [
    "### 已读文件",
    reads,
    "",
    "### 已改文件",
    mods,
    "",
    "<read-files>",
    ops.readFiles.join("\n") || "",
    "</read-files>",
    "<modified-files>",
    ops.modifiedFiles.join("\n") || "",
    "</modified-files>",
  ].join("\n");
}

function formatToolCallForDigest(call: ModelToolCall): string {
  const name = call.function.name;
  const local = toolLocalName(name);
  const args = parseArgsObject(call.function.arguments);
  const paths: string[] = [];
  collectPathsFromValue(args, paths);

  if (local === "shell_exec" || local === "bash" || local === "shell") {
    const cmd = typeof args.command === "string" ? args.command : "";
    const short = cmd.length > 180 ? `${cmd.slice(0, 180)}…` : cmd;
    return `tool ${name}: shell ${JSON.stringify(short)}`;
  }
  if (local === "apply_patch" && Array.isArray(args.patches)) {
    const ps = (args.patches as unknown[])
      .map((p) => {
        if (p && typeof p === "object" && typeof (p as { path?: unknown }).path === "string") {
          return (p as { path: string }).path;
        }
        return null;
      })
      .filter(Boolean)
      .slice(0, 12);
    return `tool ${name}: patch [${ps.join(", ")}]`;
  }
  if (paths.length) {
    const extra: string[] = [];
    if (typeof args.old_text === "string") {
      extra.push(`old=${JSON.stringify(args.old_text.slice(0, 60))}`);
    }
    if (typeof args.pattern === "string") {
      extra.push(`pattern=${JSON.stringify(args.pattern.slice(0, 80))}`);
    }
    return `tool ${name}: ${paths.join(", ")}${extra.length ? ` ${extra.join(" ")}` : ""}`;
  }
  const raw = call.function.arguments.slice(0, SUMMARY_ARG_CHARS);
  return `tool ${name}: ${raw}`;
}

function toolResultDigest(name: string | undefined, content: string, limit: number): string {
  const label = name ?? "?";
  const t = content.trim();
  if (!t) return `[${label}] (empty)`;
  // 文件读结果：保留头尾线索，避免整文件塞进摘要素材
  if (/fs_read|read_file|^read$/i.test(label) && t.length > limit) {
    const head = t.slice(0, Math.floor(limit * 0.65));
    const tail = t.slice(-Math.floor(limit * 0.25));
    return `[${label}] ${head}\n…(${t.length} 字，已截断)…\n${tail}`;
  }
  if (t.length <= limit) return `[${label}] ${t}`;
  return `[${label}] ${t.slice(0, limit)}…(+${t.length - limit})`;
}

/** 从 shell/工具结果抽失败信号（exit code、error、FAIL 等） */
export function extractFailureSignals(
  messages: ModelChatMessage[],
  limit = 8,
): Array<{ tool: string; signal: string }> {
  const out: Array<{ tool: string; signal: string }> = [];
  for (const m of messages) {
    if (m.role !== "tool" || !m.content) continue;
    const name = m.name ?? "tool";
    const text = m.content;
    const local = toolLocalName(name);
    const isShell = /shell|bash|exec/i.test(local);
    const failed =
      isShell &&
      (/exit[_ ]?code["\s:=]+(?!0)\d+/i.test(text) ||
        /\bcode["\s:=]+(?!0)\d+/i.test(text) ||
        /\berror\b/i.test(text) ||
        /\bFAIL(ED)?\b/.test(text) ||
        /\bError:/i.test(text) ||
        /non-zero/i.test(text));
    const looksFail =
      failed ||
      (/\b(Error|error|FAILED|failed|Traceback|panic:)/.test(text) && text.length > 40);
    if (!looksFail) continue;
    // 优先截取含 error/exit 的行
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const hit =
      lines.find((l) => /error|exit|FAIL|Traceback|panic/i.test(l)) ?? lines[0] ?? text;
    out.push({
      tool: name,
      signal: hit.trim().slice(0, 220),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Coding 向对话摘要素材：
 * - 文首附确定性文件轨迹（read/modified）
 * - 工具调用突出 path/command，而非原始 JSON 倾倒
 * - 工具结果短摘，读文件结果头尾截断
 */
export function buildCompactionDigest(
  messages: ModelChatMessage[],
  opts?: { previousOps?: CompactionFileOps | null; maxChars?: number },
): string {
  const extracted = extractFileOpsFromMessages(messages);
  const ops = mergeFileOps(opts?.previousOps, extracted);
  const failures = extractFailureSignals(messages);
  const maxChars = opts?.maxChars ?? 30_000;

  const lines: string[] = [
    "# 文件轨迹（确定性抽取，摘要时必须合并进「代码状态」）",
    formatFileOpsBlock(ops),
  ];
  if (failures.length) {
    lines.push(
      "",
      "# 失败/验证信号（确定性抽取，写入「验证与命令」或阻塞）",
      ...failures.map((f) => `- [${f.tool}] ${f.signal}`),
    );
  }
  lines.push("", "# 对话流水");

  for (const m of messages) {
    if (m.role === "user") {
      lines.push(`## 用户\n${messageTextForSummary(m, 1_200)}`);
      continue;
    }
    if (m.role === "assistant") {
      const body: string[] = [];
      if (m.content?.trim()) body.push(m.content.trim().slice(0, 900));
      if (m.toolCalls?.length) {
        body.push(...m.toolCalls.map((c) => formatToolCallForDigest(c)));
      }
      lines.push(body.length ? `## 助手\n${body.join("\n")}` : "## 助手\n(无文本)");
      continue;
    }
    if (m.role === "tool") {
      lines.push(`### 工具结果\n${toolResultDigest(m.name, m.content ?? "", 320)}`);
    }
  }
  return lines.join("\n\n").slice(0, maxChars);
}

/**
 * 压缩用 system 提示：强制 coding 结构化输出（对齐 Pi 的 Goal/Progress/文件列表思路）。
 */
export function buildCompactionSystemPrompt(input?: {
  previousSummary?: string;
  previousOps?: CompactionFileOps | null;
}): string {
  const structure = [
    "你是 coding agent 的上下文压缩器。把对话压缩成**可继续写代码**的结构化中文摘要。",
    "必须严格使用以下 Markdown 结构（无内容的节写「无」；不要输出结构之外的前言/后记）：",
    "",
    "## 目标",
    "（用户要完成什么）",
    "",
    "## 约束与偏好",
    "- …",
    "",
    "## 进度",
    "### 已完成",
    "- [x] …",
    "### 进行中",
    "- [ ] …",
    "### 阻塞",
    "- …",
    "",
    "## 关键决策",
    "- **决策**: 理由",
    "",
    "## 下一步",
    "1. …",
    "",
    "## 关键上下文",
    "- 错误原文、API/接口约定、端口与配置值、符号名、测试失败要点（不要大段贴代码）",
    "",
    "## 代码状态",
    "### 已读文件",
    "- path",
    "### 已改文件",
    "- path",
    "### 验证与命令",
    "- `command` → 结果要点",
    "",
    "然后原样附上机器可读标签（路径每行一个，可与上方列表一致）：",
    "<read-files>",
    "path",
    "</read-files>",
    "<modified-files>",
    "path",
    "</modified-files>",
    "",
    "规则：",
    "- 优先保留：用户目标、文件路径、符号/API 名、错误信息、未完成改动、接口与配置约定",
    "- 丢弃：寒暄、重复工具原文、整文件内容、与任务无关的探索噪音",
    "- 文件列表必须合并「已有摘要 + 对话流水文首的确定性抽取」，去重保序",
    `- 总长控制在 ${COMPACTION_SUMMARY_MAX_CHARS} 字以内；结构完整优先于文笔`,
    "- 直接输出摘要正文",
  ].join("\n");

  const prev = input?.previousSummary?.trim();
  if (!prev) return structure;

  const prevOps = mergeFileOps(
    input?.previousOps,
    parseFileOpsFromSummary(prev),
  );
  return [
    structure,
    "",
    "# 已有摘要（请与下方新对话合并，不要丢弃仍有效的决策/文件/阻塞）",
    prev.slice(0, 4_000),
    "",
    "# 已有文件轨迹",
    formatFileOpsBlock(prevOps),
  ].join("\n");
}

/**
 * 注入主对话 system 前：确保摘要带文件轨迹，并附 coding 续写指引。
 */
export function formatHistorySummaryForPrompt(
  summary: string,
  details?: CompactionFileOps | null,
): string {
  const text = summary.trim();
  if (!text) return "";
  const ops = mergeFileOps(details, parseFileOpsFromSummary(text));
  const hasCodeSection = /##\s*代码状态/.test(text) || /<read-files>/.test(text);
  const body =
    hasCodeSection || (ops.readFiles.length === 0 && ops.modifiedFiles.length === 0)
      ? text
      : `${text}\n\n## 代码状态\n${formatFileOpsBlock(ops)}`;

  return [
    "以下摘要替代更早的完整对话。继续编码时：",
    "- 已改/已读文件以摘要为准；改之前用工具重新读取确认当前内容（摘要可能滞后）",
    "- 优先处理「进行中 / 阻塞 / 下一步」",
    "- 不要推翻「关键决策」除非用户明确要求",
    "",
    body,
  ].join("\n");
}

/** 从 context_compacted payload 宽容解析文件轨迹 */
export function fileOpsFromCompactionPayload(
  payload: Record<string, unknown> | null | undefined,
): CompactionFileOps {
  if (!payload) return { ...EMPTY_FILE_OPS };
  const details = payload.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const d = details as Record<string, unknown>;
    const reads = Array.isArray(d.readFiles)
      ? d.readFiles.filter((x): x is string => typeof x === "string")
      : [];
    const mods = Array.isArray(d.modifiedFiles)
      ? d.modifiedFiles.filter((x): x is string => typeof x === "string")
      : [];
    if (reads.length || mods.length) {
      return mergeFileOps({ readFiles: reads, modifiedFiles: mods });
    }
  }
  if (typeof payload.summary === "string") {
    return parseFileOpsFromSummary(payload.summary);
  }
  return { ...EMPTY_FILE_OPS };
}

/**
 * 进入模型前：封顶单条工具结果，并在超预算时分级压缩旧工具输出。
 * 就地修改 messages，返回被改动的条数。
 *
 * 分级策略：
 * 1) 所有 tool 内容 > maxToolResultChars → 头尾保留截断
 * 2) 总量 > inLoopChars → 从旧到新把 tool 压到 ~400 字
 * 3) 仍超 threshold → 再压到 ~150 字，并截短 assistant 里过长的 tool 参数
 */
export function compactToolResultsInPlace(
  messages: ModelChatMessage[],
  budget?: Partial<CompactBudget> | null,
): number {
  const b = resolveCompactBudget(budget);
  let compacted = 0;

  for (const m of messages) {
    if (m.role === "tool" && m.content && m.content.length > b.maxToolResultChars) {
      m.content = shrinkText(m.content, b.maxToolResultChars, "工具结果截断");
      compacted += 1;
    }
  }

  if (approxMessagesChars(messages) <= b.inLoopChars) return compacted;

  for (const m of messages) {
    if (approxMessagesChars(messages) <= b.thresholdChars) break;
    if (m.role === "tool" && m.content && m.content.length > 500) {
      m.content = shrinkText(m.content, 400, "旧工具结果已压缩");
      compacted += 1;
    }
  }

  if (approxMessagesChars(messages) <= b.thresholdChars) return compacted;

  for (const m of messages) {
    if (approxMessagesChars(messages) <= b.thresholdChars) break;
    if (m.role === "tool" && m.content && m.content.length > 160) {
      m.content = shrinkText(m.content, 150, "深度压缩");
      compacted += 1;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      for (const c of m.toolCalls) {
        if (c.function.arguments.length > 800) {
          c.function.arguments = shrinkText(c.function.arguments, 600, "参数压缩");
          compacted += 1;
        }
      }
    }
  }

  return compacted;
}

/**
 * 历史进入模型前的预处理：先做工具结果预算控制。
 * 返回压缩条数，便于日志。
 */
export function prepareHistoryForModel(
  messages: ModelChatMessage[],
  budget?: Partial<CompactBudget> | null,
): number {
  return compactToolResultsInPlace(messages, budget);
}

/**
 * 将消息链压缩为可供「续聊 / 复用」的纯文本摘要素材（不调用 LLM）。
 * 长会话可先 digest 再交给 summarizeMessages。
 */
export function buildSessionReuseDigest(
  messages: ModelChatMessage[],
  opts?: { maxChars?: number; keepRecent?: number },
): { digest: string; recent: ModelChatMessage[]; olderCount: number } {
  const keepRecent = opts?.keepRecent ?? COMPACT_KEEP_RECENT;
  const maxChars = opts?.maxChars ?? 24_000;
  const recent = messages.slice(-keepRecent);
  const older = messages.slice(0, Math.max(0, messages.length - recent.length));
  const digest = buildCompactionDigest(older.length ? older : messages).slice(0, maxChars);
  return { digest, recent, olderCount: older.length };
}
