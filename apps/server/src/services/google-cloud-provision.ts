import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";
import { mcpOauthRedirectUri } from "./mcp-oauth-apps.js";

/** Google Workspace MCP 所需启用的 Cloud API */
export const GOOGLE_WORKSPACE_MCP_SERVICES = [
  "gmail.googleapis.com",
  "drive.googleapis.com",
  "calendar-json.googleapis.com",
  "gmailmcp.googleapis.com",
  "drivemcp.googleapis.com",
  "calendarmcp.googleapis.com",
] as const;

export const GOOGLE_MCP_PRODUCTS = [
  {
    id: "gmail",
    name: "Gmail",
    mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ],
  },
  {
    id: "drive",
    name: "Google Drive",
    mcpUrl: "https://drivemcp.googleapis.com/mcp/v1",
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ],
  },
  {
    id: "calendar",
    name: "Google Calendar",
    mcpUrl: "https://calendarmcp.googleapis.com/mcp/v1",
    scopes: [
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
      "https://www.googleapis.com/auth/calendar.events.readonly",
    ],
  },
] as const;

export type GoogleServiceAccountJson = {
  type?: string;
  project_id?: string;
  private_key?: string;
  client_email?: string;
  client_id?: string;
  token_uri?: string;
};

export type GoogleProvisionResult = {
  projectId: string;
  enabled: string[];
  alreadyEnabled: string[];
  failed: Array<{ service: string; error: string }>;
  /**
   * Google 不提供公开 API 创建「普通 Web OAuth 客户端」（Gmail/Drive MCP 所需）。
   * IAP / Workforce 的 oauthClients API 不能用于 Workspace MCP。
   * 因此客户端创建仍须走 Console；我们返回一键链接与权限清单。
   */
  oauthClientAutomation: "unsupported";
  limitation: string;
  redirectUri: string;
  consoleLinks: {
    enableApis: string;
    oauthConsent: string;
    createOauthClient: string;
    credentials: string;
  };
  requiredScopes: Array<{ product: string; scopes: string[] }>;
  gcloudScript: string;
  checklist?: string[];
  sessionId?: string;
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

/** 仅生成引导信息（不调用 Google，不需要 Service Account） */
export function buildGoogleProvisionGuide(
  config: AppConfig,
  projectId: string,
  products?: Array<"gmail" | "drive" | "calendar">,
): Omit<
  GoogleProvisionResult,
  "enabled" | "alreadyEnabled" | "failed"
> & {
  checklist: string[];
} {
  const pid = projectId.trim();
  if (!pid) throw new Error("projectId required");
  const redirectUri = mcpOauthRedirectUri(config);
  const selected = products?.length
    ? GOOGLE_MCP_PRODUCTS.filter((p) => products.includes(p.id))
    : [...GOOGLE_MCP_PRODUCTS];
  return {
    projectId: pid,
    oauthClientAutomation: "unsupported",
    limitation:
      "Google 未开放公开 API 用于创建 Google Auth Platform 的 Web OAuth 客户端（clientauthconfig 仅供控制台/IAP）。后端可自动启用 MCP 相关 API；请按步骤在 Console 创建客户端并粘贴 Client ID/Secret。",
    redirectUri,
    consoleLinks: {
      enableApis: `https://console.cloud.google.com/apis/library?project=${encodeURIComponent(pid)}`,
      oauthConsent: `https://console.cloud.google.com/auth/branding?project=${encodeURIComponent(pid)}`,
      createOauthClient: `https://console.cloud.google.com/auth/clients/create?project=${encodeURIComponent(pid)}`,
      credentials: `https://console.cloud.google.com/auth/clients?project=${encodeURIComponent(pid)}`,
    },
    requiredScopes: selected.map((p) => ({
      product: p.name,
      scopes: [...p.scopes],
    })),
    gcloudScript: buildGcloudScript(pid, redirectUri),
    checklist: googleOauthSetupChecklist(redirectUri),
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

async function enableService(
  projectId: string,
  service: string,
  token: string,
): Promise<"enabled" | "already" | string> {
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
  if (res.ok || res.status === 200 || res.status === 201) return "enabled";
  const text = await res.text();
  if (res.status === 409 || /already enabled|ALREADY_EXISTS/i.test(text)) {
    return "already";
  }
  // 异步 operation 也算接受
  if (res.status === 200 || text.includes("\"name\": \"operations/")) {
    return "enabled";
  }
  try {
    const j = JSON.parse(text) as { error?: { message?: string; status?: string } };
    if (j.error?.status === "ALREADY_EXISTS" || /already/i.test(j.error?.message ?? "")) {
      return "already";
    }
    return j.error?.message || text.slice(0, 200);
  } catch {
    return text.slice(0, 200) || `HTTP ${res.status}`;
  }
}

function buildGcloudScript(projectId: string, redirectUri: string): string {
  const services = GOOGLE_WORKSPACE_MCP_SERVICES.join(" \\\n  ");
  return `# 在本机已登录 gcloud 的前提下执行（可选，与「一键启用 API」等价）
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
  products?: Array<"gmail" | "drive" | "calendar">;
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

  const enabled: string[] = [];
  const alreadyEnabled: string[] = [];
  const failed: Array<{ service: string; error: string }> = [];

  for (const service of GOOGLE_WORKSPACE_MCP_SERVICES) {
    const result = await enableService(projectId, service, token);
    if (result === "enabled") enabled.push(service);
    else if (result === "already") alreadyEnabled.push(service);
    else failed.push({ service, error: result });
  }

  return {
    projectId,
    enabled,
    alreadyEnabled,
    failed,
    oauthClientAutomation: "unsupported",
    limitation:
      "Google 未开放公开 API 用于创建 Google Auth Platform 的 Web OAuth 客户端（clientauthconfig 仅供控制台/IAP）。后端已尽量自动启用 MCP 相关 API；请按下方步骤在 Console 创建客户端并粘贴 Client ID/Secret。",
    redirectUri,
    consoleLinks: {
      enableApis: `https://console.cloud.google.com/apis/library?project=${encodeURIComponent(projectId)}`,
      oauthConsent: `https://console.cloud.google.com/auth/branding?project=${encodeURIComponent(projectId)}`,
      createOauthClient: `https://console.cloud.google.com/auth/clients/create?project=${encodeURIComponent(projectId)}`,
      credentials: `https://console.cloud.google.com/auth/clients?project=${encodeURIComponent(projectId)}`,
    },
    requiredScopes: products.map((p) => ({
      product: p.name,
      scopes: [...p.scopes],
    })),
    gcloudScript: buildGcloudScript(projectId, redirectUri),
    checklist: googleOauthSetupChecklist(redirectUri),
    sessionId: newProvisionSessionId(),
  };
}

export function googleOauthSetupChecklist(redirectUri: string): string[] {
  return [
    "在 Google Cloud 创建/选择项目，并启用 Gmail / Drive / Calendar 与对应 MCP API（可用上方「用 Service Account 自动启用」）。",
    "配置 OAuth 同意屏幕（Branding / Audience），Data Access 中添加下方所需 scopes。",
    "创建 OAuth 客户端：应用类型选「Web 应用」，Authorized redirect URIs 填入回调 URI。",
    `回调 URI：${redirectUri}`,
    "将 Client ID 与 Client Secret 粘贴回 Zakura（本页或安装流），由本服务自动完成用户授权码流程。",
  ];
}

/** 生成临时 id，便于前端关联一次供应会话（不落库 SA） */
export function newProvisionSessionId(): string {
  return randomBytes(8).toString("hex");
}
