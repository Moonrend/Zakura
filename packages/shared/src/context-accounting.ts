/**
 * 上下文长度计量：CJK 感知的 token 估算 + 上游 measured usage 校准。
 * 服务端压缩阈值与前端上下文环共用，避免「条显示 40% 已 overflow」。
 */

/** CJK 与全角假名等：近似 1 字 ≈ 1 token */
const CJK_RE =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/g;

/** 默认输出预留（回复 + 工具调用余量） */
export const DEFAULT_CONTEXT_RESERVE_TOKENS = 8_192;

/** 无模型元数据时的兜底窗口 */
export const DEFAULT_CONTEXT_LIMIT_TOKENS = 128_000;

/**
 * 文本 → token 估算。
 * - CJK：约 1 token/字
 * - 其余（含空白、标点、拉丁）：约 4 字符/token
 * 比纯 length/4 更接近中英混排对话真实用量。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  const rest = text.replace(CJK_RE, () => {
    cjk += 1;
    return "";
  });
  const other = Math.ceil(rest.length / 4);
  return Math.max(0, cjk + other);
}

/** 仅有字符数时的粗估（拉丁偏置，兼容旧 beforeChars/afterChars） */
export function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

/** token → 字符预算（切分 keep 时用；保守按 4 扩） */
export function estimateCharsFromTokens(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.floor(tokens * 4);
}

export type EstimableChatMessage = {
  role?: string;
  content?: string | null;
  name?: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id?: string;
    function: { name: string; arguments: string };
  }>;
  /** 多模态 parts 的文本/占位 */
  parts?: Array<{ type?: string; text?: string }>;
};

/** 单条 chat message 的 framing + 正文 + tool_calls */
export function estimateMessageTokens(m: EstimableChatMessage): number {
  // role / 分隔等固定开销
  let n = 6;
  if (m.content) n += estimateTextTokens(m.content);
  if (m.name) n += estimateTextTokens(m.name) + 2;
  if (m.toolCallId) n += estimateTextTokens(m.toolCallId) + 2;
  if (m.parts?.length) {
    for (const p of m.parts) {
      if (p.type === "text" && p.text) n += estimateTextTokens(p.text);
      else if (p.type === "image_url" || p.type === "image") n += 85; // 视觉占位粗估
      else if (p.text) n += estimateTextTokens(p.text);
    }
  }
  if (m.toolCalls?.length) {
    for (const c of m.toolCalls) {
      n += 10;
      n += estimateTextTokens(c.function.name);
      n += estimateTextTokens(c.function.arguments ?? "");
      if (c.id) n += estimateTextTokens(c.id);
    }
  }
  return n;
}

export function estimateMessagesTokens(messages: EstimableChatMessage[]): number {
  let n = 3; // 会话级 priming
  for (const m of messages) n += estimateMessageTokens(m);
  return n;
}

export type EstimableToolDefinition = {
  type?: string;
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
  /** 延迟加载工具对 prompt 的税更低，仅计名与 namespace 提示 */
  deferLoading?: boolean;
};

/** 工具定义 schema 税；defer 工具只计轻量条目 */
export function estimateToolDefinitionsTokens(
  tools: EstimableToolDefinition[] | null | undefined,
): number {
  if (!tools?.length) return 0;
  let n = 4;
  for (const t of tools) {
    if (t.deferLoading) {
      n += 6 + estimateTextTokens(t.function.name);
      continue;
    }
    n += 12;
    n += estimateTextTokens(t.function.name);
    n += estimateTextTokens(t.function.description ?? "");
    try {
      n += estimateTextTokens(JSON.stringify(t.function.parameters ?? {}));
    } catch {
      n += 32;
    }
  }
  return n;
}

/** 一轮请求的上下文体积（消息 + 工具定义） */
export function estimateRequestTokens(input: {
  messages: EstimableChatMessage[];
  tools?: EstimableToolDefinition[] | null;
}): number {
  return (
    estimateMessagesTokens(input.messages) +
    estimateToolDefinitionsTokens(input.tools)
  );
}

/**
 * 用上游返回的 prompt_tokens 校准估算器。
 * measuredAtEstimate = 该次请求时我们的 estimateRequestTokens。
 */
export type TokenCalibration = {
  measuredPromptTokens: number;
  estimatedAtMeasure: number;
};

export function applyTokenCalibration(
  currentEstimate: number,
  cal?: TokenCalibration | null,
): number {
  if (
    !cal ||
    cal.estimatedAtMeasure <= 0 ||
    cal.measuredPromptTokens <= 0 ||
    currentEstimate <= 0
  ) {
    return Math.max(0, Math.ceil(currentEstimate));
  }
  const ratio = cal.measuredPromptTokens / cal.estimatedAtMeasure;
  // 不同模型 tokenizer 差异大，限制校准幅度避免抖动
  const clamped = Math.min(2.2, Math.max(0.45, ratio));
  return Math.max(1, Math.ceil(currentEstimate * clamped));
}

export type ContextSizeReport = {
  /** 估算 token（消息+工具） */
  estimatedTokens: number;
  /** 校准后（若有 measured） */
  calibratedTokens: number;
  /** 用于决策的有效用量 */
  effectiveTokens: number;
  messagesTokens: number;
  toolsTokens: number;
  measuredPromptTokens?: number;
  calibrationRatio?: number;
};

