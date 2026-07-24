/**
 * MCP resources / prompts 共享类型（对齐 @modelcontextprotocol/sdk）。
 */

export interface McpResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  title?: string;
  _meta?: Record<string, unknown>;
}

export interface McpResourceTemplateDef {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
  title?: string;
  _meta?: Record<string, unknown>;
}

export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
}

export interface McpReadResourceResult {
  contents: McpResourceContents[];
  _meta?: Record<string, unknown>;
}

export interface McpPromptArgumentDef {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptDef {
  name: string;
  description?: string;
  title?: string;
  arguments?: McpPromptArgumentDef[];
  _meta?: Record<string, unknown>;
}

export type McpPromptMessageContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "resource";
      resource: {
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
      };
    };

export interface McpPromptMessage {
  role: "user" | "assistant";
  content: McpPromptMessageContent;
}

export interface McpGetPromptResult {
  description?: string;
  messages: McpPromptMessage[];
  _meta?: Record<string, unknown>;
}

/** completion/complete 的引用目标 */
export type McpCompleteRef =
  | { type: "ref/prompt"; name: string }
  | { type: "ref/resource"; uri: string };

export interface McpCompleteArgument {
  name: string;
  value: string;
}

export interface McpCompleteParams {
  ref: McpCompleteRef;
  argument: McpCompleteArgument;
}

export interface McpCompleteResult {
  completion: {
    values: string[];
    total?: number;
    hasMore?: boolean;
  };
  _meta?: Record<string, unknown>;
}

/** 将上游 resources/templates/list 条目规范为 McpResourceTemplateDef */
export function normalizeResourceTemplateDef(
  raw: Record<string, unknown>,
): McpResourceTemplateDef | null {
  const uriTemplate = typeof raw.uriTemplate === "string" ? raw.uriTemplate : "";
  if (!uriTemplate) return null;
  const name =
    typeof raw.name === "string" && raw.name ? raw.name : uriTemplate;
  return {
    uriTemplate,
    name,
    description: typeof raw.description === "string" ? raw.description : undefined,
    mimeType: typeof raw.mimeType === "string" ? raw.mimeType : undefined,
    title: typeof raw.title === "string" ? raw.title : undefined,
    _meta:
      raw._meta && typeof raw._meta === "object"
        ? (raw._meta as Record<string, unknown>)
        : undefined,
  };
}

/** 将上游 resources/list 条目规范为 McpResourceDef */
export function normalizeResourceDef(raw: Record<string, unknown>): McpResourceDef | null {
  const uri = typeof raw.uri === "string" ? raw.uri : "";
  if (!uri) return null;
  const name = typeof raw.name === "string" && raw.name ? raw.name : uri;
  return {
    uri,
    name,
    description: typeof raw.description === "string" ? raw.description : undefined,
    mimeType: typeof raw.mimeType === "string" ? raw.mimeType : undefined,
    title: typeof raw.title === "string" ? raw.title : undefined,
    _meta:
      raw._meta && typeof raw._meta === "object"
        ? (raw._meta as Record<string, unknown>)
        : undefined,
  };
}

/** 将上游 prompts/list 条目规范为 McpPromptDef */
export function normalizePromptDef(raw: Record<string, unknown>): McpPromptDef | null {
  const name = typeof raw.name === "string" ? raw.name : "";
  if (!name) return null;
  const argsRaw = raw.arguments;
  let args: McpPromptArgumentDef[] | undefined;
  if (Array.isArray(argsRaw)) {
    args = [];
    for (const a of argsRaw) {
      if (!a || typeof a !== "object") continue;
      const o = a as Record<string, unknown>;
      if (typeof o.name !== "string" || !o.name) continue;
      args.push({
        name: o.name,
        description: typeof o.description === "string" ? o.description : undefined,
        required: typeof o.required === "boolean" ? o.required : undefined,
      });
    }
  }
  return {
    name,
    description: typeof raw.description === "string" ? raw.description : undefined,
    title: typeof raw.title === "string" ? raw.title : undefined,
    arguments: args,
    _meta:
      raw._meta && typeof raw._meta === "object"
        ? (raw._meta as Record<string, unknown>)
        : undefined,
  };
}

export function normalizeReadResourceResult(raw: unknown): McpReadResourceResult {
  if (!raw || typeof raw !== "object") return { contents: [] };
  const contents = (raw as { contents?: unknown }).contents;
  if (!Array.isArray(contents)) return { contents: [] };
  return {
    contents: contents
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .map((c) => ({
        uri: typeof c.uri === "string" ? c.uri : "",
        mimeType: typeof c.mimeType === "string" ? c.mimeType : undefined,
        text: typeof c.text === "string" ? c.text : undefined,
        blob: typeof c.blob === "string" ? c.blob : undefined,
        _meta:
          c._meta && typeof c._meta === "object"
            ? (c._meta as Record<string, unknown>)
            : undefined,
      }))
      .filter((c) => c.uri),
    _meta:
      (raw as { _meta?: unknown })._meta &&
      typeof (raw as { _meta?: unknown })._meta === "object"
        ? ((raw as { _meta: Record<string, unknown> })._meta)
        : undefined,
  };
}

export function normalizeGetPromptResult(raw: unknown): McpGetPromptResult {
  if (!raw || typeof raw !== "object") return { messages: [] };
  const o = raw as Record<string, unknown>;
  const messagesRaw = o.messages;
  const messages: McpPromptMessage[] = [];
  if (Array.isArray(messagesRaw)) {
    for (const m of messagesRaw) {
      if (!m || typeof m !== "object") continue;
      const msg = m as Record<string, unknown>;
      const role = msg.role === "assistant" ? "assistant" : "user";
      const content = msg.content;
      if (!content || typeof content !== "object") continue;
      messages.push({
        role,
        content: content as McpPromptMessageContent,
      });
    }
  }
  return {
    description: typeof o.description === "string" ? o.description : undefined,
    messages,
    _meta:
      o._meta && typeof o._meta === "object"
        ? (o._meta as Record<string, unknown>)
        : undefined,
  };
}

export function normalizeCompleteResult(raw: unknown): McpCompleteResult {
  if (!raw || typeof raw !== "object") {
    return { completion: { values: [] } };
  }
  const o = raw as Record<string, unknown>;
  const completion = o.completion;
  if (!completion || typeof completion !== "object") {
    return { completion: { values: [] } };
  }
  const c = completion as Record<string, unknown>;
  const valuesRaw = c.values;
  const values = Array.isArray(valuesRaw)
    ? valuesRaw.filter((v): v is string => typeof v === "string")
    : [];
  return {
    completion: {
      values,
      total: typeof c.total === "number" ? c.total : undefined,
      hasMore: typeof c.hasMore === "boolean" ? c.hasMore : undefined,
    },
    _meta:
      o._meta && typeof o._meta === "object"
        ? (o._meta as Record<string, unknown>)
        : undefined,
  };
}
