import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";
import { mcpOauthRedirectUri } from "./mcp-oauth-apps.js";

/** Google Workspace 所需启用的 Cloud API（本地 REST，无需 *mcp.googleapis.com） */
export const GOOGLE_WORKSPACE_MCP_SERVICES = [
  "gmail.googleapis.com",
  "drive.googleapis.com",
  "calendar-json.googleapis.com",
  "people.googleapis.com",
  "chat.googleapis.com",
] as const;

export const GOOGLE_MCP_PRODUCTS = [
  {
    id: "gmail",
    name: "Gmail",
    mcpUrl: "zakura://google-workspace/gmail",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
    ],
  },
  {
    id: "drive",
    name: "Google Drive",
    mcpUrl: "zakura://google-workspace/drive",
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ],
  },
  {
    id: "calendar",
    name: "Google Calendar",
    mcpUrl: "zakura://google-workspace/calendar",
    scopes: [
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ],
  },
  {
    id: "people",
    name: "Google People",
    mcpUrl: "zakura://google-workspace/people",
    scopes: [
      "https://www.googleapis.com/auth/contacts.readonly",
      "https://www.googleapis.com/auth/directory.readonly",
    ],
  },
  {
    id: "chat",
    name: "Google Chat",
    mcpUrl: "zakura://google-workspace/chat",
    scopes: [
      "https://www.googleapis.com/auth/chat.spaces.readonly",
      "https://www.googleapis.com/auth/chat.memberships.readonly",
      "https://www.googleapis.com/auth/chat.messages.readonly",
      "https://www.googleapis.com/auth/chat.messages.create",
      "https://www.googleapis.com/auth/chat.users.readstate.readonly",
    ],
  },
] as const;

/** 同意屏幕需一次性配置的完整 scopes（含 openid/email） */
export const GOOGLE_OAUTH_CONSENT_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  ...new Set(GOOGLE_MCP_PRODUCTS.flatMap((p) => p.scopes)),
] as const;

export type GoogleMcpProductId = (typeof GOOGLE_MCP_PRODUCTS)[number]["id"];


export type GoogleServiceAccountJson = {
  type?: string;
  project_id?: string;
  private_key?: string;
  client_email?: string;
  client_id?: string;
  token_uri?: string;
};

export type ProvisionCopyable = {
  label: string;
  value: string;
  /** 多行时用 monospace 展示 */
  multiline?: boolean;
};

export type ProvisionWizardAction = {
  kind: "open" | "click" | "fill" | "select" | "copy" | "paste";
  label: string;
  value?: string;
  hint?: string;
};

export type ProvisionWizardStep = {
  id: "project" | "enable-apis" | "chat-app" | "oauth-consent" | "oauth-client" | "save";
  title: string;
  description: string;
  /** api=尽量自动；manual=仅 Console；hybrid=可 SA 自动也可手动 */
  mode: "api" | "manual" | "hybrid";
  consoleUrl?: string;
  actions: ProvisionWizardAction[];
  copyables: ProvisionCopyable[];
};

export type GoogleProvisionResult = {
  projectId: string;
  enabled: string[];
  alreadyEnabled: string[];
  failed: Array<{ service: string; error: string }>;
  /**
   * Google 不提供公开 API 创建「普通 Web OAuth 客户端」（Gmail/Drive MCP 所需）。
   * IAP / Workforce 的 oauthClients API 不能用于 Workspace MCP，且已弃用。
   * 因此客户端创建仍须走 Console；我们返回分步引导与模拟 UI。
   */
  oauthClientAutomation: "unsupported";
  limitation: string;
  redirectUri: string;
  consoleLinks: {
    createProject: string;
    enableApis: string;
    oauthConsent: string;
    dataAccess: string;
    createOauthClient: string;
    credentials: string;
    serviceAccounts: string;
  };
  requiredScopes: Array<{ product: string; scopes: string[] }>;
  /** 所有 scopes 合并，便于一键粘贴到 Console「Manually add scopes」 */
  scopesPasteBlock: string;
  oauthClientName: string;
  gcloudScript: string;
  checklist?: string[];
  wizardSteps: ProvisionWizardStep[];
  sessionId?: string;
  /** SA 供应时：Cloud Resource Manager 校验结果 */
  projectInfo?: {
    projectId: string;
    name?: string;
    projectNumber?: string;
    state?: string;
    error?: string;
  };
  /** SA 供应时：各服务启用状态快照 */
  serviceStates?: Array<{
    service: string;
    state: "ENABLED" | "DISABLED" | "UNKNOWN" | string;
  }>;
};

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

