import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  GOOGLE_WORKSPACE_MCP_SERVICES,
  buildGoogleProvisionGuide,
  makeTestServiceAccount,
  parseServiceAccount,
  provisionGoogleWorkspaceMcp,
  googleOauthSetupChecklist,
} from "../src/services/google-cloud-provision.js";
import type { AppConfig } from "../src/config.js";

function fakeConfig(publicBaseUrl = "https://zakura.example"): AppConfig {
  return {
    dataDir: "/tmp",
    databaseUrl: "pglite:/tmp",
    secret: "test-secret-key-32chars-minimum!!",
    host: "127.0.0.1",
    port: 8787,
    publicBaseUrl,
    webPublicUrl: "https://web.example",
    dockerNetwork: "zakura",
    aptMirror: "",
    migrationDir: "/tmp/mig",
    runnerHeartbeatTimeoutSec: 60,
    migrationRetentionDays: 7,
    edition: "oss",
    multiTenant: false,
    mcpOauthClients: {
      githubClientId: "",
      githubClientSecret: "",
      githubScopes: "",
      slackClientId: "",
      slackClientSecret: "",
      slackScopes: "",
    },
  };
}

describe("google-cloud-provision", () => {
  it("parseServiceAccount accepts object and JSON string", () => {
    const obj = makeTestServiceAccount("p1");
    assert.equal(parseServiceAccount(obj).project_id, "p1");
    assert.equal(parseServiceAccount(JSON.stringify(obj)).client_email, obj.client_email);
  });

  it("parseServiceAccount rejects empty / invalid JSON", () => {
    assert.throws(() => parseServiceAccount(""), /为空|无法解析/);
    assert.throws(() => parseServiceAccount("{"), /无法解析/);
    assert.throws(() => parseServiceAccount(null), /对象或字符串/);
  });

  it("buildGoogleProvisionGuide returns console links, scopes and wizard steps", () => {
    const guide = buildGoogleProvisionGuide(fakeConfig(), "demo-proj", ["gmail", "drive"]);
    assert.equal(guide.projectId, "demo-proj");
    assert.equal(guide.oauthClientAutomation, "unsupported");
    assert.match(guide.redirectUri, /\/api\/mcp\/upstream-oauth\/callback$/);
    assert.match(guide.consoleLinks.createOauthClient, /demo-proj/);
    assert.match(guide.consoleLinks.dataAccess, /demo-proj/);
    assert.match(guide.consoleLinks.createProject, /projectcreate/);
    assert.equal(guide.requiredScopes.length, 2);
    assert.ok(guide.requiredScopes[0]!.scopes.some((s) => s.includes("gmail")));
    assert.ok(guide.scopesPasteBlock.includes("gmail.readonly"));
    assert.ok(guide.scopesPasteBlock.includes("gmail.modify"));
    assert.ok(
      guide.scopesPasteBlock
        .split("\n")
        .includes("https://www.googleapis.com/auth/calendar.events"),
    );
    assert.ok(guide.scopesPasteBlock.includes("drive.file"));
    assert.ok(guide.scopesPasteBlock.includes("openid"));
    assert.ok(guide.scopesPasteBlock.includes("userinfo.email"));
    assert.ok(!guide.gcloudScript.includes("gmailmcp"));
    assert.ok(guide.checklist.length >= 4);
    assert.match(guide.gcloudScript, /gcloud services enable/);
    assert.ok(GOOGLE_WORKSPACE_MCP_SERVICES.every((s) => guide.gcloudScript.includes(s)));
    assert.equal(guide.wizardSteps.length, 5);
    assert.deepEqual(
      guide.wizardSteps.map((s) => s.id),
      ["project", "enable-apis", "oauth-consent", "oauth-client", "save"],
    );
    const clientStep = guide.wizardSteps.find((s) => s.id === "oauth-client")!;
    assert.ok(clientStep.copyables.some((c) => c.value.includes("/api/mcp/upstream-oauth/callback")));
    assert.ok(guide.wizardSteps.every((s) => s.title.length > 0));

    const withChat = buildGoogleProvisionGuide(fakeConfig(), "demo-proj", [
      "gmail",
      "chat",
    ]);
    assert.deepEqual(
      withChat.wizardSteps.map((s) => s.id),
      ["project", "enable-apis", "chat-app", "oauth-consent", "oauth-client", "save"],
    );
    const chatStep = withChat.wizardSteps.find((s) => s.id === "chat-app")!;
    assert.match(chatStep.consoleUrl ?? "", /chat\.googleapis\.com\/hangouts-chat/);
  });

  it("googleOauthSetupChecklist mentions redirect URI", () => {
    const steps = googleOauthSetupChecklist("https://x/callback");
    assert.ok(steps.some((s) => s.includes("https://x/callback")));
  });

  describe("provisionGoogleWorkspaceMcp with mocked fetch", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      // reset per test
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("rejects non service_account type", async () => {
      await assert.rejects(
        () =>
          provisionGoogleWorkspaceMcp({
            config: fakeConfig(),
            serviceAccountJson: { type: "authorized_user", project_id: "x" },
          }),
        /service_account/,
      );
    });

    it("enables APIs and returns guide after token exchange", async () => {
      const sa = makeTestServiceAccount("auto-proj");
      let tokenCalls = 0;
      let enableCalls = 0;
      let projectCalls = 0;
      const enabledSet = new Set<string>();

      globalThis.fetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("oauth2.googleapis.com/token")) {
          tokenCalls += 1;
          assert.equal(init?.method, "POST");
          return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("cloudresourcemanager.googleapis.com")) {
          projectCalls += 1;
          return new Response(
            JSON.stringify({
              projectId: "auto-proj",
              name: "Auto Proj",
              projectNumber: "123",
              lifecycleState: "ACTIVE",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("serviceusage.googleapis.com") && url.includes("/operations/")) {
          return new Response(JSON.stringify({ done: true, name: url }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("serviceusage.googleapis.com") && url.includes(":enable")) {
          enableCalls += 1;
          const svc =
            GOOGLE_WORKSPACE_MCP_SERVICES.find((s) => url.includes(s)) ?? `svc-${enableCalls}`;
          if (enableCalls === 2) {
            enabledSet.add(svc);
            return new Response(
              JSON.stringify({ error: { status: "ALREADY_EXISTS", message: "already enabled" } }),
              { status: 409, headers: { "Content-Type": "application/json" } },
            );
          }
          enabledSet.add(svc);
          return new Response(JSON.stringify({ name: "operations/abc" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("serviceusage.googleapis.com") && url.includes("/services/")) {
          const svc = GOOGLE_WORKSPACE_MCP_SERVICES.find((s) => url.includes(`/services/${s}`));
          const state = svc && enabledSet.has(svc) ? "ENABLED" : "DISABLED";
          return new Response(JSON.stringify({ state, name: url }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("unexpected " + url, { status: 500 });
      }) as typeof fetch;

      const result = await provisionGoogleWorkspaceMcp({
        config: fakeConfig("https://gw.example"),
        serviceAccountJson: sa,
        products: ["gmail"],
      });

      assert.equal(tokenCalls, 1);
      assert.equal(projectCalls, 1);
      assert.equal(enableCalls, GOOGLE_WORKSPACE_MCP_SERVICES.length);
      assert.equal(result.projectId, "auto-proj");
      assert.equal(result.oauthClientAutomation, "unsupported");
      assert.ok(
        result.enabled.length + result.alreadyEnabled.length ===
          GOOGLE_WORKSPACE_MCP_SERVICES.length,
      );
      assert.equal(result.alreadyEnabled.length, 1);
      assert.equal(result.failed.length, 0);
      assert.match(result.redirectUri, /^https:\/\/gw\.example\/api\/mcp\/upstream-oauth\/callback$/);
      assert.equal(result.requiredScopes.length, 1);
      assert.equal(result.requiredScopes[0]!.product, "Gmail");
      assert.ok(result.sessionId);
      assert.ok(result.checklist?.length);
      assert.equal(result.wizardSteps.length, 5);
      assert.equal(result.projectInfo?.name, "Auto Proj");
      assert.equal(result.serviceStates?.length, GOOGLE_WORKSPACE_MCP_SERVICES.length);
    });

    it("surfaces enable failures without aborting whole run", async () => {
      const sa = makeTestServiceAccount("fail-proj");
      globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
        }
        if (url.includes("cloudresourcemanager.googleapis.com")) {
          return new Response(JSON.stringify({ projectId: "fail-proj", lifecycleState: "ACTIVE" }), {
            status: 200,
          });
        }
        if (url.includes("/operations/")) {
          return new Response(JSON.stringify({ done: true }), { status: 200 });
        }
        if (url.includes(":enable") && url.includes("gmail.googleapis.com")) {
          return new Response(JSON.stringify({ error: { message: "PERMISSION_DENIED" } }), {
            status: 403,
          });
        }
        if (url.includes("serviceusage.googleapis.com") && url.includes(":enable")) {
          return new Response(JSON.stringify({ name: "operations/ok" }), { status: 200 });
        }
        if (url.includes("serviceusage.googleapis.com") && url.includes("/services/")) {
          // gmail 保持 DISABLED；其他启用后视为 ENABLED
          if (url.includes("gmail.googleapis.com")) {
            return new Response(JSON.stringify({ state: "DISABLED" }), { status: 200 });
          }
          return new Response(JSON.stringify({ state: "ENABLED" }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }) as typeof fetch;

      const result = await provisionGoogleWorkspaceMcp({
        config: fakeConfig(),
        serviceAccountJson: JSON.stringify(sa),
      });
      assert.ok(result.failed.some((f) => f.service === "gmail.googleapis.com"));
      assert.ok(result.failed[0]!.error.includes("PERMISSION_DENIED"));
    });

    it("fails clearly when token exchange fails", async () => {
      const sa = makeTestServiceAccount("tok-fail");
      globalThis.fetch = mock.fn(async () => {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }) as typeof fetch;

      await assert.rejects(
        () =>
          provisionGoogleWorkspaceMcp({
            config: fakeConfig(),
            serviceAccountJson: sa,
          }),
        /access_token/,
      );
    });
  });
});
