import { createHmac, timingSafeEqual } from "node:crypto";

export type WorkspaceConnectionKind = "desktop" | "terminal";

export type WorkspaceConnectionTicket = {
  tenantId: string;
  agentId: string;
  kind: WorkspaceConnectionKind;
  exp: number;
};

export function signWorkspaceConnectionTicket(
  secret: string,
  tenantId: string,
  agentId: string,
  kind: WorkspaceConnectionKind,
): string {
  const payload: WorkspaceConnectionTicket = {
    tenantId,
    agentId,
    kind,
    exp: Math.floor(Date.now() / 1000) + 45,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`workspace:${body}`).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyWorkspaceConnectionTicket(
  secret: string,
  token: string,
): WorkspaceConnectionTicket | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = createHmac("sha256", secret).update(`workspace:${body}`).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const ticket = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as WorkspaceConnectionTicket;
    if (ticket.kind !== "desktop" && ticket.kind !== "terminal") return null;
    return ticket.exp >= Math.floor(Date.now() / 1000) ? ticket : null;
  } catch {
    return null;
  }
}

export const signDesktopTicket = (secret: string, tenantId: string, agentId: string) =>
  signWorkspaceConnectionTicket(secret, tenantId, agentId, "desktop");

export const verifyDesktopTicket = (secret: string, token: string) => {
  const ticket = verifyWorkspaceConnectionTicket(secret, token);
  return ticket?.kind === "desktop" ? ticket : null;
};
