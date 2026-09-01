/**
 * 把 ACP session/update 映射到 Cloud Agent 事件流。
 */
import type { CloudAgentSessionStore } from "../cloud-agent-session.js";

/**
 * ACP 1.3 ContentBlock。字段名对齐官方 SDK schema（TextContent / ImageContent /
 * AudioContent / ResourceLink / EmbeddedResource）。
 *
 * 之前这里被窄化成 `{ type?: string; text?: string }`，导致 agent 发来的图片、
 * 文件链接、内嵌资源在进入事件流之前就被丢成空串——UI 上表现为「消息凭空消失」。
 */
export type AcpContentBlock = {
  type?: string;
  /** text */
  text?: string;
  /** image / audio：base64 数据 */
  data?: string;
  mimeType?: string;
  /** resource_link */
  uri?: string;
  name?: string;
  title?: string;
  description?: string;
  size?: number;
  /** resource：内嵌资源本体 */
  resource?: {
    uri?: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
};

export type AcpSessionUpdate = {
  sessionUpdate?: string;
  messageId?: string;
  name?: string;
  content?: AcpContentBlock | AcpContentBlock[];
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
  /** terminal_update / terminal_output_chunk */
  terminalId?: string;
  output?: string;
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

/**
 * 把任意 ContentBlock 渲染成可读文本。
 *
 * ACP 允许 agent 在一条消息里混合文本、图片、文件链接和内嵌资源。事件流本身是
 * 文本增量协议，所以非文本块在这里降级成 Markdown 表示：图片走 data URI（前端
 * 能直接渲染），资源链接走标准链接语法，内嵌文本资源保留正文并标注来源。
 * 无法表达的块（如音频）至少留下一行占位，而不是让整条消息凭空消失。
 */
export function renderAcpContentBlock(block: AcpContentBlock | undefined): string {
  if (!block) return "";
  const type = block.type;
  if (type === "text") return block.text ?? "";
  if (type === "image") {
    const mime = block.mimeType || "image/png";
    const label = block.title || block.name || "image";
    if (block.data) return `![${label}](data:${mime};base64,${block.data})`;
    if (block.uri) return `![${label}](${block.uri})`;
    return `[${label}]`;
  }
  if (type === "audio") {
    const label = block.title || block.name || "audio";
    const mime = block.mimeType || "audio/*";
    return block.uri ? `[🔊 ${label}](${block.uri})` : `[🔊 ${label} (${mime})]`;
  }
  if (type === "resource_link") {
    const label = block.title || block.name || block.uri || "resource";
    return block.uri ? `[${label}](${block.uri})` : `[${label}]`;
  }
  if (type === "resource") {
    const res = block.resource;
    if (!res) return "";
    const label = block.title || block.name || res.uri || "resource";
    if (typeof res.text === "string" && res.text) {
      const lang = mimeToFence(res.mimeType);
      return `**${label}**\n\n\`\`\`${lang}\n${res.text}\n\`\`\``;
    }
    if (res.blob && res.mimeType?.startsWith("image/")) {
      return `![${label}](data:${res.mimeType};base64,${res.blob})`;
    }
    return res.uri ? `[${label}](${res.uri})` : `[${label}]`;
  }
  // 未知类型：优先回退到 text 字段，避免新协议版本导致内容静默丢失
  return block.text ?? "";
}

function mimeToFence(mime: string | undefined): string {
  if (!mime) return "";
  if (mime.includes("json")) return "json";
  if (mime.includes("javascript")) return "javascript";
  if (mime.includes("typescript")) return "typescript";
  if (mime.includes("python")) return "python";
  if (mime.includes("markdown")) return "markdown";
  if (mime.includes("html")) return "html";
  if (mime.includes("xml")) return "xml";
  if (mime.includes("yaml")) return "yaml";
  if (mime.startsWith("text/")) return "";
  return "";
}

/** 归一化 content：ACP 既可能发单个块，也可能发数组。 */
export function renderAcpContent(
  content: AcpContentBlock | AcpContentBlock[] | undefined,
): string {
  if (!content) return "";
  if (Array.isArray(content)) {
    return content.map((b) => renderAcpContentBlock(b)).filter(Boolean).join("");
  }
  return renderAcpContentBlock(content);
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
    const text = renderAcpContent(update.content);
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
    const text = renderAcpContent(update.content);
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
  // --- ACP 1.3 补全：以下类型此前会落到末尾的静默 return {}，内容直接丢失 ---
  if (kind === "agent_message" || kind === "agent_thought") {
    // 非流式整块投递：部分 agent 只发这个，不发 *_chunk
    const text = renderAcpContent(update.content);
    if (!text) return {};
    const thought = kind === "agent_thought";
    await store.appendEvent({
      sessionId,
      type: thought ? "reasoning_delta" : "assistant_delta",
      runId,
      payload: {
        messageId: thought ? ids.thoughtMessageId : ids.assistantMessageId,
        delta: text,
      },
    });
    return { runStatus: thought ? "thinking" : "streaming" };
  }
  if (kind === "user_message" || kind === "user_message_chunk") {
    // agent 回显的用户消息。不落成 assistant 内容，否则会污染助手气泡；
    // 以 run_log 记录，保证多轮上下文可追溯。
    const text = renderAcpContent(update.content);
    if (!text) return {};
    await store.appendEvent({
      sessionId,
      type: "run_log",
      runId,
      payload: { runId, level: "debug", message: "ACP 用户消息回显", data: { text } },
    });
    return {};
  }
  if (kind === "tool_call_content_chunk") {
    const toolCallId = update.toolCallId;
    const text = renderAcpContent(update.content);
    if (!toolCallId || !text) return {};
    await store.appendEvent({
      sessionId,
      type: "tool_call_progress",
      runId,
      payload: { toolCallId, message: text },
    });
    return { runStatus: "tool" };
  }
  if (kind === "terminal_update" || kind === "terminal_output_chunk") {
    const text = renderAcpContent(update.content) || update.output || "";
    if (!text) return {};
    await store.appendEvent({
      sessionId,
      type: "run_log",
      runId,
      payload: {
        runId,
        level: "info",
        message: text,
        data: update.terminalId ? { terminalId: update.terminalId } : undefined,
      },
    });
    return { runStatus: "tool" };
  }
  if (kind === "plan_removed") {
    await store.appendEvent({
      sessionId,
      type: "acp_plan",
      runId,
      payload: { entries: [] },
    });
    return {};
  }
  if (kind === "state_update") {
    if (update.configOptions !== undefined) {
      return { configOptions: update.configOptions };
    }
    const modeId = update.currentModeId?.trim();
    if (modeId) {
      await store.appendEvent({
        sessionId,
        type: "session_update",
        runId,
        payload: { acpModeId: modeId },
      });
      return { modeId };
    }
    return {};
  }
  return {};
}