export function parseServiceAccount(raw: unknown): GoogleServiceAccountJson {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) throw new Error("Service Account JSON 为空");
    try {
      return JSON.parse(trimmed) as GoogleServiceAccountJson;
    } catch {
      throw new Error("Service Account JSON 无法解析");
    }
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("请提供 Service Account JSON 对象或字符串");
  }
  return raw as GoogleServiceAccountJson;
}

function consoleLinksFor(projectId: string) {
  const q = encodeURIComponent(projectId);
  return {
    createProject: "https://console.cloud.google.com/projectcreate",
    enableApis: `https://console.cloud.google.com/apis/library?project=${q}`,
    chatApiConfig: `https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=${q}`,
    oauthConsent: `https://console.cloud.google.com/auth/branding?project=${q}`,
    dataAccess: `https://console.cloud.google.com/auth/scopes?project=${q}`,
    createOauthClient: `https://console.cloud.google.com/auth/clients/create?project=${q}`,
    credentials: `https://console.cloud.google.com/auth/clients?project=${q}`,
    serviceAccounts: `https://console.cloud.google.com/iam-admin/serviceaccounts?project=${q}`,
  };
}

const OAUTH_CLIENT_DISPLAY_NAME = "Zakura Workspace MCP";

function buildScopesPasteBlock(
  products?: Array<(typeof GOOGLE_MCP_PRODUCTS)[number]>,
): string {
  // 同意屏幕一次配齐：openid/email + 所选产品（默认全部）scopes
  const productScopes = (products?.length ? products : [...GOOGLE_MCP_PRODUCTS]).flatMap(
    (p) => p.scopes,
  );
  return [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    ...new Set(productScopes),
  ].join("\n");
}

/** 分步向导：短标题 + Console 链接 + 可复制字段 */
export function buildProvisionWizardSteps(opts: {
  projectId: string;
  redirectUri: string;
  products: Array<(typeof GOOGLE_MCP_PRODUCTS)[number]>;
  links: ReturnType<typeof consoleLinksFor>;
}): ProvisionWizardStep[] {
  const { projectId, redirectUri, products, links } = opts;
  const scopesPaste = buildScopesPasteBlock(products);
  const includeChat = products.some((p) => p.id === "chat");

  const steps: ProvisionWizardStep[] = [
    {
      id: "project",
      title: "项目",
      description: "",
      mode: "manual",
      consoleUrl: links.createProject,
      actions: [],
      copyables: [{ label: "项目名", value: "Zakura MCP" }],
    },
    {
      id: "enable-apis",
      title: "启用 API",
      description: "启用 Gmail / Drive / Calendar / People / Chat API",
      mode: "hybrid",
      consoleUrl: links.serviceAccounts,
      actions: [],
      copyables: [
        {
          label: "gcloud",
          value: [
            `gcloud config set project ${projectId}`,
            `gcloud services enable ${GOOGLE_WORKSPACE_MCP_SERVICES.join(" ")}`,
          ].join("\n"),
          multiline: true,
        },
      ],
    },
  ];

  if (includeChat) {
    steps.push({
      id: "chat-app",
      title: "Chat 应用",
      description:
        "仅启用 API 不够：须在 Chat API → Configuration 填写 App name 并保存（可关闭 Interactive features）。需 Workspace 账号。",
      mode: "manual",
      consoleUrl: links.chatApiConfig,
      actions: [],
      copyables: [
        { label: "App name", value: "Zakura Workspace MCP" },
        {
          label: "Avatar URL",
          value: "https://developers.google.com/static/chat/images/quickstart-app-avatar.png",
        },
        { label: "Description", value: "Local Google Chat tools for Zakura MCP" },
      ],
    });
  }

  steps.push(
    {
      id: "oauth-consent",
      title: "同意屏幕",
      description: "Branding → Audience → Data Access → 粘贴 Scopes",
      mode: "manual",
      consoleUrl: links.oauthConsent,
      actions: [],
      copyables: [
        { label: "App name", value: "Workspace MCP Servers" },
        { label: "Scopes", value: scopesPaste, multiline: true },
      ],
    },
    {
      id: "oauth-client",
      title: "OAuth 客户端",
      description: "类型选 Web application，粘贴回调 URI",
      mode: "manual",
      consoleUrl: links.createOauthClient,
      actions: [],
      copyables: [
        { label: "Name", value: OAUTH_CLIENT_DISPLAY_NAME },
        { label: "Redirect URI", value: redirectUri },
      ],
    },
    {
      id: "save",
      title: "保存",
      description: "",
      mode: "api",
      consoleUrl: links.credentials,
      actions: [],
      copyables: [],
    },
  );

  return steps;
}

