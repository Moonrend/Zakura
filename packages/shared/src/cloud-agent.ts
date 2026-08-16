/**
 * Cloud Agent 持久会话事件协议（自托管，语义对齐 Ably AI Transport）：
 * - 会话状态落库，不依赖单条 HTTP 连接
 * - 客户端按 seq 断点续传，多设备共享同一事件流
 * - Run 可取消，工具调用作为一等事件展示
 */
import type { ModelToolCall } from "./model-router.js";

/**
 * Agent 可调用、但不在任何用户界面展示的内部工具。
 * 事件仍会落库供模型历史重建；时间线 / 运行日志 / 工具卡片需过滤。
 */
export const SILENT_AGENT_TOOL_NAMES = ["send_crisis_support_resources"] as const;

export type SilentAgentToolName = (typeof SILENT_AGENT_TOOL_NAMES)[number];

export function isSilentAgentTool(name: string): boolean {
  return (SILENT_AGENT_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * 最近一次 Run 若以 cancelled 收尾，返回其 runId（可点「继续」）。
 * 仍在跑、已完成、失败、或没有 Run → null。从尾部扫描，不依赖完整历史。
 */
export function lastCancelledRunId(
  events: Array<{ type: string; runId?: string | null; payload?: unknown }>,
): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!;
    const p =
      ev.payload && typeof ev.payload === "object" && !Array.isArray(ev.payload)
        ? (ev.payload as Record<string, unknown>)
        : {};
    const rid = ev.runId ?? (typeof p.runId === "string" ? p.runId : null);
    if (ev.type === "run_end") {
      return rid && p.status === "cancelled" ? rid : null;
    }
    if (ev.type === "run_start") return null;
  }
  return null;
}

