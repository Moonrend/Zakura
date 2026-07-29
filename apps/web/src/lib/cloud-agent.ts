"use client";

import type {
  CloudAgentAttachment,
  CloudAgentConfig,
  CloudAgentContextSourceItem,
  CloudAgentContextSourceKind,
  CloudAgentEvent,
  CloudAgentRunOptions,
  CloudAgentRunStatus,
  CloudAgentSessionKind,
  CloudAgentSessionOrigin,
} from "@zakura/shared";
import { api } from "@/lib/api";

export type {
  CloudAgentAttachment,
  CloudAgentContextSourceItem,
  CloudAgentContextSourceKind,
  CloudAgentSessionKind,
  CloudAgentSessionOrigin,
};

/** 会话类型过滤参数：类型数组或 "all"；缺省=仅 chat */
export type SessionKindsFilter = CloudAgentSessionKind[] | "all";

export type CloudSession = {
  id: string;
  agentId: string;
  title: string;
  status: string;
  /** 会话类型标记：chat（用户对话）| subagent（子代理）| delegate（委派）| system */
  kind: CloudAgentSessionKind;
  /** 来源链接：父会话/父 Run/调用方 Agent（非 chat 会话） */
  origin: CloudAgentSessionOrigin;
  lastSeq: number;
  activeRunId: string | null;
  createdAt: string;
  updatedAt: string;
};

export const SESSION_KIND_LABELS: Record<CloudAgentSessionKind, string> = {
  chat: "对话",
  subagent: "子代理",
  delegate: "委派",
  system: "系统",
};

export type TimelineToolCall = {
  toolCallId: string;
  name: string;
  title?: string;
  arguments?: string;
  resultText?: string;
  isError?: boolean;
  durationMs?: number;
  status: "running" | "done";
  /** 本次调用派生的子会话（子代理/委派运行记录），可跳转查看完整对话 */
  childSessionId?: string;
  /** 子会话所属 Agent（委派时为目标 Agent） */
  childAgentId?: string;
};

export type TimelineMemoryItem = {
  id?: string;
  content: string;
  layer?: string;
};

export type RunLogEntry = {
  id: string;
  seq: number;
  runId: string | null;
  level: "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
  createdAt: string;
};

export type TimelineItem =
  | {
      kind: "user";
      id: string;
      content: string;
      seq: number;
      attachments?: CloudAgentAttachment[];
    }
  | {
      kind: "assistant";
      id: string;
      content: string;
      final: boolean;
      seq: number;
      runId?: string | null;
    }
  | {
      kind: "reasoning";
      id: string;
      content: string;
      final: boolean;
      seq: number;
      runId?: string | null;
    }
  | { kind: "tool"; id: string; call: TimelineToolCall; seq: number }
  | {
      kind: "status";
      id: string;
      status: CloudAgentRunStatus;
      detail?: string;
      seq: number;
      runId?: string | null;
    }
  | { kind: "memory"; id: string; items: TimelineMemoryItem[]; seq: number }
  /** 系统注入的上下文来源（记忆召回、摘要等）；UI 汇总到「来源」按钮 */
  | { kind: "sources"; id: string; items: CloudAgentContextSourceItem[]; seq: number }
  | { kind: "error"; id: string; message: string; seq: number };

function parseTimelineAttachments(raw: unknown): CloudAgentAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: CloudAgentAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.path !== "string" || !o.path) continue;
    out.push({
      name:
        typeof o.name === "string" && o.name ? o.name : o.path.split("/").pop() || o.path,
      path: o.path,
      mime: typeof o.mime === "string" ? o.mime : "application/octet-stream",
      size: typeof o.size === "number" ? o.size : 0,
      kind: o.kind === "image" ? "image" : "file",
    });
  }
  return out;
}

const SOURCE_KINDS = new Set<string>([
  "memory",
  "file",
  "search",
  "web",
  "summary",
  "other",
]);

