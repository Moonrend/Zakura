/**
 * 远程通道斜杠指令：菜单定义、执行、各平台原生注册。
 * Chat SDK 负责收指令；Telegram/Discord 需自行 setMyCommands / application commands。
 */
import type { RemoteChannelSettings } from "./remote-agent-ingress.js";

export type SlashMenuItem = {
  /** 无前导 /，小写 */
  name: string;
  description: string;
  /** 未授权用户也可调用 */
  public?: boolean;
};

/** 写入各平台原生「/」菜单的指令（单 token） */
export const REMOTE_SLASH_MENU: SlashMenuItem[] = [
  { name: "start", description: "欢迎与接入说明", public: true },
  { name: "help", description: "查看可用指令", public: true },
  { name: "whoami", description: "查看你的身份与权限", public: true },
  { name: "request", description: "申请访问权限", public: true },
  { name: "status", description: "查看当前会话状态" },
  { name: "new", description: "开启新会话（清空上下文）" },
  { name: "stop", description: "停止当前 Agent 回复" },
];

export const REMOTE_SLASH_NAMES = REMOTE_SLASH_MENU.map((item) => `/${item.name}`);

export function isPublicSlashCommand(command: string): boolean {
  const name = normalizeCommandName(command);
  return REMOTE_SLASH_MENU.some((item) => item.name === name && item.public);
}

export function normalizeCommandName(command: string): string {
  return command.trim().replace(/^\//, "").split(/[\s@]/)[0]?.toLowerCase() ?? "";
}

/** 从普通消息文本解析斜杠（无原生 slash 路由的平台） */
export function parseSlashFromText(
  text: string,
): { command: string; args: string } | null {
  const trimmed = text.trim();
  const match = /^\/([a-zA-Z][\w-]*)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  return {
    command: `/${match[1]!.toLowerCase()}`,
    args: (match[2] ?? "").trim(),
  };
}

export function formatHelp(allowed: boolean): string {
  const lines = ["可用指令："];
  for (const item of REMOTE_SLASH_MENU) {
    if (!item.public && !allowed) continue;
    lines.push(`/${item.name} — ${item.description}`);
  }
  if (!allowed) {
    lines.push("", "你尚未获批访问。发送 /request 申请，管理员会在控制台白名单中审批。也可用 /whoami 查看你的用户 ID。");
  }
  return lines.join("\n");
}

export function formatStartWelcome(allowed: boolean, userKey: string): string {
  if (allowed) {
    return [
      "你好，我是 reCloud Agent。",
      "直接发消息即可对话；/help 查看指令，/new 开新会话，/stop 停止当前回复。",
    ].join("\n");
  }
  return [
    "你好，我是 reCloud Agent。",
    "当前连接已开启用户验证，你的账号尚未获批。",
    `你的用户 ID：\`${userKey}\``,
    "发送 /request 提交申请，管理员在控制台白名单中批准后即可使用。",
    "/whoami 可随时查看权限状态。",
  ].join("\n");
}

export function accessDeniedHint(userKey: string): string {
  return [
    "你没有访问此 Agent 的权限。",
    `用户 ID：\`${userKey}\``,
    "发送 /request 申请访问，或把该 ID 发给管理员在控制台加入白名单。",
  ].join("\n");
}

export function formatWhoami(input: {
  userKey: string;
  email?: string;
  allowed: boolean;
  allowAll: boolean;
  pending: boolean;
}): string {
  const status = input.allowed
    ? input.allowAll
      ? "已放行（开放访问）"
      : "已批准"
    : input.pending
      ? "待审批"
      : "未批准";
  return [
    "身份与权限",
    `用户 ID：\`${input.userKey}\``,
    input.email ? `邮箱：${input.email}` : null,
    `状态：${status}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** 向平台注册原生斜杠菜单（best-effort） */
export async function registerPlatformSlashCommands(
  platform: string,
  credentials: Record<string, unknown>,
): Promise<{ ok: boolean; skipped?: boolean; detail: string }> {
  const menu = REMOTE_SLASH_MENU.map((item) => ({
    command: item.name,
    description: item.description.slice(0, 100),
  }));

  if (platform === "telegram") {
    const token = String(credentials.botToken ?? "").trim();
    if (!token) return { ok: false, detail: "缺少 botToken" };
    const base =
      String(credentials.apiBaseUrl ?? credentials.apiUrl ?? "https://api.telegram.org").replace(
        /\/$/,
        "",
      );
    const res = await fetch(`${base}/bot${token}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: menu }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (!res.ok || !data?.ok) {
      return { ok: false, detail: data?.description || `HTTP ${res.status}` };
    }
    return { ok: true, detail: `registered ${menu.length} commands` };
  }

  if (platform === "discord") {
    const token = String(credentials.botToken ?? "").trim();
    const applicationId = String(credentials.applicationId ?? "").trim();
    if (!token || !applicationId) {
      return { ok: false, detail: "缺少 botToken 或 applicationId" };
    }
    const apiUrl = String(credentials.apiUrl ?? "https://discord.com/api/v10").replace(/\/$/, "");
    const body = menu.map((item) => ({
      name: item.command,
      description: item.description,
      type: 1, // CHAT_INPUT
    }));
    const res = await fetch(`${apiUrl}/applications/${applicationId}/commands`, {
      method: "PUT",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, detail: text.slice(0, 200) || `HTTP ${res.status}` };
    }
    return { ok: true, detail: `registered ${menu.length} commands` };
  }

  // Slack / Teams 等需在应用后台配置斜杠指令；运行时仍可通过 onSlashCommand 处理
  return {
    ok: true,
    skipped: true,
    detail: `${platform} 无自动注册 API，请在应用后台配置同名斜杠指令（或直接发送 /指令 文本）`,
  };
}

export function settingsHasPending(
  settings: RemoteChannelSettings,
  userKey: string,
): boolean {
  const key = userKey.trim().toLowerCase();
  return (settings.pendingUsers ?? []).some((p) => p.userKey.trim().toLowerCase() === key);
}
