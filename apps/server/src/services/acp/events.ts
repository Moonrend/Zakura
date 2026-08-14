/**
 * 把 ACP session/update 映射到 Cloud Agent 事件流。
 */
import type { CloudAgentSessionStore } from "../cloud-agent-session.js";

export type AcpSessionUpdate = {
  sessionUpdate?: string;
  messageId?: string;
  name?: string;
  content?: { type?: string; text?: string };
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  entries?: Array<{ content?: string; status?: string; priority?: string }>;
  used?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    thoughtTokens?: number;
  };
  availableCommands?: Array<{ name?: string; description?: string }>;
  currentModeId?: string;
  configOptions?: unknown;
  contentBlocks?: unknown;
  locations?: Array<{ path?: string }>;
};

export type AcpDiff = { path: string; oldText?: string; newText: string };

const ACP_KIND_TO_NAME: Record<string, string> = {
  read: "fs_read",
  edit: "fs_write",
  write: "fs_write",
  delete: "fs_delete",
  move: "fs_move",
  search: "search",
  execute: "shell_exec",
  fetch: "web_fetch",
  think: "think",
  switch_mode: "switch_mode",
};

export function acpToolName(update: Pick<AcpSessionUpdate, "name" | "kind" | "title">): string | undefined {
  const programmatic = update.name?.trim();
  if (programmatic && programmatic.toLowerCase() !== "other") return programmatic;
  const kind = update.kind?.trim();
  if (kind && kind !== "other" && ACP_KIND_TO_NAME[kind]) return ACP_KIND_TO_NAME[kind];
  const title = update.title?.trim();
  if (title) return title;
  if (kind && kind !== "other") return kind;
  return undefined;
}

function strField(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

export function acpToolArguments(update: AcpSessionUpdate): string | undefined {
  const loc = update.locations?.find((l) => l.path?.trim())?.path?.trim();
  let raw = update.rawInput;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return JSON.stringify(loc ? { command: raw, path: loc } : { command: raw });
    }
  }
  if (raw === undefined || raw === null) {
    return loc ? JSON.stringify({ path: loc }) : undefined;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return JSON.stringify(loc ? { value: raw, path: loc } : { value: raw });
  }
  const o = { ...(raw as Record<string, unknown>) };
  const path = strField(o, "path", "file_path", "filePath", "target_file", "targetFile");
  const command = strField(o, "command", "cmd");
  const query = strField(o, "query", "q", "pattern");
  const url = strField(o, "url", "uri");
  if (path && o.path === undefined) o.path = path;
  if (command && o.command === undefined) o.command = command;
  if (query && o.query === undefined) o.query = query;
  if (url && o.url === undefined) o.url = url;
  if (loc && o.path === undefined) o.path = loc;
  return JSON.stringify(o);
}

export function extractAcpDiffs(content: unknown): AcpDiff[] {
  if (!Array.isArray(content)) return [];
  const out: AcpDiff[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o.type !== "diff" || typeof o.path !== "string" || typeof o.newText !== "string") continue;
    out.push({
      path: o.path,
      newText: o.newText,
      ...(typeof o.oldText === "string" ? { oldText: o.oldText } : {}),
    });
  }
  return out;
}

function formatDiff(d: AcpDiff): string {
  const old = (d.oldText ?? "").slice(0, 4000);
  const next = d.newText.slice(0, 4000);
  return `--- ${d.path}\n${old}\n+++ ${d.path}\n${next}`;
}

export type AcpUpdateSideEffect = {
  commands?: Array<{ name: string; description?: string }>;
  modeId?: string;
  configOptions?: unknown;
  sessionTitle?: string;
  rotateAssistant?: boolean;
  runStatus?: "thinking" | "streaming" | "tool";
};

async function appendToolResult(
  store: CloudAgentSessionStore,
  sessionId: string,
  runId: string,
  update: AcpSessionUpdate,
  toolCallId: string,
): Promise<void> {
  const diffs = extractAcpDiffs(update.contentBlocks ?? update.content);
  let resultText =
    update.rawOutput !== undefined
      ? typeof update.rawOutput === "string"
        ? update.rawOutput
        : JSON.stringify(update.rawOutput)
      : update.title || "";
  if (!resultText && diffs.length) resultText = diffs.map(formatDiff).join("\n\n");
  const name = acpToolName(update);
  await store.appendEvent({
    sessionId,
    type: "tool_call_result",
    runId,
    payload: {
      toolCallId,
      name: name || "tool",
      isError: update.status === "failed",
      resultText: resultText.slice(0, 12_000),
      durationMs: 0,
      ...(diffs.length ? { diffs } : {}),
    },
  });
}