/** 仅生成引导信息（不调用 Google，不需要 Service Account） */
export function buildGoogleProvisionGuide(
  config: AppConfig,
  projectId: string,
  products?: GoogleMcpProductId[],
): Omit<
  GoogleProvisionResult,
  "enabled" | "alreadyEnabled" | "failed" | "projectInfo" | "serviceStates"
> & {
  checklist: string[];
} {
  const pid = projectId.trim();
  if (!pid) throw new Error("projectId required");
  const redirectUri = mcpOauthRedirectUri(config);
  const selected = products?.length
    ? GOOGLE_MCP_PRODUCTS.filter((p) => products.includes(p.id))
    : [...GOOGLE_MCP_PRODUCTS];
  const links = consoleLinksFor(pid);
  const scopesPasteBlock = buildScopesPasteBlock();
  return {
    projectId: pid,
    oauthClientAutomation: "unsupported",
    limitation: "OAuth Web 客户端需在 Console 创建；API 可自动启用 MCP 服务。",
    redirectUri,
    consoleLinks: links,
    requiredScopes: selected.map((p) => ({
      product: p.name,
      scopes: [...p.scopes],
    })),
    scopesPasteBlock,
    oauthClientName: OAUTH_CLIENT_DISPLAY_NAME,
    gcloudScript: buildGcloudScript(pid, redirectUri),
    checklist: googleOauthSetupChecklist(redirectUri),
    wizardSteps: buildProvisionWizardSteps({
      projectId: pid,
      redirectUri,
      products: selected,
      links,
    }),
  };
}

/** 测试用：生成临时 RSA Service Account 结构（不含真实 Google 项目） */
export function makeTestServiceAccount(projectId = "test-project"): GoogleServiceAccountJson {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    type: "service_account",
    project_id: projectId,
    private_key: privateKey,
    client_email: `zakura-test@${projectId}.iam.gserviceaccount.com`,
    token_uri: "https://oauth2.googleapis.com/token",
  };
}

async function serviceAccountAccessToken(
  sa: GoogleServiceAccountJson,
  scope = "https://www.googleapis.com/auth/cloud-platform",
): Promise<string> {
  if (!sa.client_email || !sa.private_key) {
    throw new Error("Service Account JSON 缺少 client_email / private_key");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope,
      aud: sa.token_uri || "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const sig = signer.sign(sa.private_key.replace(/\\n/g, "\n"), "base64url");
  const jwt = `${unsigned}.${sig}`;

  const res = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== "string") {
    throw new Error(
      `获取 Google access_token 失败：${JSON.stringify(json).slice(0, 400)}`,
    );
  }
  return json.access_token;
}

