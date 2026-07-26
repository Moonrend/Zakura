/**
 * Cloud Agent 推理循环（agent loop）：
 * - 自动注入 Agent MCP 工具面 + 结构化系统提示词
 * - 经模型路由流式调用，增量写入持久事件流供多设备同步
 * - 自动记忆：运行前召回相关记忆，运行后提取新记忆（类 ChatGPT）
 * - 上下文管理：超长历史自动摘要压缩
 * - 多 Agent：delegate_to_agent 将子任务委派给同租户其他 Agent
 */
import {
  isCreateTaskResult,
  parseCloudAgentConfig,
  type CloudAgentAttachment,
  type CloudAgentConfig,
  type ModelChatContentPart,
  type ModelChatMessage,
  type ModelToolCall,
  type ModelToolDefinition,
} from "@zakura/shared";
import type { WorkspaceFsProvider, WorkspaceFs } from "@zakura/core";
import type { Agent } from "../db/schema.js";
import { newId } from "../db/schema.js";
import {
  SUBAGENT_TOOL_QUALIFIED,
  type McpGateway,
  type ResolvedTool,
} from "./mcp-gateway.js";
import { mapConcurrent } from "../model-router/http.js";
import type { ModelRouterService } from "./model-router.js";
import type { AgentService } from "./agents.js";
import type { CloudAgentSessionStore } from "./cloud-agent-session.js";
import { getAgentMcpMode, getAgentProviders } from "./agent-providers.js";
import type { MemoryStore } from "./memory-store.js";
import { MEMORY_LAYERS } from "./memory-store.js";
import type { MemoryProvidersService } from "./memory-providers.js";
import {
  buildMemoryContext,
  resolveAgentMemory,
  type ResolvedMemory,
} from "./memory-runtime.js";
import { withEmbedding } from "./memory-embed.js";
import { Mem0Client } from "./mem0-client.js";

const RESULT_TEXT_LIMIT = 12_000;
/** 历史消息总字符数超过该值触发摘要压缩 */
const COMPACT_THRESHOLD_CHARS = 60_000;
/** 压缩时保留的最近消息条数 */
const COMPACT_KEEP_RECENT = 12;
/** 循环内消息总量超过该值时就地压缩旧工具结果 */
const INLOOP_COMPACT_CHARS = 90_000;
const DELEGATE_TOOL_NAME = "delegate_to_agent";
const OPENAI_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function sanitizeToolName(name: string): string {
  if (OPENAI_TOOL_NAME_RE.test(name)) return name;
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return cleaned || "tool";
}

function mcpResultToText(result: unknown): { text: string; isError: boolean } {
  if (isCreateTaskResult(result)) {
    return {
      text: JSON.stringify({ task: result.task }, null, 2),
      isError: false,
    };
  }
  if (!result || typeof result !== "object") {
    return { text: String(result ?? ""), isError: false };
  }
  const r = result as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
  };
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const c of r.content) {
      if (c && typeof c.text === "string") parts.push(c.text);
    }
  }
  if (r.structuredContent !== undefined) {
    parts.push(JSON.stringify(r.structuredContent, null, 2));
  }
  let text = parts.join("\n").trim() || JSON.stringify(result);
  if (text.length > RESULT_TEXT_LIMIT) {
    text = `${text.slice(0, RESULT_TEXT_LIMIT)}\n…(截断)`;
  }
  return { text, isError: r.isError === true };
}

function buildSystemPrompt(
  agent: Agent,
  cloud: CloudAgentConfig,
  extra?: {
    memoryContext?: string;
    historySummary?: string;
    peerAgents?: string;
    subagents?: boolean;
  },
): string {
  const providers = getAgentProviders(agent);
  const now = new Date();
  const lines = [
    `你是 Zakura 云端 Agent「${agent.name}」（slug: ${agent.slug}），运行在 Zakura 多 Agent 平台上。`,
    `当前时间：${now.toISOString()}。会话持久化保存，用户可能随时从其他设备继续。`,
    "",
    "# 工作方式",
    "- 遵循「理解目标 → 收集上下文 → 行动 → 验证 → 汇报」的循环。",
    "- 需要外部信息或执行操作时调用工具，不要假装已执行、不要凭空编造事实。",
    "- 简单问题直接回答，不必为回答本身调用工具。",
    "- 工具失败时先阅读错误信息再调整重试；同一方法连续失败两次应换思路或向用户说明。",
    "- 多步任务先用一两句话说明计划再执行；执行过程中的关键发现要在最终回复中体现。",
    "- 破坏性或不可逆操作（删除、覆盖、对外发送）前必须先向用户确认。",
    "",
    "# 能力",
    `- Computer / FS / Shell: ${agent.enableComputer ? "已启用" : "未启用"}`,
    `- Browser: ${agent.enableBrowser ? "已启用" : "未启用"}`,
    `- Memory: ${agent.enableMemory ? "已启用" : "未启用"}`,
    `- Web Search: ${providers.webSearch?.enabled ? "已启用" : "未启用"}`,
    `- Web Fetch: ${providers.webFetch?.enabled ? "已启用" : "未启用"}`,
    `- MCP 绑定模式: ${getAgentMcpMode(agent)}`,
  ];
  if (extra?.peerAgents) {
    lines.push(
      "",
      "# 协作",
      `可通过 ${DELEGATE_TOOL_NAME} 将独立子任务委派给以下同租户 Agent（它们有各自的工具与记忆）：`,
      extra.peerAgents,
    );
  }
  if (extra?.subagents) {
    lines.push(
      "",
      "# 子代理",
      `可用 ${SUBAGENT_TOOL_QUALIFIED} 在云端派生你自己的子代理处理独立子任务：它与你共享工作区与全部工具，但上下文完全隔离、用完即弃，只把最终结果带回来。`,
      "- 适用：可并行的独立子任务（同一轮内发起多个调用会自动并行执行）、需要大量中间探索但只需要结论的调研、避免冗长中间产物占用当前对话。",
      "- task 必须自包含：子代理看不到本对话与你的记忆，必要背景写进 context 参数。",
      "- 不适用：需要与用户往返确认的任务、强依赖当前对话隐含状态的任务。",
    );
  }
  lines.push(
    "",
    "# 回复风格",
    "- 用简洁、准确的中文回复（用户使用其他语言时跟随用户）。",
    "- 使用 Markdown 排版；代码放代码块。",
    "- 最终回复汇总结论与关键结果，不要倾倒原始 JSON 或全部中间过程。",
  );
  if (extra?.memoryContext) {
    lines.push(
      "",
      "# 记忆",
      "以下是平台自动召回的相关记忆（关于用户与过往交互），供参考：",
      extra.memoryContext,
      "",
      "记忆可能过时；与用户当前说法冲突时以用户为准。平台会在对话后自动提取新记忆，日常事实无需你调用记忆工具保存；需要精确检索时可使用 memory_* 工具。",
    );
  }
  if (extra?.historySummary) {
    lines.push("", "# 早前对话摘要", "更早的对话已压缩为以下摘要：", extra.historySummary);
  }
  if (cloud.systemPrompt?.trim()) {
    lines.push("", "# 自定义指令（优先级最高）", cloud.systemPrompt.trim());
  }
  return lines.join("\n");
}

