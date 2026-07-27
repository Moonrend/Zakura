/**
 * ChatGPT Apps SDK / MCP Apps 工具描述符兼容层。
 * @see https://developers.openai.com/apps-sdk/reference#tool-descriptor-parameters
 */

export interface McpToolAnnotations {
  /** 只读：不创建/更新/删除/外发 */
  readOnlyHint?: boolean;
  /** 可能删除或覆盖用户数据 */
  destructiveHint?: boolean;
  /** 可能发布内容或触及当前用户账户外的世界 */
  openWorldHint?: boolean;
  /** 相同参数重复调用无额外副作用 */
  idempotentHint?: boolean;
}

export type McpSecurityScheme =
  | { type: "noauth" }
  | { type: "oauth2"; scopes?: string[] };

/**
 * MCP tools/list 条目。
 * 扩展字段对齐 ChatGPT Apps SDK tool descriptor。
 */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 人类可读标题（ChatGPT / MCP Apps） */
  title?: string;
  /** 若返回 structuredContent，应声明对应 schema */
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  /** 顶层 securitySchemes（ChatGPT 优先读取） */
  securitySchemes?: McpSecurityScheme[];
  /**
   * 工具元数据：ui.resourceUri、openai/toolInvocation/*、
   * 以及 `_meta.securitySchemes` 兼容镜像等
   */
  _meta?: Record<string, unknown>;
  /** 2025-11-25 Tasks：声明该工具是否支持 task-augmented 调用 */
  execution?: {
    taskSupport?: "required" | "optional" | "forbidden";
  };
}

export interface McpToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "resource"; uri: string; text?: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
  /** 模型与组件可见的结构化结果；需与 outputSchema 一致 */
  structuredContent?: Record<string, unknown>;
  /** 仅组件可见（模型不可见），如完整数据集 */
  _meta?: Record<string, unknown>;
}

/** Zakura Agent MCP 对外默认鉴权（OAuth 2.1 scope=mcp） */
export const DEFAULT_MCP_OAUTH_SCHEMES: McpSecurityScheme[] = [
  { type: "oauth2", scopes: ["mcp"] },
];

export type PublicMcpToolDescriptor = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: McpToolAnnotations;
  securitySchemes: McpSecurityScheme[];
  _meta: Record<string, unknown>;
  execution?: {
    taskSupport?: "required" | "optional" | "forbidden";
  };
};

const READ_ONLY_NAMES = new Set([
  "agent_info",
  "list_exposers",
  "list_exposures",
  "list_file_urls",
  "fs_read",
  "fs_list",
  "fs_stat",
  "browser_observe",
  "search_memory",
  "list_memories",
  "get_memory",
  "memory_stats",
  "memory_context",
  "memory_graph",
  "containers_list",
  "containers_logs",
  "instances_list",
  "agents_list",
  "web_search",
  "web_fetch",
]);

const DESTRUCTIVE_NAMES = new Set([
  "fs_delete",
  "delete_memory",
  "containers_stop",
  "unexpose_port",
  "revoke_file_url",
  "fs_write",
  "fs_edit",
  "fs_move",
]);

const OPEN_WORLD_NAMES = new Set([
  "shell_exec",
  "browser_action",
  "web_search",
  "web_fetch",
  "expose_port",
  "get_file_url",
]);

/** 从工具名推断 ChatGPT 要求的 annotations */
export function inferToolAnnotations(
  localName: string,
  existing?: McpToolAnnotations | null,
): McpToolAnnotations {
  const base = localName.replace(/^re_/, "").replace(/^.*__/, "");
  const readOnly =
    existing?.readOnlyHint ??
    (READ_ONLY_NAMES.has(base) ||
      base.startsWith("list_") ||
      (base.startsWith("get_") && base !== "get_file_url") ||
      base.endsWith("_list") ||
      base.endsWith("_info") ||
      base.endsWith("_stats") ||
      base.includes("search") ||
      base.includes("observe"));
  const destructive =
    existing?.destructiveHint ??
    (DESTRUCTIVE_NAMES.has(base) ||
      base.includes("delete") ||
      base.includes("remove") ||
      base.includes("destroy"));
  const openWorld =
    existing?.openWorldHint ??
    (OPEN_WORLD_NAMES.has(base) ||
      base.includes("shell") ||
      base.includes("fetch") ||
      base.includes("http") ||
      base.includes("browser_action") ||
      base.includes("expose"));

  const out: McpToolAnnotations = {
    readOnlyHint: Boolean(readOnly),
    destructiveHint: Boolean(destructive),
    openWorldHint: Boolean(openWorld),
  };
  if (existing?.idempotentHint != null) {
    out.idempotentHint = existing.idempotentHint;
  } else if (out.readOnlyHint) {
    out.idempotentHint = true;
  }
  return out;
}