/** Cloud Resource Manager：校验项目存在与状态 */
async function fetchProjectInfo(
  projectId: string,
  token: string,
): Promise<NonNullable<GoogleProvisionResult["projectInfo"]>> {
  const url = `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-goog-user-project": projectId,
      },
      signal: AbortSignal.timeout(20000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err =
        (json.error as { message?: string } | undefined)?.message ||
        `HTTP ${res.status}`;
      return { projectId, error: err };
    }
    return {
      projectId: String(json.projectId ?? projectId),
      name: typeof json.name === "string" ? json.name : undefined,
      projectNumber:
        typeof json.projectNumber === "string" ? json.projectNumber : undefined,
      state: typeof json.lifecycleState === "string" ? json.lifecycleState : undefined,
    };
  } catch (err) {
    return {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Service Usage：查询单个服务状态 */
async function getServiceState(
  projectId: string,
  service: string,
  token: string,
): Promise<string> {
  const url = `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(service)}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-goog-user-project": projectId,
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return "UNKNOWN";
    const json = (await res.json().catch(() => ({}))) as { state?: string };
    return json.state || "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

function classifyEnableError(message: string): string {
  if (
    /allowlist|not been enabled|PERMISSION_DENIED|PRECONDITION_FAILED|developer preview|accessNotConfigured|SERVICE_DISABLED/i.test(
      message,
    )
  ) {
    return `${message}（若无法启用 *mcp.googleapis.com：需先将 GCP 项目加入 Google Workspace Developer Preview：https://developers.google.com/workspace/preview ）`;
  }
  return message;
}