/**
 * 子代理系统提示词：明确任务契约（范围、隔离、输出直达主代理）、
 * 工作方式与输出格式；Agent 自定义指令对子代理同样生效。
 */
function buildSubagentPrompt(
  agent: Agent,
  cloud: CloudAgentConfig,
  extra?: { expectedOutput?: string },
): string {
  const lines = [
    `你是 Zakura 云端 Agent「${agent.name}」派生的子代理（Subagent），为完成一个明确的子任务而临时创建，任务结束即销毁。`,
    `当前时间：${new Date().toISOString()}。`,
    "",
    "# 任务契约",
    "- 只完成用户消息中的「委派任务」本身：不扩展范围，不做任务之外的更改。",
    "- 你与主代理共享同一工作区与工具，但上下文完全隔离：看不到主对话与记忆，任务之外的信息一律用工具自行获取，不要臆测。",
    "- 你的最终回复会原样返回给主代理（用户不会直接阅读）：直接输出结果本身，不要寒暄、不要复述任务、不要输出与结果无关的过程叙述。",
    "- 无法完成时如实说明：阻塞原因、已尝试的方法、建议的下一步；绝不编造结果。",
    "",
    "# 工作方式",
    "- 先用工具收集事实再下结论；关键断言要有依据。",
    "- 工具失败先读错误信息再调整；同一方法连续失败两次应换思路。",
    "- 任务未明确授权时，不执行破坏性操作（删除、覆盖重要文件、对外发送内容）。",
    "",
    "# 输出要求",
    "- 用简洁中文输出（任务使用其他语言时跟随任务语言）。",
    extra?.expectedOutput
      ? `- 按主代理要求的格式输出：${extra.expectedOutput}`
      : "- 汇总结论与关键数据；有文件产出时给出工作区路径。",
  ];
  if (cloud.systemPrompt?.trim()) {
    lines.push("", "# Agent 自定义指令（对你同样生效）", cloud.systemPrompt.trim());
  }
  return lines.join("\n");
}

function toolsToDefinitions(tools: ResolvedTool[]): {
  definitions: ModelToolDefinition[];
  nameMap: Map<string, string>;
} {
  const nameMap = new Map<string, string>();
  const used = new Set<string>();
  const definitions: ModelToolDefinition[] = [];

  for (const t of tools) {
    let name = sanitizeToolName(t.qualifiedName);
    if (used.has(name)) {
      let i = 2;
      while (used.has(`${name.slice(0, 60)}_${i}`)) i += 1;
      name = `${name.slice(0, 60)}_${i}`;
    }
    used.add(name);
    nameMap.set(name, t.qualifiedName);
    definitions.push({
      type: "function",
      function: {
        name,
        description: t.description || t.title || t.qualifiedName,
        parameters:
          t.inputSchema && typeof t.inputSchema === "object"
            ? t.inputSchema
            : { type: "object", properties: {} },
      },
    });
  }
  return { definitions, nameMap };
}

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

type StoredEvent = { type: string; runId?: string | null; payload: Record<string, unknown> };

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

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 图片部件占位 URL 前缀：模型调用前由 WorkspaceFs 解析为 data URI */
const WORKSPACE_IMAGE_PREFIX = "workspace:";

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

function guessImageMime(path: string): string {
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
function patchOrphanToolCalls(messages: ModelChatMessage[]): void {
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

/** 从模型输出中解析记忆提取 JSON（容忍代码围栏与前后杂文） */
export function parseMemoryExtraction(
  text: string,
): Array<{ content: string; layer?: string; importance?: number; tags?: string[] }> {
  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) body = fence[1].trim();
  const start = body.search(/[[{]/);
  if (start < 0) return [];
  body = body.slice(start);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  if (end >= 0) body = body.slice(0, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { memories?: unknown }).memories)
      ? ((parsed as { memories: unknown[] }).memories)
      : [];
  const out: Array<{ content: string; layer?: string; importance?: number; tags?: string[] }> = [];
  for (const item of arr) {
    if (out.length >= 5) break;
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const content = typeof o.content === "string" ? o.content.trim() : "";
    if (!content || content.length > 600) continue;
    out.push({
      content,
      layer:
        typeof o.layer === "string" && (MEMORY_LAYERS as readonly string[]).includes(o.layer)
          ? o.layer
          : undefined,
      importance:
        typeof o.importance === "number" && o.importance >= 1 && o.importance <= 5
          ? Math.round(o.importance)
          : undefined,
      tags: Array.isArray(o.tags) ? o.tags.map(String).slice(0, 6) : undefined,
    });
  }
  return out;
}

function approxMessagesChars(messages: ModelChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += (m.content?.length ?? 0) + 40;
    if (m.toolCalls) {
      for (const c of m.toolCalls) n += c.function.arguments.length + c.function.name.length + 20;
    }
  }
  return n;
}

/** 增量文本发布器：合并小 delta，串行落库，避免每 token 一次事务 */
class DeltaPublisher {
  private buf = "";
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private emittedAny = false;

  constructor(
    private readonly store: CloudAgentSessionStore,
    private readonly sessionId: string,
    private readonly runId: string,
    readonly messageId: string,
  ) {}

  get emitted(): boolean {
    return this.emittedAny;
  }

  push(text: string): void {
    if (!text) return;
    this.emittedAny = true;
    this.buf += text;
    if (this.buf.length >= 120) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 250);
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const chunk = this.buf;
    this.buf = "";
    if (!chunk) return;
    this.chain = this.chain
      .then(() =>
        this.store.appendEvent({
          sessionId: this.sessionId,
          type: "assistant_delta",
          runId: this.runId,
          payload: { messageId: this.messageId, delta: chunk },
        }),
      )
      .catch((err) => {
        console.warn("[cloud-agent] delta publish failed:", err);
      });
  }

  async drain(): Promise<void> {
    this.flush();
    await this.chain;
  }
}

