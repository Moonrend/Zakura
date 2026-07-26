/**
 * Cloud Agent 持久会话事件协议（自托管，语义对齐 Ably AI Transport）：
 * - 会话状态落库，不依赖单条 HTTP 连接
 * - 客户端按 seq 断点续传，多设备共享同一事件流
 * - Run 可取消，工具调用作为一等事件展示
 */

export const CLOUD_AGENT_EVENT_TYPES = [
  "user_message",
  "run_start",
  "assistant_delta",
  "assistant_message",
  "assistant_rollback",
  "tool_call_start",
  "tool_call_args",
  "tool_call_result",
  "run_status",
  "run_end",
  "run_error",
  "run_log",
  "memory_updated",
  "session_update",
] as const;

export type CloudAgentEventType = (typeof CLOUD_AGENT_EVENT_TYPES)[number];

export type CloudAgentRunStatus =
  | "queued"
  | "thinking"
  | "streaming"
  | "tool"
  | "completed"
  | "cancelled"
  | "failed";

export type CloudAgentSessionStatus = "active" | "archived";

/**
 * 会话类型标记：所有由平台产生的对话历史都落库为会话，用 kind 区分来源。
 * - chat     用户直接对话（默认，聊天界面展示的类型）
 * - subagent 子代理运行记录（agent loop 或外部 MCP 客户端派生）
 * - delegate 跨 Agent 委派记录（落在目标 Agent 名下）
 * - system   其他系统调用产生的对话（定时任务、API 集成等）
 */
export const CLOUD_AGENT_SESSION_KINDS = [
  "chat",
  "subagent",
  "delegate",
  "system",
] as const;

export type CloudAgentSessionKind = (typeof CLOUD_AGENT_SESSION_KINDS)[number];

export function parseCloudAgentSessionKind(raw: unknown): CloudAgentSessionKind | null {
  return typeof raw === "string" &&
    (CLOUD_AGENT_SESSION_KINDS as readonly string[]).includes(raw)
    ? (raw as CloudAgentSessionKind)
    : null;
}

/**
 * 会话来源链接：非 chat 会话记录「谁产生了这段对话」，
 * 支持从子代理/委派会话回溯到父会话与触发它的工具调用。
 */
export type CloudAgentSessionOrigin = {
  /** 触发来源：agent_loop（主循环工具调用）/ mcp（外部 MCP 客户端）/ api（REST 创建）/ system */
  source?: "agent_loop" | "mcp" | "api" | "system";
  /** 父会话（同租户；委派场景下属于调用方 Agent） */
  parentSessionId?: string;
  parentRunId?: string;
  /** 触发本会话的父会话工具调用 id */
  parentToolCallId?: string;
  /** 调用方 Agent（委派场景 = 发起委派的 Agent） */
  callerAgentId?: string;
  callerAgentName?: string;
  /** 子代理嵌套深度：1=主循环直接派生，2=子代理再派生，… */
  depth?: number;
};

export function parseCloudAgentSessionOrigin(raw: unknown): CloudAgentSessionOrigin {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: CloudAgentSessionOrigin = {};
  if (
    o.source === "agent_loop" ||
    o.source === "mcp" ||
    o.source === "api" ||
    o.source === "system"
  ) {
    out.source = o.source;
  }
  for (const key of [
    "parentSessionId",
    "parentRunId",
    "parentToolCallId",
    "callerAgentId",
    "callerAgentName",
  ] as const) {
    const v = o[key];
    if (typeof v === "string" && v) out[key] = v.slice(0, 200);
  }
  if (typeof o.depth === "number" && o.depth >= 1 && o.depth <= 10) {
    out.depth = Math.floor(o.depth);
  }
  return out;
}

/** 用户消息附件（已上传至 Agent 工作区） */
export type CloudAgentAttachment = {
  /** 原始文件名 */
  name: string;
  /** 工作区内路径（如 /uploads/xxx.png） */
  path: string;
  mime: string;
  size: number;
  kind: "image" | "file";
};

export type CloudAgentUserMessagePayload = {
  messageId: string;
  content: string;
  /**
   * 分支父节点：本消息跟在哪个 Run 的回答之后。
   * null = 会话根；缺省（旧事件）= 按 seq 线性推断。
   * 同一 parentRunId 下的多条用户消息互为兄弟分支（编辑重发）。
   */
  parentRunId?: string | null;
  /** 随消息上传的附件；图片会作为多模态内容发给模型 */
  attachments?: CloudAgentAttachment[];
};

export type CloudAgentRunStartPayload = {
  runId: string;
  /**
   * 本 Run 回答的用户消息 id。同一消息可有多个 Run（重新生成变体）。
   * 缺省（旧事件）= 按 seq 推断为最近一条用户消息。
   */
  replyToMessageId?: string;
};

export type CloudAgentAssistantDeltaPayload = {
  messageId: string;
  /** 增量文本（append） */
  delta: string;
};

export type CloudAgentAssistantMessagePayload = {
  messageId: string;
  content: string;
};