export function reportContextSize(input: {
  messages: EstimableChatMessage[];
  tools?: EstimableToolDefinition[] | null;
  calibration?: TokenCalibration | null;
}): ContextSizeReport {
  const messagesTokens = estimateMessagesTokens(input.messages);
  const toolsTokens = estimateToolDefinitionsTokens(input.tools);
  const estimatedTokens = messagesTokens + toolsTokens;
  const calibratedTokens = applyTokenCalibration(estimatedTokens, input.calibration);
  const ratio =
    input.calibration && input.calibration.estimatedAtMeasure > 0
      ? input.calibration.measuredPromptTokens / input.calibration.estimatedAtMeasure
      : undefined;
  return {
    estimatedTokens,
    calibratedTokens,
    effectiveTokens: calibratedTokens,
    messagesTokens,
    toolsTokens,
    measuredPromptTokens: input.calibration?.measuredPromptTokens,
    calibrationRatio: ratio,
  };
}

/**
 * 基于模型窗口的 token 预算（硬/软阈值）。
 * 用户 char 配置会换算为 token 后与窗口可用量取更严。
 */
export type ContextWindowBudget = {
  contextLimitTokens: number;
  reserveTokens: number;
  /** 可用于 prompt 的 token（limit - reserve） */
  usableTokens: number;
  hardTokens: number;
  softTokens: number;
  keepRecentTokens: number;
  inLoopTokens: number;
  /** 与旧字符切分兼容 */
  hardChars: number;
  softChars: number;
  keepRecentChars: number;
  inLoopChars: number;
  maxToolResultChars: number;
};

export function resolveContextWindowBudget(input?: {
  contextLimitTokens?: number | null;
  reserveTokens?: number;
  /** 用户配置的硬阈值字符（可选） */
  thresholdChars?: number | null;
  softThresholdChars?: number | null;
  keepRecentChars?: number | null;
  maxToolResultChars?: number | null;
  softRatio?: number;
}): ContextWindowBudget {
  const softRatio =
    typeof input?.softRatio === "number" && input.softRatio > 0.3 && input.softRatio < 0.95
      ? input.softRatio
      : 0.7;
  const limit =
    typeof input?.contextLimitTokens === "number" && input.contextLimitTokens >= 4_000
      ? Math.floor(input.contextLimitTokens)
      : DEFAULT_CONTEXT_LIMIT_TOKENS;
  const reserve = Math.min(
    Math.max(input?.reserveTokens ?? DEFAULT_CONTEXT_RESERVE_TOKENS, 1_024),
    Math.floor(limit * 0.4),
  );
  const usableTokens = Math.max(2_000, limit - reserve);

  // 硬阈值：可用窗口 85%；若用户配了 char 阈值则再收紧
  let hardTokens = Math.floor(usableTokens * 0.85);
  if (typeof input?.thresholdChars === "number" && input.thresholdChars >= 8_000) {
    hardTokens = Math.min(hardTokens, estimateTokensFromChars(input.thresholdChars));
  }
  hardTokens = Math.max(2_000, hardTokens);

  let softTokens = Math.floor(hardTokens * softRatio);
  if (typeof input?.softThresholdChars === "number" && input.softThresholdChars >= 4_000) {
    softTokens = Math.min(softTokens, estimateTokensFromChars(input.softThresholdChars));
  }
  softTokens = Math.max(1_000, Math.min(softTokens, hardTokens));

  let keepRecentTokens = Math.floor(hardTokens * 0.35);
  if (typeof input?.keepRecentChars === "number" && input.keepRecentChars >= 4_000) {
    keepRecentTokens = Math.min(
      keepRecentTokens,
      estimateTokensFromChars(input.keepRecentChars),
    );
  }
  keepRecentTokens = Math.max(800, keepRecentTokens);

  const inLoopTokens = Math.max(hardTokens, Math.floor(hardTokens * 1.15));
  const maxToolResultChars =
    typeof input?.maxToolResultChars === "number" && input.maxToolResultChars >= 1_000
      ? Math.min(Math.floor(input.maxToolResultChars), 80_000)
      : 12_000;

  return {
    contextLimitTokens: limit,
    reserveTokens: reserve,
    usableTokens,
    hardTokens,
    softTokens,
    keepRecentTokens,
    inLoopTokens,
    hardChars: estimateCharsFromTokens(hardTokens),
    softChars: estimateCharsFromTokens(softTokens),
    keepRecentChars: estimateCharsFromTokens(keepRecentTokens),
    inLoopChars: estimateCharsFromTokens(inLoopTokens),
    maxToolResultChars,
  };
}

/**
 * 事件流 → 文本权重（前端上下文环用）。
 * 与 estimateTextTokens 一致，避免再 /4。
 */
export function estimateEventPayloadTokens(payload: Record<string, unknown>): number {
  let n = 8;
  if (typeof payload.content === "string") n += estimateTextTokens(payload.content);
  if (typeof payload.delta === "string") n += estimateTextTokens(payload.delta);
  if (typeof payload.resultText === "string") {
    n += estimateTextTokens(payload.resultText.slice(0, 12_000));
  }
  if (typeof payload.arguments === "string") {
    n += estimateTextTokens(payload.arguments.slice(0, 4_000));
  }
  if (typeof payload.summary === "string") n += estimateTextTokens(payload.summary);
  if (typeof payload.detail === "string") n += estimateTextTokens(payload.detail);
  if (Array.isArray(payload.attachments)) n += payload.attachments.length * 40;
  return n;
}