export const CLOUD_AGENT_EVENT_TYPES = [
  "user_message",
  "run_start",
  "reasoning_delta",
  "assistant_delta",
  "assistant_message",
  "assistant_rollback",
  "tool_call_start",
  "tool_call_args",
  "tool_call_progress",
  "tool_call_result",
  "run_status",
  "run_end",
  "run_error",
  "run_log",
  "memory_updated",
  /** 系统为本轮回答注入的上下文来源（记忆召回、对话摘要等） */
  "context_sources",
  /** 开始同步压缩上下文（UI 可展示进行中步骤） */
  "context_compacting",
  /** 会话历史被压缩成可复用摘要（手动或自动触发） */
  "context_compacted",
  "session_update",
  /** 服务端后续消息队列快照（每次变更全量广播，多设备同步） */
  "queue_update",
  /** ACP：第三方 Agent 请求工具授权 */
  "permission_request",
  "permission_resolved",
  /** ACP：结构化表单 / URL 交互 */
  "elicitation_request",
  "elicitation_resolved",
  /** ACP：执行计划 */
  "acp_plan",
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
 * - acp      第三方 ACP Agent 会话（Claude Code / Codex / 自定义）
 * - system   其他系统调用产生的对话（定时任务、API 集成等）
 */
export const CLOUD_AGENT_SESSION_KINDS = [
  "chat",
  "subagent",
  "delegate",
  "acp",
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
  /** 触发来源：agent_loop / mcp / api / system / remote */
  source?: "agent_loop" | "mcp" | "api" | "system" | "remote";
  /** API 接入通道，例如 OpenAI 兼容中间件 */
  channel?: string;
  /** 外部客户端会话关联键（Claude Code / Codex 等自带的 session id） */
  clientSessionKey?: string;
  /** 创建该 Gateway 会话的 API Key id（无客户端 session 时用于粘会话） */
  apiKeyId?: string;
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
  /** 远程连接平台及其稳定外部标识 */
  platform?: string;
  connectionId?: string;
  externalThreadKey?: string;
  externalUserKey?: string;
  /** 会话运行时：缺省 = Zakura loop；acp = 第三方 ACP Agent */
  runtime?: "acp";
  /** ACP profile id（claude-code / codex / 自定义） */
  acpProfileId?: string;
  /** 协议层 session id，用于 load / resume */
  acpSessionId?: string;
  /** 进程池 runtime id（不跨进程持久） */
  acpRuntimeId?: string;
};

export function parseCloudAgentSessionOrigin(raw: unknown): CloudAgentSessionOrigin {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: CloudAgentSessionOrigin = {};
  if (
    o.source === "agent_loop" ||
    o.source === "mcp" ||
    o.source === "api" ||
    o.source === "system" ||
    o.source === "remote"
  ) {
    out.source = o.source;
  }
  for (const key of [
    "channel",
    "clientSessionKey",
    "apiKeyId",
    "parentSessionId",
    "parentRunId",
    "parentToolCallId",
    "callerAgentId",
    "callerAgentName",
    "platform",
    "connectionId",
    "externalThreadKey",
    "externalUserKey",
    "acpProfileId",
    "acpSessionId",
    "acpRuntimeId",
  ] as const) {
    const v = o[key];
    if (typeof v === "string" && v) out[key] = v.slice(0, 200);
  }
  if (typeof o.depth === "number" && o.depth >= 1 && o.depth <= 10) {
    out.depth = Math.floor(o.depth);
  }
  if (o.runtime === "acp") out.runtime = "acp";
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
  /**
   * 同 Run 内中途注入（下一工具批结束后进入模型），不是新回合锚点。
   * 投影/UI 应把它挂在当前 Run 时间线上，而不是开新 ConversationTurn。
   */
  steer?: boolean;
  /**
   * 从上次中断的 Run 接着做。UI 不展示用户气泡；模型仍把它当作用户指令。
   */
  continue?: boolean;
};

/** 运行中收到用户消息时的默认策略 */
export type CloudAgentFollowUpMode = "steer" | "queue";

/**
 * 服务端后续消息队列条目（对齐 Codex：pending_steers + queued_user_messages）。
 * 队列由服务端持有并广播快照，任意设备可增删改；Run 结束后由服务端按 FIFO
 * 逐条开新回合（一次一条），mode=steer 的条目在活跃 Run 的下一工具批后注入。
 */
export type CloudAgentQueuedMessage = {
  messageId: string;
  content: string;
  attachments?: CloudAgentAttachment[];
  /**
   * steer：活跃 Run 下一工具批结束后注入当前回合；
   * queue：等当前 Run 结束后作为新回合发送。
   * Run 结束时仍未注入的 steer 项与 queue 项一样按 FIFO 开新回合。
   */
  mode: CloudAgentFollowUpMode;
  /** 引导标记：取消当前 Run 后立即用这条开启新回合 */
  interrupt?: boolean;
  createdAt: string;
};

/** 队列快照：每次入队/编辑/移除/出队后全量广播（条目少，天然幂等） */
export type CloudAgentQueueUpdatePayload = {
  items: CloudAgentQueuedMessage[];
};

export type CloudAgentRunStartPayload = {
  runId: string;
  /**
   * 本 Run 回答的用户消息 id。同一消息可有多个 Run（重新生成变体）。
   * 缺省（旧事件）= 按 seq 推断为最近一条用户消息。
   */
  replyToMessageId?: string;
  /** 本次 Run 的调用时模型选项（如思考强度覆盖）。 */
  options?: CloudAgentRunOptions;
};

export type CloudAgentAssistantDeltaPayload = {
  messageId: string;
  /** 增量文本（append） */
  delta: string;
};

export type CloudAgentReasoningDeltaPayload = {
  messageId: string;
  /** 思考过程增量文本（append） */
  delta: string;
};

export type CloudAgentAssistantMessagePayload = {
  messageId: string;
  content: string;
  /** 外部代理返回的客户端工具调用；服务端不会执行 */
  toolCalls?: ModelToolCall[];
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

/** 工具执行中的增量输出（shell 日志等）；不进入模型上下文 */
export type CloudAgentToolCallProgressPayload = {
  toolCallId: string;
  message?: string;
  stdout?: string;
  stderr?: string;
  jobId?: string;
  running?: boolean;
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
  /** UI 历史瘦身：完整 args/result 未下发，展开时再拉 */
  detailPending?: boolean;
  /** ACP tool_call content 里的文件 diff */
  diffs?: Array<{ path: string; oldText?: string; newText: string }>;
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

/** 上下文来源条目（注入进模型的记忆 / 摘要，或工具检索到的材料） */
export type CloudAgentContextSourceKind =
  | "memory"
  | "file"
  | "search"
  | "web"
  | "summary"
  | "other";

export type CloudAgentContextSourceItem = {
  kind: CloudAgentContextSourceKind;
  /** 列表标题 */
  title: string;
  /** 正文摘要或全文 */
  content?: string;
  /** 工作区文件路径 */
  path?: string;
  /** 网页 URL */
  url?: string;
  id?: string;
  layer?: string;
};

/** 系统为本轮 Run 注入的上下文来源（运行前召回等） */
export type CloudAgentContextSourcesPayload = {
  runId: string;
  items: CloudAgentContextSourceItem[];
};

/** 压缩摘要附带的 coding 文件轨迹（确定性抽取 + 摘要合并，跨轮累积） */
export type CloudAgentCompactionDetails = {
  readFiles?: string[];
  modifiedFiles?: string[];
};

/** 开始/推进同步压缩（时间线展示「压缩中」步骤） */
export type CloudAgentContextCompactingPayload = {
  runId?: string;
  /** 与 context_compacted.source 对齐；soft 表示 Run 后预压缩 */
  source: "manual" | "auto" | "soft" | "overflow";
  /** start=已切分；summarizing=正在调模型 */
  phase?: "start" | "summarizing";
  /** 压缩前估算字符数 */
  beforeChars?: number;
  /** 压缩前估算 token（CJK 感知） */
  beforeTokens?: number;
  /** 将摘要的消息条数 */
  olderMessages?: number;
  /** 保留的最近消息条数 */
  keepMessages?: number;
  /** 0–100 示意进度（非精确） */
  progress?: number;
};

/** 会话历史压缩摘要。旧事件仍保留在库中，后续上下文优先使用最新摘要。 */
export type CloudAgentContextCompactedPayload = {
  summary: string;
  /**
   * manual=用户触发；auto=Run 内自动；fork=从其它会话派生；
   * soft=Run 后预压；overflow=上游上下文超长后的恢复压缩
   */
  source: "manual" | "auto" | "fork" | "soft" | "overflow";
  beforeChars: number;
  afterChars: number;
  /** CJK 感知 token 估算（优先用于 UI / 阈值） */
  beforeTokens?: number;
  afterTokens?: number;
  droppedMessages: number;
  keptMessages: number;
  /** 手动压缩时记录内部 system 会话，便于审计压缩过程。 */
  systemSessionId?: string;
  /** fork 时源会话 id */
  forkedFromSessionId?: string;
  /** coding 向：已读/已改文件轨迹，供 UI 与下一轮摘要合并 */
  details?: CloudAgentCompactionDetails;
  /** 摘要耗时（毫秒） */
  durationMs?: number;
  /** 实际用于摘要的模型 alias / 路由（便于 UI 展示） */
  model?: string;
  /** 摘要是否失败后的降级结果 */
  failed?: boolean;
};

/** 会话元数据变更（如自动标题），供多端实时同步 */
export type CloudAgentSessionUpdatePayload = {
  title?: string;
  status?: CloudAgentSessionStatus;
  acpModeId?: string;
  acpModelId?: string;
  acpState?: "starting" | "idle" | "active" | "closed";
  acpError?: string;
  acpModes?: {
    currentId?: string;
    available: Array<{ id: string; name: string }>;
  };
  acpCommands?: Array<{ name: string; description?: string }>;
  acpModels?: {
    currentId?: string;
    available: Array<{ id: string; name: string }>;
    configId?: string;
  };
  acpReasoning?: {
    current?: string;
    available: Array<{ id: string; name: string }>;
    configId?: string;
  };
};

export type CloudAgentPermissionRequestPayload = {
  requestId: string;
  toolCallId?: string;
  title?: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
};

export type CloudAgentPermissionResolvedPayload = {
  requestId: string;
  outcome: "selected" | "cancelled";
  optionId?: string;
};

export type CloudAgentElicitationRequestPayload = {
  requestId: string;
  mode: "form" | "url";
  message?: string;
  url?: string;
  fields?: Array<{ id: string; type: string; title?: string; required?: boolean }>;
};

export type CloudAgentElicitationResolvedPayload = {
  requestId: string;
  cancelled?: boolean;
};

export type CloudAgentAcpPlanEntry = {
  content: string;
  status?: string;
  priority?: string;
};

export type CloudAgentAcpPlanPayload = {
  entries: CloudAgentAcpPlanEntry[];
};

export type CloudAgentEventPayload =
  | CloudAgentUserMessagePayload
  | CloudAgentRunStartPayload
  | CloudAgentReasoningDeltaPayload
  | CloudAgentAssistantDeltaPayload
  | CloudAgentAssistantMessagePayload
  | CloudAgentAssistantRollbackPayload
  | CloudAgentToolCallStartPayload
  | CloudAgentToolCallArgsPayload
  | CloudAgentToolCallProgressPayload
  | CloudAgentToolCallResultPayload
  | CloudAgentRunStatusPayload
  | CloudAgentRunEndPayload
  | CloudAgentRunErrorPayload
  | CloudAgentRunLogPayload
  | CloudAgentMemoryUpdatedPayload
  | CloudAgentContextSourcesPayload
  | CloudAgentContextCompactingPayload
  | CloudAgentContextCompactedPayload
  | CloudAgentSessionUpdatePayload
  | CloudAgentQueueUpdatePayload
  | CloudAgentPermissionRequestPayload
  | CloudAgentPermissionResolvedPayload
  | CloudAgentElicitationRequestPayload
  | CloudAgentElicitationResolvedPayload
  | CloudAgentAcpPlanPayload;

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
  /** 固定到某个模型路由；未设置时按 model alias 动态路由 */
  modelRouteId?: string;
  /**
   * 上下文压缩专用模型 alias（宜选便宜/快的小模型）。
   * 未设置时回退到 model / modelRouteId / 租户默认 chat 路由。
   */
  compactModel?: string;
  /** 压缩专用固定路由 id；优先于 compactModel */
  compactModelRouteId?: string;
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
  /**
   * Gateway 模型名转发：客户端请求的 model → 实际路由 alias。
   * O(1) 查找，未命中则原样使用。例：`{ "gpt-5.1-codex": "gpt-5.1" }`。
   */
  gatewayModelMap?: Record<string, string>;
  /**
   * 历史超长时自动 LLM 摘要压缩（默认 true）。
   * 开启后摘要是 Run 执行的一部分：超硬阈值时**同步**压缩再继续对话；
   * Run 结束后若仍超软阈值会预压缩，供下一轮使用。
   * 关闭后仅做工具结果就地截断，不调用模型生成摘要。
   */
  autoCompact?: boolean;
  /** 硬阈值：达到则在本 Run 内同步摘要（默认 60000 字符，最小 8000） */
  compactThresholdChars?: number;
  /**
   * 软阈值：Run 结束后预压缩（默认 hard×0.7）。
   * 应 ≤ compactThresholdChars。
   */
  compactSoftThresholdChars?: number;
  /** 压缩后保留的最近消息条数上限（默认 16，范围 4–64） */
  compactKeepRecent?: number;
  /** 压缩后尽量保留的最近上下文字符量（默认 24000，按 user turn 边界切） */
  compactKeepRecentChars?: number;
  /** 单条工具结果进入模型前的字符上限（默认 12000） */
  maxToolResultChars?: number;
  /**
   * 运行中用户再发消息时的策略（默认 steer）：
   * - steer：下一工具批结束后注入当前 Run（Codex 式纠偏）
   * - queue：等当前 Run 整轮结束后再开新回合
   */
  followUpMode?: CloudAgentFollowUpMode;
};

export type CloudAgentRunOptions = {
  reasoning?: import("./model-router.js").ModelReasoningOptions;
  /**
   * 用户在输入框显式指定本回合要使用的技能名（Composer 的 Skill 菜单）。
   * 会写进 system prompt 要求 Agent 先读 SKILL.md 再执行。
   */
  skills?: string[];
  /**
   * 本回合禁用的工具，取模型可见的限定名（如 re_web_search）。
   * 用户在 Composer 的「连接器」面板里关掉的连接器 / MCP / 内置工具会展开成具体工具名。
   */
  disabledTools?: string[];
};

/** Composer 加号菜单里可开关的一组工具（内置能力 / MCP 实例 / 连接器） */
export type ComposerToolGroupKind = "builtin" | "mcp" | "connector";

export type ComposerToolGroup = {
  id: string;
  kind: ComposerToolGroupKind;
  label: string;
  tools: string[];
};

export type ComposerSkillOption = {
  name: string;
  title: string;
  description: string;
};

export type ComposerCapabilities = {
  skills: ComposerSkillOption[];
  groups: ComposerToolGroup[];
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
  if (typeof cloud.modelRouteId === "string" && cloud.modelRouteId.trim()) {
    out.modelRouteId = cloud.modelRouteId.trim();
  }
  if (typeof cloud.compactModel === "string" && cloud.compactModel.trim()) {
    out.compactModel = cloud.compactModel.trim();
  }
  if (typeof cloud.compactModelRouteId === "string" && cloud.compactModelRouteId.trim()) {
    out.compactModelRouteId = cloud.compactModelRouteId.trim();
  }
  if (typeof cloud.maxToolRounds === "number" && cloud.maxToolRounds > 0) {
    out.maxToolRounds = Math.floor(cloud.maxToolRounds);
  }
  if (typeof cloud.maxSubagentDepth === "number" && cloud.maxSubagentDepth >= 1) {
    out.maxSubagentDepth = Math.min(Math.floor(cloud.maxSubagentDepth), 5);
  }
  if (typeof cloud.enableTools === "boolean") out.enableTools = cloud.enableTools;
  if (typeof cloud.autoMemory === "boolean") out.autoMemory = cloud.autoMemory;
  if (typeof cloud.autoTitle === "boolean") out.autoTitle = cloud.autoTitle;
  if (
    cloud.gatewayModelMap &&
    typeof cloud.gatewayModelMap === "object" &&
    !Array.isArray(cloud.gatewayModelMap)
  ) {
    const map: Record<string, string> = {};
    for (const [rawFrom, rawTo] of Object.entries(
      cloud.gatewayModelMap as Record<string, unknown>,
    )) {
      const from = rawFrom.trim();
      const to = typeof rawTo === "string" ? rawTo.trim() : "";
      if (from && to) map[from] = to;
    }
    if (Object.keys(map).length) out.gatewayModelMap = map;
  }
  if (typeof cloud.autoCompact === "boolean") out.autoCompact = cloud.autoCompact;
  if (typeof cloud.compactThresholdChars === "number" && cloud.compactThresholdChars >= 8_000) {
    out.compactThresholdChars = Math.floor(cloud.compactThresholdChars);
  }
  if (
    typeof cloud.compactSoftThresholdChars === "number" &&
    cloud.compactSoftThresholdChars >= 4_000
  ) {
    out.compactSoftThresholdChars = Math.floor(cloud.compactSoftThresholdChars);
  }
  if (typeof cloud.compactKeepRecent === "number" && cloud.compactKeepRecent >= 4) {
    out.compactKeepRecent = Math.min(Math.floor(cloud.compactKeepRecent), 64);
  }
  if (
    typeof cloud.compactKeepRecentChars === "number" &&
    cloud.compactKeepRecentChars >= 4_000
  ) {
    out.compactKeepRecentChars = Math.min(Math.floor(cloud.compactKeepRecentChars), 200_000);
  }
  if (typeof cloud.maxToolResultChars === "number" && cloud.maxToolResultChars >= 1_000) {
    out.maxToolResultChars = Math.min(Math.floor(cloud.maxToolResultChars), 80_000);
  }
  if (cloud.followUpMode === "steer" || cloud.followUpMode === "queue") {
    out.followUpMode = cloud.followUpMode;
  }
  return out;
}

/** 未配置时默认 steer（下一工具后再注入） */
export function resolveFollowUpMode(cloud: CloudAgentConfig): CloudAgentFollowUpMode {
  return cloud.followUpMode === "queue" ? "queue" : "steer";
}
