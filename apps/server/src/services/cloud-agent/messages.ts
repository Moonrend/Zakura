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
import { newId } from "../../db/schema.js";

/** 历史消息总字符数超过该值触发摘要压缩 */
export const COMPACT_THRESHOLD_CHARS = 60_000;
/** 压缩时保留的最近消息条数 */
export const COMPACT_KEEP_RECENT = 12;
/** 循环内消息总量超过该值时就地压缩旧工具结果 */
export const INLOOP_COMPACT_CHARS = 90_000;
/** 单条工具结果默认上限（进入模型前） */
export const MAX_TOOL_RESULT_CHARS = 12_000;
/** 工具参数摘要上限（摘要 digest 用） */
export const SUMMARY_ARG_CHARS = 400;

export type CompactBudget = {
  thresholdChars: number;
  keepRecent: number;
  inLoopChars: number;
  maxToolResultChars: number;
};

export const DEFAULT_COMPACT_BUDGET: CompactBudget = {
  thresholdChars: COMPACT_THRESHOLD_CHARS,
  keepRecent: COMPACT_KEEP_RECENT,
  inLoopChars: INLOOP_COMPACT_CHARS,
  maxToolResultChars: MAX_TOOL_RESULT_CHARS,
};

/** 从 CloudAgentConfig / 调用方覆盖解析压缩预算 */
export function resolveCompactBudget(overrides?: Partial<CompactBudget> | null): CompactBudget {
  const o = overrides ?? {};
  return {
    thresholdChars:
      typeof o.thresholdChars === "number" && o.thresholdChars >= 8_000
        ? Math.floor(o.thresholdChars)
        : DEFAULT_COMPACT_BUDGET.thresholdChars,
    keepRecent:
      typeof o.keepRecent === "number" && o.keepRecent >= 4
        ? Math.min(Math.floor(o.keepRecent), 48)
        : DEFAULT_COMPACT_BUDGET.keepRecent,
    inLoopChars:
      typeof o.inLoopChars === "number" && o.inLoopChars >= 12_000
        ? Math.floor(o.inLoopChars)
        : DEFAULT_COMPACT_BUDGET.inLoopChars,
    maxToolResultChars:
      typeof o.maxToolResultChars === "number" && o.maxToolResultChars >= 1_000
        ? Math.min(Math.floor(o.maxToolResultChars), 80_000)
        : DEFAULT_COMPACT_BUDGET.maxToolResultChars,
  };
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
  for (const m of messages) {
    n += (m.content?.length ?? 0) + 40;
    if (m.toolCalls) {
      for (const c of m.toolCalls) n += c.function.arguments.length + c.function.name.length + 20;
    }
  }
  return n;
}

export function messageTextForSummary(message: ModelChatMessage, limit = 600): string {
  const chunks: string[] = [];
  if (message.content) chunks.push(message.content);
  if (message.toolCalls?.length) {
    for (const call of message.toolCalls) {
      chunks.push(
        `tool_call ${call.function.name}: ${call.function.arguments.slice(0, SUMMARY_ARG_CHARS)}`,
      );
    }
  }
  if (message.role === "tool" && message.name) {
    return `[${message.name}] ${chunks.join("\n")}`.slice(0, limit);
  }
  return chunks.join("\n").slice(0, limit);
}

/**
 * 结构化对话摘要素材：优先保留 user/assistant 结论，工具结果只留短摘。
 */
export function buildCompactionDigest(messages: ModelChatMessage[]): string {
  const lines: string[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]!;
    if (m.role === "user") {
      lines.push(`## 用户\n${messageTextForSummary(m, 1_200)}`);
      continue;
    }
    if (m.role === "assistant") {
      const tools = m.toolCalls?.map((c) => c.function.name).join(", ");
      const body = messageTextForSummary(m, 900);
      lines.push(tools ? `## 助手（调用: ${tools}）\n${body}` : `## 助手\n${body}`);
      continue;
    }
    if (m.role === "tool") {
      lines.push(`### 工具 ${m.name ?? "?"}\n${messageTextForSummary(m, 280)}`);
    }
  }
  return lines.join("\n\n").slice(0, 30_000);
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