export function humanizeToolTitle(name: string, existing?: string | null): string {
  if (existing?.trim()) return existing.trim();
  const base = name.replace(/^re_/, "").replace(/__/g, " / ");
  return base
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function clampStatus(text: string, fallback: string): string {
  const t = text.trim() || fallback;
  return t.length <= 64 ? t : `${t.slice(0, 61)}…`;
}

function defaultInvocationMeta(title: string): Record<string, string> {
  return {
    "openai/toolInvocation/invoking": clampStatus(`Running ${title}…`, "Running…"),
    "openai/toolInvocation/invoked": clampStatus(`${title} done`, "Done"),
  };
}

/**
 * 将内部工具定义规范化为 ChatGPT / MCP Apps 期望的 tools/list 条目。
 * - 必填 annotations（readOnly / destructive / openWorld）
 * - securitySchemes + `_meta.securitySchemes` 双写（兼容只读 _meta 的客户端）
 * - title、可选 outputSchema、调用状态文案
 */
export function toPublicToolDescriptor(
  tool: Pick<
    McpToolDef,
    | "name"
    | "title"
    | "description"
    | "inputSchema"
    | "outputSchema"
    | "annotations"
    | "securitySchemes"
    | "_meta"
    | "execution"
  > & { name: string },
  opts?: {
    /** 对外公开名（如带 re_ 前缀的 qualifiedName） */
    publicName?: string;
    /** 覆盖默认 oauth2 scopes */
    securitySchemes?: McpSecurityScheme[];
  },
): PublicMcpToolDescriptor {
  const name = opts?.publicName ?? tool.name;
  const title = humanizeToolTitle(name, tool.title);
  const annotations = inferToolAnnotations(tool.name, tool.annotations);
  const securitySchemes =
    opts?.securitySchemes ??
    (tool.securitySchemes?.length ? tool.securitySchemes : DEFAULT_MCP_OAUTH_SCHEMES);

  const meta: Record<string, unknown> = {
    ...defaultInvocationMeta(title),
    ...(tool._meta && typeof tool._meta === "object" ? tool._meta : {}),
    securitySchemes,
  };

  // 透传 UI 模板时同步 openai/outputTemplate 兼容别名
  const ui = meta.ui;
  if (ui && typeof ui === "object" && !Array.isArray(ui)) {
    const resourceUri = (ui as Record<string, unknown>).resourceUri;
    if (typeof resourceUri === "string" && resourceUri && !meta["openai/outputTemplate"]) {
      meta["openai/outputTemplate"] = resourceUri;
    }
  }

  const descriptor: PublicMcpToolDescriptor = {
    name,
    title,
    description: tool.description || title,
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    annotations,
    securitySchemes,
    _meta: meta,
  };
  if (tool.outputSchema && typeof tool.outputSchema === "object") {
    descriptor.outputSchema = tool.outputSchema;
  }
  if (tool.execution?.taskSupport) {
    descriptor.execution = { taskSupport: tool.execution.taskSupport };
  }
  return descriptor;
}

/** 从上游 tools/list 原始条目提取扩展字段（不丢 annotations/_meta 等） */
export function pickUpstreamToolFields(raw: Record<string, unknown>): Partial<McpToolDef> {
  const out: Partial<McpToolDef> = {};
  if (typeof raw.title === "string") out.title = raw.title;
  if (raw.outputSchema && typeof raw.outputSchema === "object") {
    out.outputSchema = raw.outputSchema as Record<string, unknown>;
  }
  if (raw.annotations && typeof raw.annotations === "object") {
    out.annotations = raw.annotations as McpToolAnnotations;
  }
  if (Array.isArray(raw.securitySchemes)) {
    out.securitySchemes = raw.securitySchemes as McpSecurityScheme[];
  }
  if (raw._meta && typeof raw._meta === "object") {
    out._meta = raw._meta as Record<string, unknown>;
  }
  if (raw.execution && typeof raw.execution === "object") {
    const ts = (raw.execution as { taskSupport?: unknown }).taskSupport;
    if (ts === "required" || ts === "optional" || ts === "forbidden") {
      out.execution = { taskSupport: ts };
    }
  }
  return out;
}

/** RFC 9728 + ChatGPT：Bearer resource_metadata=… */
export function buildWwwAuthenticateChallenge(opts: {
  resourceMetadataUrl: string;
  scope?: string;
  error?: string;
  errorDescription?: string;
}): string {
  const parts = [
    `Bearer resource_metadata="${opts.resourceMetadataUrl}"`,
    `scope="${opts.scope ?? "mcp"}"`,
  ];
  if (opts.error) parts.push(`error="${opts.error}"`);
  if (opts.errorDescription) {
    parts.push(`error_description="${opts.errorDescription.replace(/"/g, "'")}"`);
  }
  return parts.join(", ");
}

/**
 * ChatGPT 工具级 OAuth 触发：JSON-RPC result 内带 `_meta["mcp/www_authenticate"]`。
 * @see https://developers.openai.com/apps-sdk/build/auth
 */
export function authRequiredToolResult(opts: {
  resourceMetadataUrl: string;
  message?: string;
  scope?: string;
}): McpToolResult {
  const challenge = buildWwwAuthenticateChallenge({
    resourceMetadataUrl: opts.resourceMetadataUrl,
    scope: opts.scope ?? "mcp",
    error: "insufficient_scope",
    errorDescription: opts.message ?? "You need to login to continue",
  });
  return {
    content: [
      {
        type: "text",
        text: opts.message ?? "Authentication required: no access token provided.",
      },
    ],
    isError: true,
    _meta: {
      "mcp/www_authenticate": [challenge],
    },
  };
}

/** 规范化上游 tools/call 结果，保留 structuredContent / _meta */
export function normalizeToolResult(raw: unknown): McpToolResult {
  if (!raw || typeof raw !== "object") {
    return {
      content: [{ type: "text", text: String(raw ?? "") }],
    };
  }
  const obj = raw as Record<string, unknown>;
  const content = Array.isArray(obj.content)
    ? (obj.content as McpToolResult["content"])
    : [{ type: "text" as const, text: JSON.stringify(raw, null, 2) }];
  const result: McpToolResult = {
    content,
    isError: obj.isError === true,
  };
  if (obj.structuredContent && typeof obj.structuredContent === "object") {
    result.structuredContent = obj.structuredContent as Record<string, unknown>;
  }
  if (obj._meta && typeof obj._meta === "object") {
    result._meta = obj._meta as Record<string, unknown>;
  }
  return result;
}

/** 2025-11-25 CreateTaskResult 形态检测 */
export type McpCreateTaskResult = {
  task: {
    taskId: string;
    status: string;
    ttl: number | null;
    createdAt: string;
    lastUpdatedAt: string;
    pollInterval?: number;
    statusMessage?: string;
  };
  _meta?: Record<string, unknown>;
};

export function isCreateTaskResult(raw: unknown): raw is McpCreateTaskResult {
  if (!raw || typeof raw !== "object") return false;
  const task = (raw as { task?: unknown }).task;
  if (!task || typeof task !== "object") return false;
  return typeof (task as { taskId?: unknown }).taskId === "string";
}

/**
 * 重写工具 _meta 中的 MCP Apps UI 资源 URI（聚合限定）。
 * qualifyUri(localUri) → 对外 URI。
 */
export function rewriteToolUiMeta(
  meta: Record<string, unknown> | undefined,
  qualifyUri: (localUri: string) => string,
): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const next: Record<string, unknown> = { ...meta };
  const ui = next.ui;
  if (ui && typeof ui === "object" && !Array.isArray(ui)) {
    const uiObj = { ...(ui as Record<string, unknown>) };
    if (typeof uiObj.resourceUri === "string" && uiObj.resourceUri) {
      uiObj.resourceUri = qualifyUri(uiObj.resourceUri);
    }
    next.ui = uiObj;
  }
  if (typeof next["openai/outputTemplate"] === "string" && next["openai/outputTemplate"]) {
    next["openai/outputTemplate"] = qualifyUri(String(next["openai/outputTemplate"]));
  }
  return next;
}

/** 适合声明 taskSupport=optional 的长耗时工具名（本地名） */
export const DEFAULT_TASK_OPTIONAL_TOOLS = new Set([
  "shell_exec",
  "shell_run",
  "containers_create",
  "containers_exec",
  "computer_click",
  "computer_type",
  "computer_key",
  "browser_act",
]);