function parseContextSourceItems(raw: unknown): CloudAgentContextSourceItem[] {
  if (!Array.isArray(raw)) return [];
  const out: CloudAgentContextSourceItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.title !== "string" || !o.title.trim()) continue;
    const kind =
      typeof o.kind === "string" && SOURCE_KINDS.has(o.kind)
        ? (o.kind as CloudAgentContextSourceKind)
        : "other";
    const entry: CloudAgentContextSourceItem = {
      kind,
      title: o.title.trim().slice(0, 200),
    };
    if (typeof o.content === "string" && o.content) entry.content = o.content;
    if (typeof o.path === "string" && o.path) entry.path = o.path;
    if (typeof o.url === "string" && o.url) entry.url = o.url;
    if (typeof o.id === "string" && o.id) entry.id = o.id;
    if (typeof o.layer === "string" && o.layer) entry.layer = o.layer;
    out.push(entry);
  }
  return out;
}

function tryParseToolArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toolArgStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function truncateText(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 从信息检索类工具调用派生「来源」条目（读文件 / 搜索 / 抓取 / 记忆检索） */
function deriveSourceFromTool(
  call: TimelineToolCall,
): CloudAgentContextSourceItem | null {
  if (call.status !== "done" || call.isError) return null;
  const name = call.name.replace(/^re_/, "");
  const args = tryParseToolArgs(call.arguments);
  const snippet = call.resultText
    ? truncateText(call.resultText.trim(), 400)
    : undefined;

  if (name === "fs_read" || name === "fs_stat") {
    const path = toolArgStr(args.path);
    if (!path) return null;
    return {
      kind: "file",
      title: path.split("/").pop() || path,
      path,
      ...(snippet ? { content: snippet } : {}),
    };
  }

  if (
    /^(memory_|search_memory|list_memories|get_memory|memory_context)/.test(name) &&
    !/^(add_memory|update_memory|delete_memory|pin_memory)/.test(name)
  ) {
    const q = toolArgStr(args.query) || toolArgStr(args.q) || toolArgStr(args.content);
    return {
      kind: "memory",
      title: q ? `记忆检索 “${truncateText(q, 40)}”` : "记忆检索",
      ...(snippet ? { content: snippet } : {}),
    };
  }

  const query = toolArgStr(args.query) || toolArgStr(args.q);
  if (query && /search/i.test(name)) {
    return {
      kind: "search",
      title: `搜索 “${truncateText(query, 60)}”`,
      ...(snippet ? { content: snippet } : {}),
    };
  }

  const url = toolArgStr(args.url);
  if (url && /fetch|crawl|scrape|read_url|web_fetch/i.test(name)) {
    return {
      kind: "web",
      title: truncateText(url, 80),
      url,
      ...(snippet ? { content: snippet } : {}),
    };
  }

  return null;
}

/**
 * 汇总本回合「来源」：系统注入（记忆/摘要）+ 工具检索到的材料。
 * 去重键优先 path/url/id，否则 title+content 前缀。
 */
export function collectTurnSources(
  items: TimelineItem[],
): CloudAgentContextSourceItem[] {
  const out: CloudAgentContextSourceItem[] = [];
  const seen = new Set<string>();
  const push = (item: CloudAgentContextSourceItem) => {
    const key =
      item.path ||
      item.url ||
      item.id ||
      `${item.kind}:${item.title}:${(item.content ?? "").slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  for (const it of items) {
    if (it.kind === "sources") {
      for (const s of it.items) push(s);
    } else if (it.kind === "tool") {
      const derived = deriveSourceFromTool(it.call);
      if (derived) push(derived);
    }
  }
  return out;
}

/** Agent 通过 get_file_url 生成的可下载分享文件（UI 附件卡片） */
export type SharedFileAttachment = {
  shareId: string;
  url: string;
  path: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  disposition: "inline" | "attachment";
  expiresAt?: string;
  toolCallId: string;
};

function tryParseJsonObject(raw?: string): Record<string, unknown> | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // resultText 可能前后夹杂说明文字，尝试截取首个 JSON 对象
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** 解析 get_file_url / re_get_file_url 工具结果为分享附件 */
export function parseSharedFileFromTool(
  call: TimelineToolCall,
): SharedFileAttachment | null {
  if (call.status !== "done" || call.isError) return null;
  const name = call.name.replace(/^re_/, "");
  if (name !== "get_file_url") return null;
  const o = tryParseJsonObject(call.resultText);
  if (!o) return null;
  const url = typeof o.url === "string" ? o.url.trim() : "";
  if (!url) return null;
  const path =
    (typeof o.path === "string" && o.path) ||
    toolArgStr(tryParseToolArgs(call.arguments).path) ||
    "";
  const fileName =
    (typeof o.file_name === "string" && o.file_name) ||
    (typeof o.fileName === "string" && o.fileName) ||
    (path ? path.split("/").pop() : "") ||
    "file";
  const mimeType =
    (typeof o.mime_type === "string" && o.mime_type) ||
    (typeof o.mimeType === "string" && o.mimeType) ||
    "application/octet-stream";
  const sizeRaw = o.size_bytes ?? o.sizeBytes;
  const sizeBytes = typeof sizeRaw === "number" && sizeRaw >= 0 ? sizeRaw : 0;
  const shareId =
    (typeof o.share_id === "string" && o.share_id) ||
    (typeof o.shareId === "string" && o.shareId) ||
    call.toolCallId;
  const disposition = o.disposition === "inline" ? "inline" : "attachment";
  const expiresAt =
    typeof o.expires_at === "string"
      ? o.expires_at
      : typeof o.expiresAt === "string"
        ? o.expiresAt
        : undefined;
  return {
    shareId,
    url,
    path,
    fileName,
    mimeType,
    sizeBytes,
    disposition,
    expiresAt,
    toolCallId: call.toolCallId,
  };
}

/** 汇总本回合 Agent 通过 get_file_url 分享的文件（去重 by shareId/url） */
export function collectTurnSharedFiles(
  items: TimelineItem[],
): SharedFileAttachment[] {
  const out: SharedFileAttachment[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (it.kind !== "tool") continue;
    const file = parseSharedFileFromTool(it.call);
    if (!file) continue;
    const key = file.shareId || file.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

/** 将事件日志还原为 UI 时间线（多设备重连后可确定性重建） */
export function eventsToTimeline(events: CloudAgentEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const toolMap = new Map<string, TimelineToolCall>();
  /** toolCallId → 所属 runId，用于 Run 结束时只收尾自己的工具调用 */
  const toolRunIds = new Map<string, string | null>();
  /** 被 assistant_rollback 丢弃的流式消息（模型中断重试），其 delta 不渲染 */
  const rolledBack = new Set<string>();
  for (const ev of events) {
    if (ev.type === "assistant_rollback") {
      const p = ev.payload as Record<string, unknown>;
      if (typeof p.messageId === "string") rolledBack.add(p.messageId);
    }
  }
  let currentAssistant: {
    id: string;
    content: string;
    seq: number;
    runId: string | null;
    final: boolean;
  } | null = null;
  let currentReasoning: {
    id: string;
    content: string;
    seq: number;
    runId: string | null;
    final: boolean;
  } | null = null;

  const flushAssistant = () => {
    if (!currentAssistant) return;
    items.push({
      kind: "assistant",
      id: currentAssistant.id,
      content: currentAssistant.content,
      final: currentAssistant.final,
      seq: currentAssistant.seq,
      runId: currentAssistant.runId,
    });
    currentAssistant = null;
  };
  const flushReasoning = () => {
    if (!currentReasoning) return;
    items.push({
      kind: "reasoning",
      id: currentReasoning.id,
      content: currentReasoning.content,
      final: currentReasoning.final,
      seq: currentReasoning.seq,
      runId: currentReasoning.runId,
    });
    currentReasoning = null;
  };

  for (const ev of events) {
    const p = ev.payload as Record<string, unknown>;
    if (ev.type === "user_message") {
      flushReasoning();
      flushAssistant();
      const attachments = parseTimelineAttachments(p.attachments);
      items.push({
        kind: "user",
        id: typeof p.messageId === "string" ? p.messageId : ev.id,
        content: typeof p.content === "string" ? p.content : "",
        seq: ev.seq,
        ...(attachments.length ? { attachments } : {}),
      });
      continue;
    }
    if (ev.type === "reasoning_delta") {
      const mid = typeof p.messageId === "string" ? p.messageId : ev.id;
      if (rolledBack.has(mid)) continue;
      if (!currentReasoning || currentReasoning.id !== mid) {
        flushReasoning();
        currentReasoning = {
          id: mid,
          content: "",
          seq: ev.seq,
          runId: ev.runId,
          final: false,
        };
      }
      if (typeof p.delta === "string") currentReasoning.content += p.delta;
      continue;
    }
    if (ev.type === "assistant_delta") {
      flushReasoning();
      const mid = typeof p.messageId === "string" ? p.messageId : ev.id;
      if (rolledBack.has(mid)) continue;
      if (!currentAssistant || currentAssistant.id !== mid) {
        flushAssistant();
        currentAssistant = {
          id: mid,
          content: "",
          seq: ev.seq,
          runId: ev.runId,
          final: false,
        };
      }
      if (typeof p.delta === "string") currentAssistant.content += p.delta;
      continue;
    }
    if (ev.type === "assistant_message") {
      flushReasoning();
      const mid = typeof p.messageId === "string" ? p.messageId : ev.id;
      if (rolledBack.has(mid)) continue;
      if (!currentAssistant || currentAssistant.id !== mid) {
        flushAssistant();
        currentAssistant = {
          id: mid,
          content: "",
          seq: ev.seq,
          runId: ev.runId,
          final: true,
        };
      }
      if (typeof p.content === "string") currentAssistant.content = p.content;
      currentAssistant.final = true;
      flushAssistant();
      continue;
    }
    if (ev.type === "tool_call_start") {
      flushReasoning();
      flushAssistant();
      const id = typeof p.toolCallId === "string" ? p.toolCallId : ev.id;
      const call: TimelineToolCall = {
        toolCallId: id,
        name: typeof p.name === "string" ? p.name : "tool",
        title: typeof p.title === "string" ? p.title : undefined,
        status: "running",
      };
      toolMap.set(id, call);
      toolRunIds.set(id, ev.runId);
      items.push({ kind: "tool", id, call, seq: ev.seq });
      continue;
    }
    if (ev.type === "tool_call_args") {
      const id = typeof p.toolCallId === "string" ? p.toolCallId : "";
      const call = toolMap.get(id);
      if (call && typeof p.arguments === "string") call.arguments = p.arguments;
      continue;
    }
    if (ev.type === "tool_call_result") {
      const id = typeof p.toolCallId === "string" ? p.toolCallId : "";
      const call = toolMap.get(id);
      if (call) {
        call.status = "done";
        call.isError = p.isError === true;
        call.resultText = typeof p.resultText === "string" ? p.resultText : "";
        call.durationMs = typeof p.durationMs === "number" ? p.durationMs : undefined;
        if (typeof p.name === "string") call.name = p.name;
        if (typeof p.childSessionId === "string") call.childSessionId = p.childSessionId;
        if (typeof p.childAgentId === "string") call.childAgentId = p.childAgentId;
      }
      continue;
    }
    if (ev.type === "run_status") {
      items.push({
        kind: "status",
        id: ev.id,
        status: (typeof p.status === "string" ? p.status : "thinking") as CloudAgentRunStatus,
        detail: typeof p.detail === "string" ? p.detail : undefined,
        seq: ev.seq,
        runId: ev.runId,
      });
      continue;
    }
    if (ev.type === "memory_updated") {
      const raw = Array.isArray(p.items) ? (p.items as unknown[]) : [];
      const items2: TimelineMemoryItem[] = [];
      for (const it of raw) {
        if (!it || typeof it !== "object") continue;
        const o = it as Record<string, unknown>;
        if (typeof o.content !== "string") continue;
        items2.push({
          id: typeof o.id === "string" ? o.id : undefined,
          content: o.content,
          layer: typeof o.layer === "string" ? o.layer : undefined,
        });
      }
      if (items2.length) {
        items.push({ kind: "memory", id: ev.id, items: items2, seq: ev.seq });
      }
      continue;
    }
    if (ev.type === "context_sources") {
      const parsed = parseContextSourceItems(p.items);
      if (parsed.length) {
        items.push({ kind: "sources", id: ev.id, items: parsed, seq: ev.seq });
      }
      continue;
    }
    if (ev.type === "run_error") {
      flushReasoning();
      flushAssistant();
      items.push({
        kind: "error",
        id: ev.id,
        message: typeof p.message === "string" ? p.message : "未知错误",
        seq: ev.seq,
      });
      continue;
    }
    // Run 结束：把该 Run 里仍挂着的工具调用收尾，避免永远显示「运行中」
    // （服务端已为取消补发结果事件；这里兜底历史数据与进程中断的情况）
    if (ev.type === "run_end") {
      const status = typeof p.status === "string" ? p.status : "";
      if (status === "completed") continue;
      for (const [id, call] of toolMap) {
        if (call.status !== "running") continue;
        if (toolRunIds.get(id) !== ev.runId) continue;
        call.status = "done";
        call.isError = true;
        call.resultText =
          status === "cancelled"
            ? "（已取消：该工具调用未完成）"
            : "（该工具调用未完成：运行已中断）";
      }
    }
  }
  flushAssistant();
  flushReasoning();
  return items;
}

// —— 消息树（分支 / 重新生成变体） ——

export type ConversationSelection = {
  /** userMessageId → 选中的回答变体 runId */
  variantByMessage: Record<string, string>;
  /** 父节点（parentRunId；"" 表示根）→ 选中的子用户消息 id */
  branchByParent: Record<string, string>;
};

export type ConversationTurn = {
  message: { id: string; content: string; seq: number; parentKey: string };
  /** 兄弟用户消息 id（含自身，seq 升序） */
  siblings: string[];
  siblingIndex: number;
  /** 回答本消息的 Run 变体（seq 升序） */
  variants: string[];
  variantIndex: number;
  activeRunId: string | null;
  /** 当前变体的时间线条目（首条为 user） */
  items: TimelineItem[];
};

/**
 * 将事件流还原为当前分支路径上的回合序列。
 * 旧事件缺少 parentRunId / replyToMessageId 时按 seq 线性推断（与服务端一致）。
 * 未显式选择时，默认走最新的分支 / 最新的变体。
 */
export function buildConversationTurns(
  events: CloudAgentEvent[],
  selection?: Partial<ConversationSelection>,
): ConversationTurn[] {
  type UserNode = {
    id: string;
    content: string;
    seq: number;
    parentKey: string;
    event: CloudAgentEvent;
  };
  const userMsgs = new Map<string, UserNode>();
  const childrenByParent = new Map<string, string[]>();
  const runsByReply = new Map<string, string[]>();
  const eventsByRun = new Map<string, CloudAgentEvent[]>();
  let lastRunId: string | null = null;
  let lastUserMessageId: string | null = null;

  for (const ev of events) {
    const p = ev.payload as Record<string, unknown>;
    if (ev.type === "user_message") {
      const mid = typeof p.messageId === "string" ? p.messageId : ev.id;
      const parentKey =
        "parentRunId" in p
          ? typeof p.parentRunId === "string"
            ? p.parentRunId
            : ""
          : (lastRunId ?? "");
      const node: UserNode = {
        id: mid,
        content: typeof p.content === "string" ? p.content : "",
        seq: ev.seq,
        parentKey,
        event: ev,
      };
      userMsgs.set(mid, node);
      const list = childrenByParent.get(parentKey) ?? [];
      list.push(mid);
      childrenByParent.set(parentKey, list);
      lastUserMessageId = mid;
      continue;
    }
    if (ev.type === "run_start") {
      const rid = ev.runId ?? (typeof p.runId === "string" ? p.runId : null);
      if (!rid) continue;
      const replyTo =
        typeof p.replyToMessageId === "string" ? p.replyToMessageId : lastUserMessageId;
      if (replyTo) {
        const list = runsByReply.get(replyTo) ?? [];
        if (!list.includes(rid)) list.push(rid);
        runsByReply.set(replyTo, list);
      }
      lastRunId = rid;
      continue;
    }
    if (
      ev.runId &&
      (ev.type === "assistant_delta" ||
        ev.type === "reasoning_delta" ||
        ev.type === "assistant_message" ||
        ev.type === "assistant_rollback" ||
        ev.type === "tool_call_start" ||
        ev.type === "tool_call_args" ||
        ev.type === "tool_call_result" ||
        ev.type === "run_status" ||
        ev.type === "run_error" ||
        ev.type === "memory_updated" ||
        ev.type === "context_sources")
    ) {
      const list = eventsByRun.get(ev.runId) ?? [];
      list.push(ev);
      eventsByRun.set(ev.runId, list);
    }
  }

  const variantSel = selection?.variantByMessage ?? {};
  const branchSel = selection?.branchByParent ?? {};
  const turns: ConversationTurn[] = [];
  let parentKey = "";
  const guard = new Set<string>();

  for (;;) {
    const siblings = childrenByParent.get(parentKey) ?? [];
    if (siblings.length === 0) break;
    const chosenId =
      branchSel[parentKey] && siblings.includes(branchSel[parentKey]!)
        ? branchSel[parentKey]!
        : siblings[siblings.length - 1]!;
    if (guard.has(chosenId)) break;
    guard.add(chosenId);
    const node = userMsgs.get(chosenId);
    if (!node) break;

    const variants = runsByReply.get(chosenId) ?? [];
    const activeRunId =
      variantSel[chosenId] && variants.includes(variantSel[chosenId]!)
        ? variantSel[chosenId]!
        : (variants[variants.length - 1] ?? null);

    const turnEvents = [node.event, ...(activeRunId ? (eventsByRun.get(activeRunId) ?? []) : [])];
    turns.push({
      message: { id: node.id, content: node.content, seq: node.seq, parentKey },
      siblings,
      siblingIndex: siblings.indexOf(chosenId),
      variants,
      variantIndex: activeRunId ? variants.indexOf(activeRunId) : -1,
      activeRunId,
      items: eventsToTimeline(turnEvents),
    });

    if (!activeRunId) break;
    parentKey = activeRunId;
  }
  return turns;
}

/** 提取运行日志（供日志抽屉展示） */
export function eventsToRunLogs(events: CloudAgentEvent[]): RunLogEntry[] {
  const logs: RunLogEntry[] = [];
  for (const ev of events) {
    if (ev.type !== "run_log") continue;
    const p = ev.payload as Record<string, unknown>;
    logs.push({
      id: ev.id,
      seq: ev.seq,
      runId: ev.runId,
      level: p.level === "warn" || p.level === "error" ? p.level : "info",
      message: typeof p.message === "string" ? p.message : "",
      data:
        p.data && typeof p.data === "object"
          ? (p.data as Record<string, unknown>)
          : undefined,
      createdAt: ev.createdAt,
    });
  }
  return logs;
}

export async function listCloudSessions(
  agentId: string,
  opts?: { kinds?: SessionKindsFilter },
) {
  const params = new URLSearchParams();
  if (opts?.kinds) {
    params.set("kinds", opts.kinds === "all" ? "all" : opts.kinds.join(","));
  }
  const qs = params.toString();
  return api<{ sessions: CloudSession[] }>(
    `/api/agents/${agentId}/cloud/sessions${qs ? `?${qs}` : ""}`,
    { cacheTtlMs: false },
  );
}

export async function createCloudSession(agentId: string, title?: string) {
  return api<CloudSession>(`/api/agents/${agentId}/cloud/sessions`, {
    method: "POST",
    json: { title },
  });
}

export async function getCloudSession(agentId: string, sessionId: string, afterSeq = 0) {
  return api<{ session: CloudSession; events: CloudAgentEvent[] }>(
    `/api/agents/${agentId}/cloud/sessions/${sessionId}?afterSeq=${afterSeq}`,
    { cacheTtlMs: false },
  );
}

export async function deleteCloudSession(agentId: string, sessionId: string) {
  return api(`/api/agents/${agentId}/cloud/sessions/${sessionId}`, { method: "DELETE" });
}

export async function sendCloudMessage(
  agentId: string,
  sessionId: string,
  content: string,
  parentRunId?: string | null,
  attachments?: CloudAgentAttachment[],
  options?: CloudAgentRunOptions,
) {
  const json: Record<string, unknown> = { content };
  if (parentRunId !== undefined) json.parentRunId = parentRunId;
  if (attachments?.length) json.attachments = attachments;
  if (options && Object.keys(options).length > 0) json.options = options;
  return api<{ runId: string }>(`/api/agents/${agentId}/cloud/sessions/${sessionId}/messages`, {
    method: "POST",
    json,
  });
}

/** 重新生成某条用户消息的回答（缺省为最后一条）；产生新的变体 */
export async function regenerateCloudRun(
  agentId: string,
  sessionId: string,
  messageId?: string,
  options?: CloudAgentRunOptions,
) {
  const json: Record<string, unknown> = {};
  if (messageId) json.messageId = messageId;
  if (options && Object.keys(options).length > 0) json.options = options;
  return api<{ runId: string }>(
    `/api/agents/${agentId}/cloud/sessions/${sessionId}/regenerate`,
    { method: "POST", json },
  );
}

export async function cancelCloudRun(agentId: string, sessionId: string, runId?: string) {
  return api<{ ok: boolean }>(`/api/agents/${agentId}/cloud/sessions/${sessionId}/cancel`, {
    method: "POST",
    json: { runId },
  });
}

/** 失败后重试：不追加用户消息，基于现有历史重新运行 */
export async function retryCloudRun(
  agentId: string,
  sessionId: string,
  options?: CloudAgentRunOptions,
) {
  return api<{ runId: string }>(`/api/agents/${agentId}/cloud/sessions/${sessionId}/retry`, {
    method: "POST",
    json: options && Object.keys(options).length > 0 ? { options } : {},
  });
}

export async function updateCloudSession(
  agentId: string,
  sessionId: string,
  patch: {
    title?: string;
    status?: "active" | "archived";
    /** 重新打类型标记 */
    kind?: CloudAgentSessionKind;
  },
) {
  return api<CloudSession>(`/api/agents/${agentId}/cloud/sessions/${sessionId}`, {
    method: "PATCH",
    json: patch,
  });
}

export type CloudSearchHit = CloudSession & {
  snippet: string | null;
  agentName: string | null;
  agentSlug: string | null;
};

/** 跨 Agent 会话搜索（标题+内容） */
export async function searchCloudSessions(q: string, agentId?: string) {
  const params = new URLSearchParams({ q });
  if (agentId) params.set("agentId", agentId);
  return api<{ results: CloudSearchHit[] }>(`/api/cloud/search?${params.toString()}`, {
    cacheTtlMs: false,
  });
}

export type ChatModelOption = {
  alias: string;
  name: string;
  upstream?: string;
  isDefault?: boolean;
  reasoning?: boolean;
  reasoningLevels?: string[];
  defaultReasonLevel?: string;
};

function intersectStringSets(values: string[][]): string[] | undefined {
  if (values.length === 0) return undefined;
  const display = new Map<string, string>();
  for (const v of values.flat()) {
    const text = String(v).trim();
    if (text) display.set(text.toLowerCase(), text);
  }
  let acc = new Set((values[0] ?? []).map((v) => String(v).trim().toLowerCase()).filter(Boolean));
  for (const list of values.slice(1)) {
    const next = new Set(list.map((v) => String(v).trim().toLowerCase()).filter(Boolean));
    acc = new Set([...acc].filter((v) => next.has(v)));
  }
  return [...acc].map((v) => display.get(v) ?? v);
}

/** 可用 chat 模型（模型路由 alias 去重） */
export async function listChatModels(): Promise<ChatModelOption[]> {
  try {
    const res = await api<{
      routes: Array<{
        alias?: string;
        name?: string;
        enabled?: boolean;
        isDefault?: boolean;
        meta?: {
          reasoning?: boolean;
          reasoningLevels?: string[];
          defaultReasonLevel?: string;
        };
        upstream?: { name?: string } | null;
      }>;
    }>(`/api/model-routes?capability=chat`);
    const byAlias = new Map<
      string,
      {
        alias: string;
        name: string;
        upstreams: string[];
        isDefault: boolean;
        reasoningFlags: boolean[];
        levels: string[][];
        defaultReasonLevel?: string;
      }
    >();
    for (const r of res.routes ?? []) {
      const alias = r.alias?.trim();
      if (!alias || r.enabled === false) continue;
      const entry =
        byAlias.get(alias) ??
        {
          alias,
          name: r.name || alias,
          upstreams: [],
          isDefault: false,
          reasoningFlags: [],
          levels: [],
        };
      if (r.name && entry.name === alias) entry.name = r.name;
      if (r.upstream?.name && !entry.upstreams.includes(r.upstream.name)) {
        entry.upstreams.push(r.upstream.name);
      }
      if (r.isDefault) entry.isDefault = true;
      if (typeof r.meta?.reasoning === "boolean") {
        entry.reasoningFlags.push(r.meta.reasoning);
      }
      if (Array.isArray(r.meta?.reasoningLevels)) {
        entry.levels.push(r.meta.reasoningLevels.map(String).filter(Boolean));
      }
      if (!entry.defaultReasonLevel && r.meta?.defaultReasonLevel) {
        entry.defaultReasonLevel = r.meta.defaultReasonLevel;
      }
      byAlias.set(alias, entry);
    }
    return [...byAlias.values()].map((entry) => {
      const reasoningLevels = intersectStringSets(entry.levels);
      return {
        alias: entry.alias,
        name: entry.name,
        upstream: entry.upstreams.join(", ") || undefined,
        isDefault: entry.isDefault,
        reasoning:
          entry.reasoningFlags.length > 0
            ? entry.reasoningFlags.every(Boolean)
            : reasoningLevels
              ? reasoningLevels.length > 0
              : undefined,
        reasoningLevels,
        defaultReasonLevel: entry.defaultReasonLevel,
      };
    });
  } catch {
    return [];
  }
}

export async function getCloudConfig(agentId: string) {
  return api<{ cloud: CloudAgentConfig; hasChatRoute: boolean }>(
    `/api/agents/${agentId}/cloud/config`,
  );
}

export async function saveCloudConfig(
  agentId: string,
  cloud: Partial<
    Omit<CloudAgentConfig, "maxToolRounds" | "model" | "maxSubagentDepth">
  > & {
    /** null 表示清除限制 */
    maxToolRounds?: number | null;
    /** 空串/undefined 表示恢复默认路由 */
    model?: string | null;
    /** null/0 恢复默认嵌套深度（2） */
    maxSubagentDepth?: number | null;
  },
) {
  return api<{ cloud: CloudAgentConfig }>(`/api/agents/${agentId}/cloud/config`, {
    method: "PUT",
    json: cloud,
  });
}

function getSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("zakura_session");
}

/**
 * 带鉴权的 SSE（fetch + ReadableStream），支持 afterSeq 续传。
 * 返回 unsubscribe。
 */
export function subscribeCloudEvents(
  agentId: string,
  sessionId: string,
  afterSeq: number,
  handlers: {
    onEvent: (ev: CloudAgentEvent) => void;
    onReady?: (afterSeq: number) => void;
    onError?: (message: string) => void;
  },
): () => void {
  const ctrl = new AbortController();
  let closed = false;

  void (async () => {
    try {
      const token = getSessionToken();
      const res = await fetch(
        `/api/agents/${agentId}/cloud/sessions/${sessionId}/events?afterSeq=${afterSeq}`,
        {
          headers: {
            Accept: "text/event-stream",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: ctrl.signal,
        },
      );
      if (!res.ok || !res.body) {
        handlers.onError?.(`SSE ${res.status}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.trim() || part.startsWith(":")) continue;
          let eventName = "message";
          const dataLines: string[] = [];
          for (const line of part.split("\n")) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (!dataLines.length) continue;
          try {
            const data = JSON.parse(dataLines.join("\n")) as unknown;
            if (eventName === "cloud") {
              handlers.onEvent(data as CloudAgentEvent);
            } else if (eventName === "ready") {
              const ready = data as { afterSeq?: number };
              handlers.onReady?.(ready.afterSeq ?? afterSeq);
            } else if (eventName === "error") {
              const err = data as { message?: string };
              handlers.onError?.(err.message ?? "stream error");
            }
          } catch {
            /* ignore malformed */
          }
        }
      }
    } catch (err) {
      if (closed || (err instanceof DOMException && err.name === "AbortError")) return;
      handlers.onError?.(err instanceof Error ? err.message : String(err));
    }
  })();

  return () => {
    closed = true;
    ctrl.abort();
  };
}
