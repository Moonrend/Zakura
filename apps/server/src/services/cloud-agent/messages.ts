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
      messages.push({
        role: "user",
        content: typeof p.content === "string" ? p.content : "",
      });
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
        `tool_call ${call.function.name}: ${call.function.arguments.slice(0, limit)}`,
      );
    }
  }
  return chunks.join("\n").slice(0, limit);
}

export function buildCompactionDigest(messages: ModelChatMessage[]): string {
  return messages
    .map((m) => `${m.role}: ${messageTextForSummary(m)}`)
    .join("\n")
    .slice(0, 30_000);
}

/**
 * 循环内上下文超预算时就地压缩较旧的工具结果，返回压缩条数。
 * 只截断 tool 消息正文，不动 user/assistant 内容。
 */
export function compactToolResultsInPlace(messages: ModelChatMessage[]): number {
  if (approxMessagesChars(messages) <= INLOOP_COMPACT_CHARS) return 0;
  let compacted = 0;
  for (const m of messages) {
    if (approxMessagesChars(messages) <= COMPACT_THRESHOLD_CHARS) break;
    if (m.role === "tool" && m.content && m.content.length > 500) {
      m.content = `${m.content.slice(0, 400)}\n…(旧工具结果已压缩)`;
      compacted += 1;
    }
  }
  return compacted;
}
