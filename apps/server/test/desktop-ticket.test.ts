import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { signWorkspaceConnectionTicket, verifyDesktopTicket, verifyWorkspaceConnectionTicket } from "../src/services/desktop-ticket.js";

describe("workspace connection tickets", () => {
  const secret = "ticket-test-secret";
  const sign = (payload: unknown) => {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${createHmac("sha256", secret).update(`workspace:${body}`).digest("base64url")}`;
  };
  it("binds agent, tenant, kind and terminal adapter", () => {
    const desktop = signWorkspaceConnectionTicket(secret, "tenant", "agent", "desktop");
    assert.equal(verifyDesktopTicket(secret, desktop)?.tenantId, "tenant");
    assert.equal(verifyDesktopTicket(secret, desktop)?.agentId, "agent");
    const terminal = signWorkspaceConnectionTicket(secret, "tenant", "agent", "terminal", "codex");
    assert.equal(verifyWorkspaceConnectionTicket(secret, terminal)?.adapterId, "codex");
    assert.equal(verifyDesktopTicket(secret, terminal), null);
    assert.equal(verifyDesktopTicket("wrong-secret", desktop), null);
    assert.equal(verifyDesktopTicket(secret, desktop + ".extra"), null);
  });
  it("rejects expiry, malformed identities and invalid connection types", () => {
    const valid = { tenantId: "t", agentId: "a", kind: "desktop", exp: Math.floor(Date.now() / 1000) + 45 };
    for (const payload of [
      { ...valid, exp: Math.floor(Date.now() / 1000) },
      { ...valid, exp: "99999999999" },
      { ...valid, tenantId: "" },
      { ...valid, agentId: 42 },
      { ...valid, kind: "other" },
      { ...valid, adapterId: "codex" },
    ]) assert.equal(verifyWorkspaceConnectionTicket(secret, sign(payload)), null);
    for (const token of ["", "broken", "a.b", "x".repeat(5000)]) assert.equal(verifyWorkspaceConnectionTicket(secret, token), null);
  });
});
