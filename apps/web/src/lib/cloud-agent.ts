"use client";

import type {
  CloudAgentAttachment,
  CloudAgentConfig,
  CloudAgentEvent,
  CloudAgentRunStatus,
} from "@zakura/shared";
import { api } from "@/lib/api";

export type { CloudAgentAttachment };

export type CloudSession = {
  id: string;
  agentId: string;
  title: string;
  status: string;
  lastSeq: number;
  activeRunId: string | null;
  createdAt: string;
  updatedAt: string;
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

/** 将事件日志还原为 UI 时间线（多设备重连后可确定性重建） */
export function eventsToTimeline(events: CloudAgentEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const toolMap = new Map<string, TimelineToolCall>();
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

  for (const ev of events) {
    const p = ev.payload as Record<string, unknown>;
    if (ev.type === "user_message") {
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
    if (ev.type === "assistant_delta") {
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
      flushAssistant();
      const id = typeof p.toolCallId === "string" ? p.toolCallId : ev.id;
      const call: TimelineToolCall = {
        toolCallId: id,
        name: typeof p.name === "string" ? p.name : "tool",
        title: typeof p.title === "string" ? p.title : undefined,
        status: "running",
      };
      toolMap.set(id, call);
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
    if (ev.type === "run_error") {
      flushAssistant();
      items.push({
        kind: "error",
        id: ev.id,
        message: typeof p.message === "string" ? p.message : "未知错误",
        seq: ev.seq,
      });
    }
  }
  flushAssistant();
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
        ev.type === "assistant_message" ||
        ev.type === "assistant_rollback" ||
        ev.type === "tool_call_start" ||
        ev.type === "tool_call_args" ||
        ev.type === "tool_call_result" ||
        ev.type === "run_status" ||
        ev.type === "run_error" ||
        ev.type === "memory_updated")
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

export async function listCloudSessions(agentId: string) {
  return api<{ sessions: CloudSession[] }>(`/api/agents/${agentId}/cloud/sessions`, {
    cacheTtlMs: false,
  });
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
) {
  const json: Record<string, unknown> = { content };
  if (parentRunId !== undefined) json.parentRunId = parentRunId;
  if (attachments?.length) json.attachments = attachments;
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
) {
  return api<{ runId: string }>(
    `/api/agents/${agentId}/cloud/sessions/${sessionId}/regenerate`,
    { method: "POST", json: messageId ? { messageId } : {} },
  );
}

export async function cancelCloudRun(agentId: string, sessionId: string, runId?: string) {
  return api<{ ok: boolean }>(`/api/agents/${agentId}/cloud/sessions/${sessionId}/cancel`, {
    method: "POST",
    json: { runId },
  });
}

/** 失败后重试：不追加用户消息，基于现有历史重新运行 */
export async function retryCloudRun(agentId: string, sessionId: string) {
  return api<{ runId: string }>(`/api/agents/${agentId}/cloud/sessions/${sessionId}/retry`, {
    method: "POST",
    json: {},
  });
}

export async function updateCloudSession(
  agentId: string,
  sessionId: string,
  patch: { title?: string; status?: "active" | "archived" },
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

export type ChatModelOption = { alias: string; name: string; upstream?: string };

/** 可用 chat 模型（模型路由 alias 去重） */
export async function listChatModels(): Promise<ChatModelOption[]> {
  try {
    const res = await api<{
      routes: Array<{
        alias?: string;
        name?: string;
        enabled?: boolean;
        upstream?: { name?: string } | null;
      }>;
    }>(`/api/model-routes?capability=chat`);
    const seen = new Set<string>();
    const out: ChatModelOption[] = [];
    for (const r of res.routes ?? []) {
      const alias = r.alias?.trim();
      if (!alias || seen.has(alias) || r.enabled === false) continue;
      seen.add(alias);
      out.push({ alias, name: r.name || alias, upstream: r.upstream?.name });
    }
    return out;
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
  cloud: Omit<CloudAgentConfig, "maxToolRounds" | "model"> & {
    /** null 表示清除限制 */
    maxToolRounds?: number | null;
    /** 空串/undefined 表示恢复默认路由 */
    model?: string | null;
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