/** 等待 Service Usage 异步 Operation 完成 */
async function waitServiceOperation(
  operationName: string,
  token: string,
  projectId: string,
  timeoutMs = 90_000,
): Promise<void> {
  const name = operationName.replace(/^\//, "");
  const url = `https://serviceusage.googleapis.com/v1/${name}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-goog-user-project": projectId,
      },
      signal: AbortSignal.timeout(20000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      done?: boolean;
      error?: { message?: string; status?: string };
    };
    if (!res.ok) {
      throw new Error(
        classifyEnableError(
          json.error?.message || `轮询启用状态失败 HTTP ${res.status}`,
        ),
      );
    }
    if (json.done) {
      if (json.error?.message) {
        throw new Error(classifyEnableError(json.error.message));
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`启用操作超时：${operationName}`);
}

async function enableService(
  projectId: string,
  service: string,
  token: string,
): Promise<"enabled" | "already" | string> {
  // 已启用则跳过
  const before = await getServiceState(projectId, service, token);
  if (before === "ENABLED") return "already";

  const url = `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(service)}:enable`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-goog-user-project": projectId,
    },
    body: "{}",
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();

  if (res.status === 409 || /already enabled|ALREADY_EXISTS/i.test(text)) {
    return "already";
  }

  let operationName = "";
  try {
    const j = JSON.parse(text) as {
      name?: string;
      error?: { message?: string; status?: string };
    };
    if (j.error?.status === "ALREADY_EXISTS" || /already/i.test(j.error?.message ?? "")) {
      return "already";
    }
    if (!res.ok && j.error?.message) {
      return classifyEnableError(j.error.message);
    }
    if (typeof j.name === "string" && j.name.includes("operations/")) {
      operationName = j.name;
    }
  } catch {
    if (!res.ok) return classifyEnableError(text.slice(0, 200) || `HTTP ${res.status}`);
  }

  if (!res.ok && !operationName) {
    return classifyEnableError(text.slice(0, 200) || `HTTP ${res.status}`);
  }

  try {
    if (operationName) {
      await waitServiceOperation(operationName, token, projectId);
    }
    // 再确认最终状态（LRO 成功后偶发短暂延迟）
    for (let i = 0; i < 5; i++) {
      const state = await getServiceState(projectId, service, token);
      if (state === "ENABLED") return "enabled";
      await new Promise((r) => setTimeout(r, 1000));
    }
    const finalState = await getServiceState(projectId, service, token);
    if (finalState === "ENABLED") return "enabled";
    return classifyEnableError(
      `启用后状态仍为 ${finalState}（MCP 工具调用会报 The caller does not have permission）`,
    );
  } catch (err) {
    return classifyEnableError(err instanceof Error ? err.message : String(err));
  }
}

function buildGcloudScript(projectId: string, redirectUri: string): string {
  const services = GOOGLE_WORKSPACE_MCP_SERVICES.join(" \\\n  ");
  return `# 在本机已登录 gcloud 的前提下执行（可选，与「API 自动启用」等价）
gcloud config set project ${projectId}
gcloud services enable \\
  ${services}

# 注意：Google 没有公开 CLI/API 创建「Web 应用 OAuth 客户端」供 Gmail/Drive MCP 使用。
# 请打开 Console 创建 OAuth 客户端（类型：Web application），回调 URI：
#   ${redirectUri}
# 文档：https://developers.google.com/workspace/guides/configure-mcp-servers
`;
}

/**
 * 使用用户提供的 Google Cloud Service Account，自动启用 Workspace MCP 相关 API，
 * 并返回创建 OAuth 客户端的引导信息（Google 限制：客户端本身无法由公开 API 创建）。
 */
export async function provisionGoogleWorkspaceMcp(opts: {
  config: AppConfig;
  serviceAccountJson: unknown;
  projectId?: string;
  products?: GoogleMcpProductId[];
}): Promise<GoogleProvisionResult> {
  const sa = parseServiceAccount(opts.serviceAccountJson);
  const projectId = (opts.projectId || sa.project_id || "").trim();
  if (!projectId) {
    throw new Error("请提供 projectId，或在 Service Account JSON 中包含 project_id");
  }
  if (sa.type && sa.type !== "service_account") {
    throw new Error("请提供 type=service_account 的密钥 JSON（不是 OAuth Client 下载文件）");
  }

  const token = await serviceAccountAccessToken(sa);
  const redirectUri = mcpOauthRedirectUri(opts.config);

  const products = opts.products?.length
    ? GOOGLE_MCP_PRODUCTS.filter((p) => opts.products!.includes(p.id))
    : [...GOOGLE_MCP_PRODUCTS];

  const projectInfo = await fetchProjectInfo(projectId, token);

  const enabled: string[] = [];
  const alreadyEnabled: string[] = [];
  const failed: Array<{ service: string; error: string }> = [];

  for (const service of GOOGLE_WORKSPACE_MCP_SERVICES) {
    const result = await enableService(projectId, service, token);
    if (result === "enabled") enabled.push(service);
    else if (result === "already") alreadyEnabled.push(service);
    else failed.push({ service, error: result });
  }

  const serviceStates: NonNullable<GoogleProvisionResult["serviceStates"]> = [];
  for (const service of GOOGLE_WORKSPACE_MCP_SERVICES) {
    const state = await getServiceState(projectId, service, token);
    serviceStates.push({ service, state });
  }

  const links = consoleLinksFor(projectId);
  const scopesPasteBlock = buildScopesPasteBlock();

  return {
    projectId,
    enabled,
    alreadyEnabled,
    failed,
    oauthClientAutomation: "unsupported",
    limitation: "OAuth Web 客户端需在 Console 创建；API 可自动启用 MCP 服务。",
    redirectUri,
    consoleLinks: links,
    requiredScopes: products.map((p) => ({
      product: p.name,
      scopes: [...p.scopes],
    })),
    scopesPasteBlock,
    oauthClientName: OAUTH_CLIENT_DISPLAY_NAME,
    gcloudScript: buildGcloudScript(projectId, redirectUri),
    checklist: googleOauthSetupChecklist(redirectUri),
    wizardSteps: buildProvisionWizardSteps({
      projectId,
      redirectUri,
      products,
      links,
    }),
    sessionId: newProvisionSessionId(),
    projectInfo,
    serviceStates,
  };
}

export function googleOauthSetupChecklist(redirectUri: string): string[] {
  return [
    "在 Google Cloud 创建/选择项目，并启用 Gmail / Drive / Calendar 与对应 MCP API（可用向导「用 API 自动启用」）。",
    "配置 OAuth 同意屏幕（Branding / Audience），Data Access 中粘贴所需 scopes。",
    "创建 OAuth 客户端：应用类型选「Web application」，Authorized redirect URIs 填入回调 URI。",
    `回调 URI：${redirectUri}`,
    "将 Client ID 与 Client Secret 粘贴回本向导最后一步保存。",
  ];
}

/** 生成临时 id，便于前端关联一次供应会话（不落库 SA） */
export function newProvisionSessionId(): string {
  return randomBytes(8).toString("hex");
}
