/**
 * 平台连接器的认证声明。
 *
 * 设计要点：连接器不直接持有凭据，而是引用一个**命名凭据档案**（auth profile）。
 * 多个连接器写同一个 profile 名即共享同一份客户端；管理员也可以按名字整站预配，
 * 甚至预配目录里尚不存在的名字，供后续连接器或上游 MCP 引用。
 *
 * 所有形态都由目录 JSON 声明，业务代码不枚举厂商。
 */

/** 连接器需要用户提供什么 */
export type ConnectorAuthKind =
  /** 什么都不需要，安装即可用 */
  | "none"
  /** OAuth2 授权码流，需要一份 Client ID/Secret（自配或平台预配） */
  | "oauth2"
  /** OAuth2 动态客户端注册，授权时自动拿到客户端，无需配置 */
  | "oauth2_dynamic"
  /** 静态令牌 / API Key，直接调用，不走授权跳转 */
  | "token"
  /** 任意自定义字段组合 */
  | "custom";

export const CONNECTOR_AUTH_KINDS: readonly ConnectorAuthKind[] = [
  "none",
  "oauth2",
  "oauth2_dynamic",
  "token",
  "custom",
];

export type ConnectorFieldType =
  | "text"
  | "secret"
  | "url"
  | "textarea"
  | "select"
  | "boolean";

export interface ConnectorFieldOption {
  value: string;
  label: string;
}

export interface ConnectorField {
  key: string;
  label: string;
  type: ConnectorFieldType;
  required?: boolean;
  placeholder?: string;
  /** 字段下方的说明文字 */
  help?: string;
  /** type === "select" 时的候选项 */
  options?: ConnectorFieldOption[];
  defaultValue?: string;
}

/** 归一化后的连接器认证声明。目录里的 legacy 写法也会被折算成这个形状。 */
export interface ConnectorAuthSpec {
  kind: ConnectorAuthKind;
  /** 命名凭据档案键；缺省取连接器 ref */
  profile: string;
  /** 档案展示名，管理员预配列表用 */
  profileLabel?: string;
  /** 档案级字段，随档案共享 */
  fields: ConnectorField[];
  /** 连接器级字段，不随档案共享（如自建实例地址） */
  settings: ConnectorField[];
  docsUrl?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  authorizeParams?: Record<string, string>;
  /** token 型：凭据里哪个字段是令牌本身 */
  tokenField?: string;
  /** token 注入的请求头，默认 Authorization */
  tokenHeader?: string;
  /** token 注入的前缀，默认 Bearer；空字符串表示直接写裸令牌 */
  tokenScheme?: string;
}

/** 连接器在某个 scope 下的可用状态 */
export type ConnectorStatus =
  /** 凭据齐备（或本就不需要凭据），可以安装/授权 */
  | "ready"
  /** 由平台整站预配的档案供给，团队无需也不可配置 */
  | "platform-provisioned"
  /** 还缺必要配置 */
  | "needs-config"
  /** 有凭据但被显式停用 */
  | "disabled";

/** 凭据来源 */
export type ConnectorCredentialSource = "tenant" | "platform";

const FIELD_TYPES: readonly ConnectorFieldType[] = [
  "text",
  "secret",
  "url",
  "textarea",
  "select",
  "boolean",
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeField(raw: unknown): ConnectorField | null {
  const item = asRecord(raw);
  const key = asString(item.key);
  if (!key) return null;
  // textarea 在存储与校验上等同 text，仅影响渲染控件
  const rawType = asString(item.type) ?? "text";
  const type = (FIELD_TYPES as readonly string[]).includes(rawType)
    ? (rawType as ConnectorFieldType)
    : "text";
  const options = Array.isArray(item.options)
    ? item.options
        .map((option) => {
          const entry = asRecord(option);
          const value = asString(entry.value);
          return value ? { value, label: asString(entry.label) ?? value } : null;
        })
        .filter((option): option is ConnectorFieldOption => option !== null)
    : undefined;
  return {
    key,
    label: asString(item.label) ?? key,
    type,
    required: item.required === true,
    placeholder: asString(item.placeholder),
    help: asString(item.help),
    options: options?.length ? options : undefined,
    defaultValue: asString(item.defaultValue),
  };
}

function normalizeFields(raw: unknown): ConnectorField[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeField)
    .filter((field): field is ConnectorField => field !== null);
}