export async function appendAcpUpdate(
  store: CloudAgentSessionStore,
  sessionId: string,
  runId: string,
  update: AcpSessionUpdate,
  ids: { assistantMessageId: string; thoughtMessageId: string },
): Promise<AcpUpdateSideEffect> {
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk") {
    const text = update.content?.type === "text" ? update.content.text : "";
    if (!text) return {};
    await store.appendEvent({
      sessionId,
      type: "assistant_delta",
      runId,
      payload: { messageId: ids.assistantMessageId, delta: text },
    });
    return { runStatus: "streaming" };
  }
  if (kind === "agent_thought_chunk") {
    const text = update.content?.type === "text" ? update.content.text : "";
    if (!text) return {};
    await store.appendEvent({
      sessionId,
      type: "reasoning_delta",
      runId,
      payload: { messageId: ids.thoughtMessageId, delta: text },
    });
    return { runStatus: "thinking" };
  }
  if (kind === "tool_call") {
    const toolCallId = update.toolCallId || `acp_${Date.now()}`;
    await store.appendEvent({
      sessionId,
      type: "tool_call_start",
      runId,
      payload: {
        toolCallId,
        name: acpToolName(update) || "tool",
        title: update.title,
      },
    });
    const args = acpToolArguments(update);
    if (args) {
      await store.appendEvent({
        sessionId,
        type: "tool_call_args",
        runId,
        payload: { toolCallId, arguments: args },
      });
    }
    if (update.status === "completed" || update.status === "failed") {
      await appendToolResult(store, sessionId, runId, update, toolCallId);
    }
    return { rotateAssistant: true, runStatus: "tool" };
  }
  if (kind === "tool_call_update") {
    const toolCallId = update.toolCallId;
    if (!toolCallId) return {};
    const diffs = extractAcpDiffs(update.contentBlocks ?? update.content);
    if (update.status === "completed" || update.status === "failed") {
      await appendToolResult(store, sessionId, runId, update, toolCallId);
    } else if (update.title || update.rawOutput || diffs.length) {
      await store.appendEvent({
        sessionId,
        type: "tool_call_progress",
        runId,
        payload: {
          toolCallId,
          message: update.title,
        },
      });
    }
    return { runStatus: "tool" };
  }
  if (kind === "plan" || kind === "plan_update") {
    await store.appendEvent({
      sessionId,
      type: "acp_plan",
      runId,
      payload: {
        entries: (update.entries ?? []).map((e) => ({
          content: e.content ?? "",
          status: e.status,
          priority: e.priority,
        })),
      },
    });
    return {};
  }
  if (kind === "usage_update") {
    const used = update.used ?? {};
    await store.appendEvent({
      sessionId,
      type: "run_log",
      runId,
      payload: {
        runId,
        level: "info",
        message: "ACP 用量",
        data: { cost: used },
      },
    });
    return {};
  }
  if (kind === "available_commands_update") {
    const commands = (update.availableCommands ?? [])
      .filter((c): c is { name: string; description?: string } => Boolean(c.name))
      .map((c) => ({ name: c.name, description: c.description }));
    await store.appendEvent({
      sessionId,
      type: "session_update",
      runId,
      payload: { acpCommands: commands },
    });
    return { commands };
  }
  if (kind === "current_mode_update") {
    const modeId = update.currentModeId?.trim();
    if (!modeId) return {};
    await store.appendEvent({
      sessionId,
      type: "session_update",
      runId,
      payload: { acpModeId: modeId },
    });
    return { modeId };
  }
  if (kind === "config_option_update") {
    if (update.configOptions === undefined) return {};
    return { configOptions: update.configOptions };
  }
  if (kind === "session_info_update") {
    const sessionTitle = update.title?.trim();
    return sessionTitle ? { sessionTitle } : {};
  }
  return {};
}

export async function flushAssistantMessage(
  store: CloudAgentSessionStore,
  sessionId: string,
  runId: string,
  messageId: string,
  content: string,
): Promise<void> {
  if (!content) return;
  await store.appendEvent({
    sessionId,
    type: "assistant_message",
    runId,
    payload: { messageId, content },
  });
}