export type CloudAgentRuntimeDeps = {
  store: CloudAgentSessionStore;
  gateway: McpGateway;
  modelRouter: ModelRouterService;
  agentService: AgentService;
  /** 自动记忆依赖（可选；缺省时禁用自动记忆） */
  memoryStore?: MemoryStore | null;
  memoryProviders?: MemoryProvidersService | null;
  /** 工作区文件系统（可选；缺省时图片附件仅以文本注记传给模型） */
  workspaceFsProvider?: WorkspaceFsProvider | null;
};

export class CloudAgentRuntime {
  constructor(private readonly deps: CloudAgentRuntimeDeps) {}

  private get store() {
    return this.deps.store;
  }

  async startTurn(input: {
    tenantId: string;
    agentId: string;
    sessionId: string;
    content?: string;
    /** 分支父节点：新消息跟在哪个 Run 的回答后（null=根；缺省=线性推断） */
    parentRunId?: string | null;
    /** 重新生成：针对指定用户消息再跑一个变体（不追加新用户消息） */
    regenerateOfMessageId?: string;
    /** 重试：等价于重新生成最后一条用户消息 */
    retry?: boolean;
    /** 随消息上传的附件（已在 Agent 工作区） */
    attachments?: CloudAgentAttachment[];
  }): Promise<{ runId: string }> {
    const content = input.content?.trim() ?? "";
    const attachments = parseAttachments(input.attachments);
    const isRegenerate = Boolean(input.regenerateOfMessageId || input.retry);
    if (!isRegenerate && !content && attachments.length === 0) {
      throw new Error("消息不能为空");
    }

    const session = await this.store.getSession(
      input.tenantId,
      input.agentId,
      input.sessionId,
    );
    if (!session) throw new Error("会话不存在");
    if (session.activeRunId) throw new Error("当前会话已有进行中的 Run，请先等待或取消");

    const agent = await this.deps.agentService.get(input.tenantId, input.agentId);
    if (!agent) throw new Error("Agent 不存在");

    let targetMessageId: string;
    if (isRegenerate) {
      if (session.lastSeq === 0) throw new Error("会话为空，无法重新生成");
      const events = await this.store.listEvents(input.sessionId, { limit: 2000 });
      if (input.regenerateOfMessageId) {
        const found = events.some(
          (e) =>
            e.type === "user_message" &&
            (e.payload as Record<string, unknown>).messageId ===
              input.regenerateOfMessageId,
        );
        if (!found) throw new Error("目标用户消息不存在");
        targetMessageId = input.regenerateOfMessageId;
      } else {
        const lastUser = [...events]
          .reverse()
          .find((e) => e.type === "user_message");
        const mid = lastUser
          ? (lastUser.payload as Record<string, unknown>).messageId
          : null;
        if (typeof mid !== "string") throw new Error("会话中没有用户消息");
        targetMessageId = mid;
      }
    } else {
      targetMessageId = newId();
    }

    const isFirstTurn = session.lastSeq === 0;
    const run = await this.store.createRun(input.sessionId);

    if (!isRegenerate) {
      // 先用首条消息截断作临时标题，运行结束后再由模型润色
      if (isFirstTurn && session.title === "新对话") {
        const title = content.length > 40 ? `${content.slice(0, 40)}…` : content;
        await this.store.updateSession(input.tenantId, input.agentId, input.sessionId, {
          title,
        });
      }
      await this.store.appendEvent({
        sessionId: input.sessionId,
        type: "user_message",
        runId: run.id,
        payload: {
          messageId: targetMessageId,
          content,
          ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
          ...(attachments.length ? { attachments } : {}),
        },
      });
    }

    await this.store.appendEvent({
      sessionId: input.sessionId,
      type: "run_start",
      runId: run.id,
      payload: { runId: run.id, replyToMessageId: targetMessageId },
    });

    // 异步执行，HTTP 立即返回；客户端通过事件流接收结果
    void this.executeRun({
      tenantId: input.tenantId,
      agent,
      sessionId: input.sessionId,
      runId: run.id,
      targetMessageId,
      isFirstTurn,
    }).catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[cloud-agent] run failed:", message);
      try {
        await this.store.appendEvent({
          sessionId: input.sessionId,
          type: "run_error",
          runId: run.id,
          payload: { runId: run.id, message },
        });
        await this.store.appendEvent({
          sessionId: input.sessionId,
          type: "run_end",
          runId: run.id,
          payload: { runId: run.id, status: "failed" },
        });
        await this.store.finishRun(input.sessionId, run.id, "failed", message);
      } catch (e) {
        console.error("[cloud-agent] failed to record run error:", e);
      }
    });

    return { runId: run.id };
  }

  private async log(
    sessionId: string,
    runId: string,
    level: "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.store.appendEvent({
        sessionId,
        type: "run_log",
        runId,
        payload: { runId, level, message, ...(data ? { data } : {}) },
      });
    } catch (err) {
      console.warn("[cloud-agent] run_log failed:", err);
    }
  }

  private async executeRun(input: {
    tenantId: string;
    agent: Agent;
    sessionId: string;
    runId: string;
    targetMessageId: string;
    isFirstTurn: boolean;
  }): Promise<void> {
    const { tenantId, agent, sessionId, runId } = input;
    await this.store.markRunStarted(runId);

    let configJson: Record<string, unknown> = {};
    try {
      configJson = JSON.parse(agent.configJson || "{}") as Record<string, unknown>;
    } catch {
      configJson = {};
    }
    const cloud = parseCloudAgentConfig(configJson);
    const enableTools = cloud.enableTools !== false;
    /** 仅当显式配置时生效；默认不限制 */
    const maxRounds = cloud.maxToolRounds;

    await this.store.appendEvent({
      sessionId,
      type: "run_status",
      runId,
      payload: { runId, status: "thinking" },
    });

    const history = await this.store.listEvents(sessionId, { limit: 2000 });
    // 沿分支链重建上下文：重新生成的旧变体与其他分支不进入模型输入
    const chainRes = buildChainMessages(
      history.map((e) => ({
        type: e.type,
        runId: e.runId,
        payload: e.payload as unknown as Record<string, unknown>,
      })),
      input.targetMessageId,
    );
    let historyMsgs = chainRes.messages;
    const lastUserContent = chainRes.userContent;

    // —— 自动记忆召回 ——
    const autoMemoryOn =
      agent.enableMemory &&
      cloud.autoMemory !== false &&
      Boolean(this.deps.memoryProviders);
    let resolvedMemory: ResolvedMemory | null = null;
    let memoryContext = "";
    if (autoMemoryOn) {
      try {
        resolvedMemory = await resolveAgentMemory(this.deps.memoryProviders!, agent);
        if (resolvedMemory) {
          const ctx = await buildMemoryContext(
            this.deps.memoryStore ?? null,
            resolvedMemory,
            agent,
            lastUserContent || undefined,
          );
          memoryContext = ctx.text;
          if (ctx.count > 0) {
            await this.log(sessionId, runId, "info", `记忆召回 ${ctx.count} 条`, {
              retrievalMode: ctx.retrievalMode,
            });
          }
        }
      } catch (err) {
        await this.log(sessionId, runId, "warn", "记忆召回失败", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // —— 历史压缩：超长时把旧消息摘要进系统提示 ——
    let historySummary = "";
    if (approxMessagesChars(historyMsgs) > COMPACT_THRESHOLD_CHARS) {
      const keep = historyMsgs.slice(-COMPACT_KEEP_RECENT);
      const older = historyMsgs.slice(0, historyMsgs.length - keep.length);
      try {
        const digest = older
          .map((m) => `${m.role}: ${(m.content ?? "").slice(0, 600)}`)
          .join("\n")
          .slice(0, 30_000);
        const sum = await this.deps.modelRouter.chat(
          tenantId,
          [
            {
              role: "system",
              content:
                "把以下对话记录压缩成中文摘要，保留：用户目标、关键事实与数据、已完成/未完成事项、重要决定。500 字以内，直接输出摘要正文。",
            },
            { role: "user", content: digest },
          ],
          { capability: "chat", ...(cloud.model ? { alias: cloud.model } : {}) },
        );
        historySummary = (sum.content ?? "").trim();
        historyMsgs = keep;
        await this.log(sessionId, runId, "info", "历史过长，已压缩为摘要", {
          droppedMessages: older.length,
          summaryChars: historySummary.length,
        });
      } catch (err) {
        // 摘要失败：硬截断，保底继续
        historyMsgs = historyMsgs.slice(-COMPACT_KEEP_RECENT * 2);
        await this.log(sessionId, runId, "warn", "历史摘要失败，改为截断", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // —— 工具面：MCP + 原生 + 跨 Agent 委派 ——
    let definitions: ModelToolDefinition[] = [];
    let nameMap = new Map<string, string>();
    let peerAgents: Agent[] = [];
    let peerAgentsDesc = "";
    if (enableTools) {
      const tools = await this.deps.gateway.listToolsForAgent(agent);
      const mapped = toolsToDefinitions(tools);
      definitions = mapped.definitions;
      nameMap = mapped.nameMap;

      try {
        peerAgents = (await this.deps.agentService.list(tenantId)).filter(
          (a) => a.id !== agent.id,
        );
      } catch {
        peerAgents = [];
      }
      if (peerAgents.length > 0) {
        peerAgentsDesc = peerAgents
          .slice(0, 20)
          .map((a) => `- ${a.slug}（${a.name}）`)
          .join("\n");
        definitions.push({
          type: "function",
          function: {
            name: DELEGATE_TOOL_NAME,
            description:
              "将一个独立子任务委派给同租户的另一个 Agent 执行（它拥有自己的工具与记忆），阻塞等待其最终答复。适用于需要该 Agent 专属能力或职责分工的场景。",
            parameters: {
              type: "object",
              properties: {
                agentSlug: {
                  type: "string",
                  description: `目标 Agent 的 slug。可选：${peerAgents
                    .slice(0, 20)
                    .map((a) => a.slug)
                    .join(", ")}`,
                },
                task: { type: "string", description: "交给对方的任务描述，应自包含" },
                context: {
                  type: "string",
                  description: "可选补充上下文（对方看不到本会话历史）",
                },
              },
              required: ["agentSlug", "task"],
            },
          },
        });
      }
    }

    const hasSubagent = definitions.some(
      (d) => d.function.name === SUBAGENT_TOOL_QUALIFIED,
    );
    const systemPrompt = buildSystemPrompt(agent, cloud, {
      memoryContext: memoryContext || undefined,
      historySummary: historySummary || undefined,
      peerAgents: peerAgentsDesc || undefined,
      subagents: hasSubagent,
    });
    const messages: ModelChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...historyMsgs,
    ];

    // 图片附件：读工作区文件转 data URI（多模态输入）
    await this.resolveWorkspaceImages(agent, messages);

    await this.log(sessionId, runId, "info", "Run 开始", {
      model: cloud.model ?? "(默认路由)",
      tools: definitions.length,
      historyMessages: historyMsgs.length,
      memoryInjected: Boolean(memoryContext),
    });

    let finalText = "";
    // 无轮次上限：直到模型不再调用工具、用户取消或出错
    let round = 0;
    while (true) {
      if (await this.store.isCancelRequested(runId)) {
        await this.finishCancelled(sessionId, runId);
        return;
      }

      await this.store.appendEvent({
        sessionId,
        type: "run_status",
        runId,
        payload: { runId, status: round === 0 ? "thinking" : "streaming" },
      });

      const roundStarted = Date.now();
      const { publisher, result } = await this.streamModelRound({
        tenantId,
        sessionId,
        runId,
        cloud,
        messages,
        definitions,
      });

      const toolCalls = result.toolCalls ?? [];
      const text = result.content ?? "";
      await this.log(sessionId, runId, "info", `第 ${round + 1} 轮模型调用完成`, {
        model: result.model,
        route: result.routeSlug,
        durationMs: Date.now() - roundStarted,
        toolCalls: toolCalls.length,
        ...(result.usage
          ? {
              promptTokens: result.usage.promptTokens,
              completionTokens: result.usage.completionTokens,
            }
          : {}),
      });

      if (toolCalls.length === 0) {
        finalText = text;
        await this.store.appendEvent({
          sessionId,
          type: "assistant_message",
          runId,
          payload: { messageId: publisher.messageId, content: text },
        });
        await this.store.appendEvent({
          sessionId,
          type: "run_end",
          runId,
          payload: { runId, status: "completed" },
        });
        await this.store.finishRun(sessionId, runId, "completed");
        break;
      }

      // 有工具调用：增量文本已作为 delta 发布，与 tool_call_* 合成同一条 assistant
      messages.push({
        role: "assistant",
        content: text || null,
        toolCalls,
      });

      for (const call of toolCalls) {
        const modelName = call.function.name;
        const qualified = nameMap.get(modelName) ?? modelName;
        await this.store.appendEvent({
          sessionId,
          type: "tool_call_start",
          runId,
          payload: {
            toolCallId: call.id,
            name: modelName,
            title: modelName === DELEGATE_TOOL_NAME ? "委派 Agent" : qualified,
          },
        });
        await this.store.appendEvent({
          sessionId,
          type: "tool_call_args",
          runId,
          payload: {
            toolCallId: call.id,
            arguments: call.function.arguments,
          },
        });
      }

      // 同一轮内的多个子代理调用并行执行（上限 4），结果按原顺序回填
      const subagentResults = new Map<string, unknown>();
      const subagentCalls = toolCalls.filter(
        (c) => (nameMap.get(c.function.name) ?? c.function.name) === SUBAGENT_TOOL_QUALIFIED,
      );
      if (subagentCalls.length > 0) {
        await mapConcurrent(subagentCalls, 4, async (call) => {
          try {
            const answer = await this.runSubagent(
              tenantId,
              agent,
              parseToolArgs(call.function.arguments),
              {
                isCancelled: () => this.store.isCancelRequested(runId),
                onProgress: (message, data) =>
                  void this.log(sessionId, runId, "info", message, data),
              },
            );
            subagentResults.set(call.id, { content: [{ type: "text", text: answer }] });
          } catch (err) {
            subagentResults.set(call.id, {
              content: [
                { type: "text", text: err instanceof Error ? err.message : String(err) },
              ],
              isError: true,
            });
          }
        });
      }

      for (const call of toolCalls) {
        if (await this.store.isCancelRequested(runId)) break;

        const modelName = call.function.name;
        const qualified = nameMap.get(modelName) ?? modelName;
        await this.store.appendEvent({
          sessionId,
          type: "run_status",
          runId,
          payload: { runId, status: "tool", detail: modelName },
        });

        const started = Date.now();
        const args = parseToolArgs(call.function.arguments);
        let toolResult: unknown;
        try {
          if (subagentResults.has(call.id)) {
            toolResult = subagentResults.get(call.id);
          } else if (modelName === DELEGATE_TOOL_NAME) {
            const answer = await this.delegateToAgent(tenantId, agent, peerAgents, args, {
              isCancelled: () => this.store.isCancelRequested(runId),
            });
            toolResult = { content: [{ type: "text", text: answer }] };
          } else {
            toolResult = await this.deps.gateway.callTool(tenantId, qualified, args, {
              agentId: agent.id,
            });
          }
        } catch (err) {
          toolResult = {
            content: [
              {
                type: "text",
                text: err instanceof Error ? err.message : String(err),
              },
            ],
            isError: true,
          };
        }
        const { text: resultText, isError } = mcpResultToText(toolResult);
        const durationMs = Date.now() - started;

        await this.store.appendEvent({
          sessionId,
          type: "tool_call_result",
          runId,
          payload: {
            toolCallId: call.id,
            name: modelName,
            isError,
            resultText,
            durationMs,
          },
        });

        messages.push({
          role: "tool",
          content: resultText,
          toolCallId: call.id,
          name: modelName,
        });
      }

      // 循环内上下文过大：就地压缩较旧的工具结果
      if (approxMessagesChars(messages) > INLOOP_COMPACT_CHARS) {
        let compacted = 0;
        for (const m of messages) {
          if (approxMessagesChars(messages) <= COMPACT_THRESHOLD_CHARS) break;
          if (m.role === "tool" && m.content && m.content.length > 500) {
            m.content = `${m.content.slice(0, 400)}\n…(旧工具结果已压缩)`;
            compacted += 1;
          }
        }
        if (compacted > 0) {
          await this.log(sessionId, runId, "info", "循环内压缩旧工具结果", { compacted });
        }
      }

      round += 1;
      if (maxRounds != null && round >= maxRounds) {
        const note = `已达到配置的最大工具轮次（${maxRounds}），请继续发送消息以接着处理。`;
        finalText = note;
        const messageId = newId();
        await this.store.appendEvent({
          sessionId,
          type: "assistant_delta",
          runId,
          payload: { messageId, delta: note },
        });
        await this.store.appendEvent({
          sessionId,
          type: "assistant_message",
          runId,
          payload: { messageId, content: note },
        });
        await this.store.appendEvent({
          sessionId,
          type: "run_end",
          runId,
          payload: { runId, status: "completed" },
        });
        await this.store.finishRun(sessionId, runId, "completed");
        break;
      }
    }

    // —— 运行后处理（不阻塞会话）：自动标题 + 自动记忆 ——
    void this.postRun({
      tenantId,
      agent,
      sessionId,
      runId,
      cloud,
      isFirstTurn: input.isFirstTurn,
      userContent: lastUserContent,
      assistantContent: finalText,
      resolvedMemory: autoMemoryOn ? resolvedMemory : null,
    }).catch((err) => {
      console.warn("[cloud-agent] post-run failed:", err);
    });
  }

  /**
   * 将消息里 `workspace:` 占位的图片部件解析为 data URI。
   * 预算控制：最多解析最近 6 张、单张 ≤8MB；超预算/读失败的图片
   * 退化为纯文本注记（content 中已包含路径，模型可用 fs 工具处理）。
   */
  private async resolveWorkspaceImages(
    agent: Agent,
    messages: ModelChatMessage[],
  ): Promise<void> {
    const provider = this.deps.workspaceFsProvider;
    const MAX_IMAGES = 6;
    const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
    let budget = MAX_IMAGES;
    let fs: WorkspaceFs | undefined;

    // 从最新消息往前，优先保证近期图片可见
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (!m.parts?.length) continue;
      const resolved: ModelChatContentPart[] = [];
      for (const part of m.parts) {
        if (
          part.type !== "image_url" ||
          !part.imageUrl.url.startsWith(WORKSPACE_IMAGE_PREFIX)
        ) {
          resolved.push(part);
          continue;
        }
        if (!provider || budget <= 0) continue;
        const path = part.imageUrl.url.slice(WORKSPACE_IMAGE_PREFIX.length);
        try {
          if (fs === undefined) {
            fs = await provider.forAgentBinding({
              id: agent.id,
              tenantId: agent.tenantId,
              runtimeNodeId: agent.runtimeNodeId,
            });
          }
          const file = await fs.readBytes(path);
          if (file.data.length === 0 || file.data.length > MAX_IMAGE_BYTES) continue;
          resolved.push({
            type: "image_url",
            imageUrl: {
              url: `data:${guessImageMime(path)};base64,${file.data.toString("base64")}`,
            },
          });
          budget -= 1;
        } catch {
          // 文件被移动/删除等：仅保留文本注记
        }
      }
      if (resolved.some((p) => p.type === "image_url")) {
        m.parts = resolved;
      } else {
        // 没有可用图片时退回纯文本 content，避免触发不支持多模态的上游报错
        delete m.parts;
      }
    }
  }

  /**
   * 单轮流式模型调用（带自愈重试）。
   * 模型路由层已做「未输出时」的同路由重试与故障转移；这里兜底处理
   * 剩下两类失败：全部路由瞬时失败（稍候整体重来）、流中断且已输出
   * 部分增量（发布 assistant_rollback 丢弃半截文本后换新 messageId 重来）。
   */
  private async streamModelRound(input: {
    tenantId: string;
    sessionId: string;
    runId: string;
    cloud: CloudAgentConfig;
    messages: ModelChatMessage[];
    definitions: ModelToolDefinition[];
  }): Promise<{
    publisher: DeltaPublisher;
    result: Awaited<ReturnType<ModelRouterService["chatStream"]>>;
  }> {
    const { tenantId, sessionId, runId, cloud, messages, definitions } = input;
    const maxAttempts = 3;
    for (let attempt = 1; ; attempt += 1) {
      const publisher = new DeltaPublisher(this.store, sessionId, runId, newId());
      try {
        const result = await this.deps.modelRouter.chatStream(
          tenantId,
          messages,
          {
            capability: "chat",
            ...(cloud.model ? { alias: cloud.model } : {}),
          },
          definitions.length
            ? { tools: definitions, toolChoice: "auto" }
            : undefined,
          { onDelta: (text) => publisher.push(text) },
        );
        await publisher.drain();
        return { publisher, result };
      } catch (err) {
        await publisher.drain();
        const message = err instanceof Error ? err.message : String(err);
        const retryable = (err as { retryable?: boolean }).retryable === true;
        if (!retryable || attempt >= maxAttempts) throw err;
        if (await this.store.isCancelRequested(runId)) throw err;
        if (publisher.emitted) {
          await this.store.appendEvent({
            sessionId,
            type: "assistant_rollback",
            runId,
            payload: { messageId: publisher.messageId, reason: "stream_interrupted" },
          });
        }
        await this.log(
          sessionId,
          runId,
          "warn",
          `模型调用中断，正在重试（第 ${attempt}/${maxAttempts - 1} 次）`,
          { error: message.slice(0, 600) },
        );
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }

  private async finishCancelled(sessionId: string, runId: string): Promise<void> {
    await this.store.appendEvent({
      sessionId,
      type: "run_status",
      runId,
      payload: { runId, status: "cancelled", detail: "用户取消" },
    });
    await this.store.appendEvent({
      sessionId,
      type: "run_end",
      runId,
      payload: { runId, status: "cancelled" },
    });
    await this.store.finishRun(sessionId, runId, "cancelled");
  }

  /**
   * 云端子代理（CloudSubagentRunner 实现）：以隔离上下文运行一次性 mini-loop。
   * 与主 Agent 共享工作区和工具面，但：没有对话历史与记忆注入、
   * 不能再派生子代理（工具集中剔除自身，防止递归爆炸）、结束即销毁。
   * agent loop 与外部 MCP 客户端（/mcp/agents/:slug 调 re_spawn_subagent）共用此实现。
   */
  async runSubagent(
    tenantId: string,
    agent: Agent,
    args: Record<string, unknown>,
    opts: {
      isCancelled?: () => Promise<boolean>;
      onProgress?: (message: string, data?: Record<string, unknown>) => void;
    },
  ): Promise<string> {
    const task = typeof args.task === "string" ? args.task.trim() : "";
    if (!task) throw new Error("task 必填：请提供自包含的子任务描述");
    const context = typeof args.context === "string" ? args.context.trim() : "";
    const expected =
      typeof args.expected_output === "string" ? args.expected_output.trim() : "";

    let configJson: Record<string, unknown> = {};
    try {
      configJson = JSON.parse(agent.configJson || "{}") as Record<string, unknown>;
    } catch {
      configJson = {};
    }
    const cloud = parseCloudAgentConfig(configJson);

    const allTools = await this.deps.gateway.listToolsForAgent(agent);
    const { definitions, nameMap } = toolsToDefinitions(
      allTools.filter((t) => t.qualifiedName !== SUBAGENT_TOOL_QUALIFIED),
    );

    const subagentId = newId().slice(0, 6);
    opts.onProgress?.(`子代理[${subagentId}] 启动`, { task: task.slice(0, 200) });

    const messages: ModelChatMessage[] = [
      {
        role: "system",
        content: buildSubagentPrompt(agent, cloud, {
          expectedOutput: expected || undefined,
        }),
      },
      {
        role: "user",
        content: `# 委派任务\n${task}${context ? `\n\n# 背景信息\n${context}` : ""}`,
      },
    ];

    const MAX_ROUNDS = 16;
    let lastText = "";
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      if (opts.isCancelled && (await opts.isCancelled())) {
        throw new Error("父任务已取消，子代理终止");
      }
      const result = await this.deps.modelRouter.chat(
        tenantId,
        messages,
        { capability: "chat", ...(cloud.model ? { alias: cloud.model } : {}) },
        definitions.length ? { tools: definitions, toolChoice: "auto" } : undefined,
      );
      if (result.content) lastText = result.content;
      const toolCalls = result.toolCalls ?? [];
      if (toolCalls.length === 0) {
        const answer = (result.content ?? "").trim();
        opts.onProgress?.(`子代理[${subagentId}] 完成（${round + 1} 轮）`);
        return answer ? answer.slice(0, RESULT_TEXT_LIMIT) : "（子代理无输出）";
      }
      opts.onProgress?.(
        `子代理[${subagentId}] 第 ${round + 1} 轮：${toolCalls
          .map((c) => c.function.name)
          .join(", ")
          .slice(0, 200)}`,
      );
      messages.push({ role: "assistant", content: result.content ?? null, toolCalls });
      for (const call of toolCalls) {
        const qualified = nameMap.get(call.function.name) ?? call.function.name;
        let toolResult: unknown;
        try {
          toolResult = await this.deps.gateway.callTool(
            tenantId,
            qualified,
            parseToolArgs(call.function.arguments),
            { agentId: agent.id },
          );
        } catch (err) {
          toolResult = {
            content: [
              { type: "text", text: err instanceof Error ? err.message : String(err) },
            ],
            isError: true,
          };
        }
        const { text } = mcpResultToText(toolResult);
        messages.push({
          role: "tool",
          content: text,
          toolCallId: call.id,
          name: call.function.name,
        });
      }
      // 上下文控制：过大时就地压缩旧工具结果
      if (approxMessagesChars(messages) > INLOOP_COMPACT_CHARS) {
        for (const m of messages) {
          if (approxMessagesChars(messages) <= COMPACT_THRESHOLD_CHARS) break;
          if (m.role === "tool" && m.content && m.content.length > 500) {
            m.content = `${m.content.slice(0, 400)}\n…(已压缩)`;
          }
        }
      }
    }
    opts.onProgress?.(`子代理[${subagentId}] 达到轮次上限（${MAX_ROUNDS}）`);
    return `子代理达到轮次上限（${MAX_ROUNDS}），任务可能未完成。${
      lastText ? `最后进展：${lastText.slice(0, 2000)}` : "建议缩小任务范围后重新派生。"
    }`;
  }

  /** 跨 Agent 委派：目标 Agent 以一次性 mini-loop 执行（不落其会话，不再嵌套委派） */
  private async delegateToAgent(
    tenantId: string,
    caller: Agent,
    peers: Agent[],
    args: Record<string, unknown>,
    opts: { isCancelled: () => Promise<boolean> },
  ): Promise<string> {
    const slug = typeof args.agentSlug === "string" ? args.agentSlug.trim() : "";
    const task = typeof args.task === "string" ? args.task.trim() : "";
    const context = typeof args.context === "string" ? args.context.trim() : "";
    if (!slug || !task) throw new Error("agentSlug 与 task 必填");
    if (slug === caller.slug) throw new Error("不能委派给自己");
    const target = peers.find((a) => a.slug === slug || a.id === slug);
    if (!target) throw new Error(`未找到 Agent: ${slug}`);

    let targetConfig: Record<string, unknown> = {};
    try {
      targetConfig = JSON.parse(target.configJson || "{}") as Record<string, unknown>;
    } catch {
      targetConfig = {};
    }
    const targetCloud = parseCloudAgentConfig(targetConfig);

    const tools = await this.deps.gateway.listToolsForAgent(target);
    const { definitions, nameMap } = toolsToDefinitions(tools);

    const messages: ModelChatMessage[] = [
      { role: "system", content: buildSystemPrompt(target, targetCloud) },
      {
        role: "user",
        content: `来自 Agent「${caller.name}」的委派任务：\n${task}${context ? `\n\n补充上下文：\n${context}` : ""}`,
      },
    ];

    for (let round = 0; round < 12; round += 1) {
      if (await opts.isCancelled()) throw new Error("父 Run 已取消");
      const result = await this.deps.modelRouter.chat(
        tenantId,
        messages,
        {
          capability: "chat",
          ...(targetCloud.model ? { alias: targetCloud.model } : {}),
        },
        definitions.length ? { tools: definitions, toolChoice: "auto" } : undefined,
      );
      const toolCalls = result.toolCalls ?? [];
      if (toolCalls.length === 0) {
        const answer = (result.content ?? "").trim();
        return answer
          ? `[${target.name}] ${answer}`.slice(0, 8_000)
          : `[${target.name}] （无回复内容）`;
      }
      messages.push({ role: "assistant", content: result.content ?? null, toolCalls });
      for (const call of toolCalls) {
        const qualified = nameMap.get(call.function.name) ?? call.function.name;
        let toolResult: unknown;
        try {
          toolResult = await this.deps.gateway.callTool(
            tenantId,
            qualified,
            parseToolArgs(call.function.arguments),
            { agentId: target.id },
          );
        } catch (err) {
          toolResult = {
            content: [
              { type: "text", text: err instanceof Error ? err.message : String(err) },
            ],
            isError: true,
          };
        }
        const { text } = mcpResultToText(toolResult);
        messages.push({
          role: "tool",
          content: text,
          toolCallId: call.id,
          name: call.function.name,
        });
      }
    }
    return `[${target.name}] 达到委派轮次上限，任务可能未完成。`;
  }

  private async postRun(input: {
    tenantId: string;
    agent: Agent;
    sessionId: string;
    runId: string;
    cloud: CloudAgentConfig;
    isFirstTurn: boolean;
    userContent: string;
    assistantContent: string;
    resolvedMemory: ResolvedMemory | null;
  }): Promise<void> {
    const { tenantId, agent, sessionId, runId, cloud } = input;

    // 自动标题：首轮完成后用模型生成
    if (input.isFirstTurn && cloud.autoTitle !== false && input.userContent) {
      try {
        const res = await this.deps.modelRouter.chat(
          tenantId,
          [
            {
              role: "system",
              content:
                "为这段对话生成一个简短标题：中文优先、不超过 16 个字、不含引号和句号，直接输出标题本身。",
            },
            {
              role: "user",
              content: `用户：${input.userContent.slice(0, 800)}\n\n助手：${input.assistantContent.slice(0, 800)}`,
            },
          ],
          { capability: "chat", ...(cloud.model ? { alias: cloud.model } : {}) },
        );
        const title = (res.content ?? "")
          .trim()
          .replace(/^["'「『]+|["'」』。]+$/g, "")
          .split("\n")[0]
          ?.slice(0, 24);
        if (title) {
          await this.store.updateSession(tenantId, agent.id, sessionId, { title });
          await this.store.appendEvent({
            sessionId,
            type: "session_update",
            runId,
            payload: { title },
          });
        }
      } catch (err) {
        await this.log(sessionId, runId, "warn", "自动标题生成失败", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 自动记忆提取（类 ChatGPT：对话后判断是否有值得长期记住的信息）
    if (input.resolvedMemory && input.userContent) {
      try {
        const saved = await this.extractAndSaveMemories({
          tenantId,
          agent,
          cloud,
          resolved: input.resolvedMemory,
          userContent: input.userContent,
          assistantContent: input.assistantContent,
        });
        if (saved.length > 0) {
          await this.store.appendEvent({
            sessionId,
            type: "memory_updated",
            runId,
            payload: {
              runId,
              items: saved.map((s) => ({ id: s.id, content: s.content, layer: s.layer })),
            },
          });
          await this.log(sessionId, runId, "info", `自动记忆写入 ${saved.length} 条`);
        }
      } catch (err) {
        await this.log(sessionId, runId, "warn", "自动记忆提取失败", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async extractAndSaveMemories(input: {
    tenantId: string;
    agent: Agent;
    cloud: CloudAgentConfig;
    resolved: ResolvedMemory;
    userContent: string;
    assistantContent: string;
  }): Promise<Array<{ id?: string; content: string; layer?: string }>> {
    const { tenantId, agent, cloud, resolved } = input;

    const res = await this.deps.modelRouter.chat(
      tenantId,
      [
        {
          role: "system",
          content: [
            "你是记忆提取器。判断这轮对话里是否有值得长期记住的用户信息。",
            "值得记住：用户身份/偏好/习惯、长期项目与目标、稳定事实、重要约定。",
            "不要记：一次性任务细节、临时状态、可随时重新查询的内容、助手自己的输出。",
            `layer 可选值：${MEMORY_LAYERS.join(", ")}。`,
            '严格输出 JSON：{"memories":[{"content":"…","layer":"fact","importance":3,"tags":[]}]}',
            '没有值得记住的内容时输出 {"memories":[]}。content 用第三人称中文陈述，单条不超过 100 字。',
          ].join("\n"),
        },
        {
          role: "user",
          content: `用户：${input.userContent.slice(0, 3000)}\n\n助手：${input.assistantContent.slice(0, 2000)}`,
        },
      ],
      { capability: "chat", ...(cloud.model ? { alias: cloud.model } : {}) },
    );

    const candidates = parseMemoryExtraction(res.content ?? "");
    if (candidates.length === 0) return [];

    // 去重：与已有记忆内容（规范化后）完全一致的跳过
    const normalize = (s: string) => s.replace(/\s+/g, "").toLowerCase();
    const existing = new Set<string>();
    if (resolved.storesLocally && this.deps.memoryStore) {
      const rows = await this.deps.memoryStore.list(tenantId, agent.id, { limit: 200 });
      for (const r of rows) existing.add(normalize(r.content));
    }

    const saved: Array<{ id?: string; content: string; layer?: string }> = [];
    for (const cand of candidates) {
      if (existing.has(normalize(cand.content))) continue;

      if (resolved.storesLocally && this.deps.memoryStore) {
        const base = {
          content: cand.content,
          layer: cand.layer ?? "fact",
          importance: cand.importance ?? 3,
          tags: cand.tags,
          source: "auto",
          providerId: resolved.provider.id,
        };
        const { input: withEmb } = await withEmbedding(base, resolved.config, {
          tenantId,
          modelRouter: this.deps.modelRouter,
        });
        const row = await this.deps.memoryStore.add(tenantId, agent.id, withEmb);
        saved.push({ id: row.id, content: row.content, layer: row.layer });
      } else if (resolved.kind === "mem0") {
        const client = Mem0Client.fromConfig(resolved.config);
        const item = await client.add({
          content: cand.content,
          agentId: agent.id,
          userId:
            typeof resolved.config.defaultUserId === "string"
              ? resolved.config.defaultUserId
              : "default",
          metadata: { source: "auto", layer: cand.layer ?? "fact" },
        });
        saved.push({
          id: typeof item?.id === "string" ? item.id : undefined,
          content: cand.content,
          layer: cand.layer,
        });
      }
    }
    return saved;
  }
}
