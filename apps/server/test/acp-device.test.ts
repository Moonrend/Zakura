import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CodexDeviceAuth,
  CODEX_OAUTH_CLIENT_ID,
  mergeCodexAuthJson,
  type CodexDeviceHttp,
} from "../src/services/acp/codex-device.js";
import type { Agent } from "../src/db/schema.js";
import type { AgentWorkspaceService } from "../src/services/agent-workspace.js";

function fakeAgent(): Agent {
  return { id: "agent-1", tenantId: "t1" } as Agent;
}

describe("Codex device poll", () => {
  it("starts, stays pending on 403, completes after token exchange", async () => {
    const writes: string[] = [];
    const http: CodexDeviceHttp = {
      async postJson(url, body) {
        const rec = body as Record<string, unknown>;
        if (url.endsWith("/deviceauth/usercode")) {
          assert.equal(rec.client_id, CODEX_OAUTH_CLIENT_ID);
          return {
            status: 200,
            json: { device_auth_id: "dev-1", user_code: "ABCD-EFGH", interval: "2" },
          };
        }
        if (url.endsWith("/deviceauth/token")) {
          if (http.calls === 1) {
            http.calls = 2;
            return { status: 403, json: { error: "authorization_pending" } };
          }
          return {
            status: 200,
            json: {
              authorization_code: "ac",
              code_verifier: "ver",
              code_challenge: "ch",
            },
          };
        }
        if (url.endsWith("/oauth/token")) {
          assert.equal(rec.code, "ac");
          return {
            status: 200,
            json: {
              id_token: "id",
              access_token: "at",
              refresh_token: "rt",
            },
          };
        }
        throw new Error(url);
      },
      calls: 1,
    } as CodexDeviceHttp & { calls: number };

    const workspace = {
      execInWorkspace: async (_agent: Agent, cmd: string[]) => {
        const script = cmd.join(" ");
        if (script.includes("cat ")) return { stdout: "", stderr: "", exitCode: 0 };
        writes.push(script);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    } as unknown as AgentWorkspaceService;

    const auth = new CodexDeviceAuth(workspace, http);
    const started = await auth.start(fakeAgent());
    assert.equal(started.status, "pending");
    assert.equal(started.userCode, "ABCD-EFGH");
    const pending = await auth.poll(fakeAgent(), started.loginId);
    assert.equal(pending.status, "pending");
    const done = await auth.poll(fakeAgent(), started.loginId);
    assert.equal(done.status, "complete");
    assert.ok(writes.some((s) => s.includes("auth.json")));
  });

  it("cancel stops polling", async () => {
    const http: CodexDeviceHttp = {
      async postJson() {
        return {
          status: 200,
          json: { device_auth_id: "dev-1", user_code: "CODE", interval: 5 },
        };
      },
    };
    const workspace = {
      execInWorkspace: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    } as unknown as AgentWorkspaceService;
    const auth = new CodexDeviceAuth(workspace, http);
    const started = await auth.start(fakeAgent());
    const cancelled = auth.cancel(fakeAgent(), started.loginId);
    assert.equal(cancelled.status, "cancelled");
  });

  it("last_refresh merge prefers newer auth.json", () => {
    const older = JSON.stringify({ last_refresh: "2026-01-01T00:00:00.000Z", tokens: { access_token: "old" } });
    const newer = JSON.stringify({ last_refresh: "2026-08-01T00:00:00.000Z", tokens: { access_token: "new" } });
    assert.equal(JSON.parse(mergeCodexAuthJson(older, newer)).tokens.access_token, "new");
  });
});
