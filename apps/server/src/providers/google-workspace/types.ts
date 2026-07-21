/** Google Workspace 本地工具：产品与 URL 解析（兼容旧 *mcp.googleapis.com） */

export type GoogleWorkspaceProduct =
  | "gmail"
  | "drive"
  | "calendar"
  | "people"
  | "chat";

export const GOOGLE_WORKSPACE_PRODUCTS: GoogleWorkspaceProduct[] = [
  "gmail",
  "drive",
  "calendar",
  "people",
  "chat",
];

const HOST_TO_PRODUCT: Record<string, GoogleWorkspaceProduct> = {
  "gmailmcp.googleapis.com": "gmail",
  "drivemcp.googleapis.com": "drive",
  "calendarmcp.googleapis.com": "calendar",
  "people.googleapis.com": "people",
  "chatmcp.googleapis.com": "chat",
};

/** 本地实例伪 URL，或兼容官方 MCP URL */
export function resolveGoogleWorkspaceProduct(
  mcpUrlOrProduct: string,
): GoogleWorkspaceProduct | null {
  const raw = mcpUrlOrProduct.trim();
  if (GOOGLE_WORKSPACE_PRODUCTS.includes(raw as GoogleWorkspaceProduct)) {
    return raw as GoogleWorkspaceProduct;
  }
  const builtin = raw.match(
    /^zakura:\/\/google-workspace\/(gmail|drive|calendar|people|chat)$/i,
  );
  if (builtin) return builtin[1]!.toLowerCase() as GoogleWorkspaceProduct;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return HOST_TO_PRODUCT[host] ?? null;
  } catch {
    return null;
  }
}

export function isGoogleWorkspaceTarget(mcpUrl: string): boolean {
  return resolveGoogleWorkspaceProduct(mcpUrl) != null;
}

export function googleWorkspaceBuiltinUrl(product: GoogleWorkspaceProduct): string {
  return `zakura://google-workspace/${product}`;
}

export const GOOGLE_WORKSPACE_SCOPES: Record<GoogleWorkspaceProduct, string[]> = {
  gmail: [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
  ],
  drive: [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
  ],
  calendar: [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.freebusy",
    "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/calendar.events",
  ],
  people: [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/directory.readonly",
  ],
  chat: [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/chat.memberships.readonly",
    "https://www.googleapis.com/auth/chat.messages.readonly",
    "https://www.googleapis.com/auth/chat.messages.create",
    "https://www.googleapis.com/auth/chat.users.readstate.readonly",
  ],
};

export function scopesForProduct(product: GoogleWorkspaceProduct): string {
  return GOOGLE_WORKSPACE_SCOPES[product].join(" ");
}