function normalizeParams(raw: unknown): Record<string, string> | undefined {
  const record = asRecord(raw);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 旧目录写法 → ConnectorAuthKind */
function kindFromLegacy(
  credentialKind: string | undefined,
  hasFields: boolean,
): ConnectorAuthKind {
  switch (credentialKind) {
    case "oauth2_dynamic":
      return "oauth2_dynamic";
    case "oauth2_client":
    case "oauth2":
      return "oauth2";
    case "token":
    case "api_key":
      return "token";
    case "none":
      return "none";
    case "custom":
      return "custom";
    default:
      return hasFields ? "custom" : "none";
  }
}

/**
 * 把目录组件的 config 归一化成 ConnectorAuthSpec。
 * 同时接受新写法（config.auth）与旧写法（config.credentialKind + config.fields）。
 */
export function normalizeConnectorAuth(
  connectorRef: string,
  config: Record<string, unknown>,
): ConnectorAuthSpec {
  const auth = asRecord(config.auth);
  const source = Object.keys(auth).length ? auth : config;

  const declaredKind = asString(source.kind);
  const fields = normalizeFields(source.fields ?? config.fields);
  const kind =
    declaredKind && (CONNECTOR_AUTH_KINDS as readonly string[]).includes(declaredKind)
      ? (declaredKind as ConnectorAuthKind)
      : kindFromLegacy(asString(source.credentialKind ?? config.credentialKind), fields.length > 0);

  const tokenField =
    asString(source.tokenField) ??
    (kind === "token" ? (fields.find((f) => f.type === "secret")?.key ?? "token") : undefined);

  return {
    kind,
    profile: asString(source.profile) ?? connectorRef,
    profileLabel: asString(source.profileLabel),
    fields: kind === "none" || kind === "oauth2_dynamic" ? [] : fields,
    settings: normalizeFields(source.settings ?? config.settings),
    docsUrl: asString(source.docsUrl ?? config.docsUrl),
    authorizationEndpoint: asString(source.authorizationEndpoint ?? config.authorizationEndpoint),
    tokenEndpoint: asString(source.tokenEndpoint ?? config.tokenEndpoint),
    authorizeParams: normalizeParams(source.authorizeParams ?? config.authorizeParams),
    tokenField,
    tokenHeader: asString(source.tokenHeader),
    tokenScheme: asString(source.tokenScheme),
  };
}

/** 该 kind 是否需要用户/管理员提供凭据 */
export function authNeedsCredentials(kind: ConnectorAuthKind): boolean {
  return kind === "oauth2" || kind === "token" || kind === "custom";
}

/** 该 kind 是否要走浏览器授权跳转 */
export function authNeedsUserGrant(kind: ConnectorAuthKind): boolean {
  return kind === "oauth2" || kind === "oauth2_dynamic";
}

/** 缺失的必填字段标签；用于保存前校验与状态推导 */
export function missingRequiredFields(
  fields: ConnectorField[],
  values: Record<string, unknown>,
): string[] {
  return fields
    .filter((field) => field.required && !String(values[field.key] ?? "").trim())
    .map((field) => field.label);
}

/**
 * 用凭据值替换字符串里的 {key} 占位符。
 * Microsoft 的 {tenantId} 只是其中一例，任何连接器都能自由声明占位符。
 */
export function interpolateWithValues(
  template: string | undefined,
  values: Record<string, unknown>,
  fallbacks: Record<string, string> = {},
): string | undefined {
  if (!template) return undefined;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = values[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    return fallbacks[key] ?? whole;
  });
}