/**
 * 丢弃某条流式助手消息已发布的增量（模型流中断重试时使用）。
 * 消费方应忽略该 messageId 此前累积的全部 assistant_delta。
 */
export type CloudAgentAssistantRollbackPayload = {
  messageId: string;
  reason?: string;
};

export type CloudAgentToolCallStartPayload = {
  toolCallId: string;
  name: string;
  /** 展示用标题 */
  title?: string;
};

export type CloudAgentToolCallArgsPayload = {
  toolCallId: string;
  arguments: string;
};

export type CloudAgentToolCallResultPayload = {
  toolCallId: string;
  name: string;
  isError: boolean;
  /** 截断后的结果文本，供 UI 展示 */
  resultText: string;
  durationMs: number;
  /** 本次调用派生的子会话（子代理/委派运行记录），UI 可跳转查看完整对话 */
  childSessionId?: string;
  /** 子会话所属 Agent（委派时为目标 Agent；缺省=当前 Agent） */
  childAgentId?: string;
};

export type CloudAgentRunStatusPayload = {
  runId: string;
  status: CloudAgentRunStatus;
  detail?: string;
};

export type CloudAgentRunEndPayload = {
  runId: string;
  status: "completed" | "cancelled" | "failed";
};

export type CloudAgentRunErrorPayload = {
  runId: string;
  message: string;
};

/** 运行日志：loop 内部诊断（轮次、模型、token 用量、压缩等） */
export type CloudAgentRunLogPayload = {
  runId: string;
  level: "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
};

/** 自动记忆写入完成（类 ChatGPT「已更新记忆」） */
export type CloudAgentMemoryUpdatedPayload = {
  runId: string;
  /** 新写入的记忆内容摘要 */
  items: Array<{ id?: string; content: string; layer?: string }>;
};

/** 会话元数据变更（如自动标题），供多端实时同步 */
export type CloudAgentSessionUpdatePayload = {
  title?: string;
  status?: CloudAgentSessionStatus;
};

export type CloudAgentEventPayload =
  | CloudAgentUserMessagePayload
  | CloudAgentRunStartPayload
  | CloudAgentAssistantDeltaPayload
  | CloudAgentAssistantMessagePayload
  | CloudAgentAssistantRollbackPayload
  | CloudAgentToolCallStartPayload
  | CloudAgentToolCallArgsPayload
  | CloudAgentToolCallResultPayload
  | CloudAgentRunStatusPayload
  | CloudAgentRunEndPayload
  | CloudAgentRunErrorPayload
  | CloudAgentRunLogPayload
  | CloudAgentMemoryUpdatedPayload
  | CloudAgentSessionUpdatePayload;

export type CloudAgentEvent = {
  id: string;
  sessionId: string;
  seq: number;
  type: CloudAgentEventType;
  runId: string | null;
  payload: CloudAgentEventPayload;
  createdAt: string;
};

/** Agent.configJson.cloud 配置 */
export type CloudAgentConfig = {
  /** 额外系统提示词（叠加平台 instructions） */
  systemPrompt?: string;
  /** 模型路由 alias / model 名；空则用租户默认 chat 路由 */
  model?: string;
  /**
   * 可选：单次 Run 最大工具轮次。
   * 不设置则不限制，循环直到模型结束或用户取消。
   */
  maxToolRounds?: number;
  /**
   * 子代理最大嵌套深度（1-5，默认 2）：
   * 1 = 仅主循环可派生子代理；2 = 子代理可再派生一层；以此类推。
   * 达到该深度的子代理工具面中不再包含派生工具。
   */
  maxSubagentDepth?: number;
  /** 是否向模型暴露工具（默认 true） */
  enableTools?: boolean;
  /** 自动记忆：运行前召回 + 运行后提取写入（默认 true，需 Agent 开启 Memory） */
  autoMemory?: boolean;
  /** 首轮结束后由模型自动生成会话标题（默认 true） */
  autoTitle?: boolean;
};

export function parseCloudAgentConfig(raw: unknown): CloudAgentConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const cloud =
    o.cloud && typeof o.cloud === "object" && !Array.isArray(o.cloud)
      ? (o.cloud as Record<string, unknown>)
      : o;
  const out: CloudAgentConfig = {};
  if (typeof cloud.systemPrompt === "string") out.systemPrompt = cloud.systemPrompt;
  if (typeof cloud.model === "string" && cloud.model.trim()) out.model = cloud.model.trim();
  if (typeof cloud.maxToolRounds === "number" && cloud.maxToolRounds > 0) {
    out.maxToolRounds = Math.floor(cloud.maxToolRounds);
  }
  if (typeof cloud.maxSubagentDepth === "number" && cloud.maxSubagentDepth >= 1) {
    out.maxSubagentDepth = Math.min(Math.floor(cloud.maxSubagentDepth), 5);
  }
  if (typeof cloud.enableTools === "boolean") out.enableTools = cloud.enableTools;
  if (typeof cloud.autoMemory === "boolean") out.autoMemory = cloud.autoMemory;
  if (typeof cloud.autoTitle === "boolean") out.autoTitle = cloud.autoTitle;
  return out;
}
