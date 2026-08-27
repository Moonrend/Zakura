import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("integration catalog credentials", () => {
  let dataDir: string;
  let close: () => Promise<void>;
  let catalog: import("../src/services/integration-catalog.js").IntegrationCatalogService;
  let db: import("../src/db/client.js").Db;
  const secret = "integration-catalog-test-secret";

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "zakura-integration-catalog-"));
    const databaseUrl = `pglite:${join(dataDir, "pglite")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const { createDb } = await import("../src/db/client.js");
    const created = await createDb({ databaseUrl, dataDir });
    db = created.db;
    close = created.close;
    const config = {
      dataDir,
      databaseUrl,
      secret,
    } as import("../src/config.js").AppConfig;
    const { IntegrationCatalogService } = await import(
      "../src/services/integration-catalog.js"
    );
    catalog = new IntegrationCatalogService(created.db, config);
    await catalog.sync();
  });

  after(async () => {
    await close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps external MCP outside the connector catalog", async () => {
    assert.equal(await catalog.matchConnectorCapability("https://api.githubcopilot.com/mcp/"), null);
    assert.equal(await catalog.matchConnectorCapability("https://gmailmcp.googleapis.com/mcp/v1"), null);
    const packages = await catalog.list("tenant-catalog");
    const slugs = new Set(packages.map((item) => item.slug));

    // 目录会随新连接器增长，所以只断言「该在的都在」，不冻结整份清单。
    for (const expected of [
      "browser-notifications",
      "discord",
      "feishu",
      "github",
      "gitlab",
      "google-workspace",
      "jira",
      "linear",
      "microsoft-365",
      "notion",
      "slack",
    ]) {
      assert.ok(slugs.has(expected), `目录缺少内置连接器 ${expected}`);
    }

    // 本用例真正要守的不变式：外部 MCP 不进连接器目录。
    assert.equal(
      packages.some((item) => item.components.some((component) => component.kind === "mcp")),
      false,
      "连接器目录不应包含 mcp 组件",
    );
  });

  it("resolves connector capabilities from catalog metadata", async () => {
    const google = await catalog.matchConnectorCapability("zakura://google-workspace/gmail");
    assert.equal(google?.connector.ref, "google-workspace");
    assert.equal(google?.toolConfig.providerId, "google-workspace");
    assert.deepEqual(google?.connectorConfig.authorizeParams, {
      access_type: "offline",
      prompt: "consent",
    });

    const microsoft = await catalog.matchConnectorCapability("zakura://microsoft-365/teams");
    assert.equal(microsoft?.connector.ref, "microsoft-365");
    assert.equal(microsoft?.toolConfig.product, "teams");

    const github = await catalog.matchConnectorCapability("zakura://github/issues");
    assert.equal(github?.connector.ref, "github");
    assert.equal(github?.toolConfig.product, "issues");
  });

  it("prefers tenant credentials and never returns secret values in lists", async () => {
    const connectors = await catalog.listConnectors("tenant-a");
    const google = connectors.find((item) => item.ref === "google-workspace")!;

    const saved = await catalog.saveCredentials("tenant-a", google.id, {
      enabled: true,
      values: { clientId: "tenant-id", clientSecret: "tenant-secret" },
    });
    assert.deepEqual(saved.configuredFields.sort(), ["clientId", "clientSecret"]);
    assert.equal("values" in saved, false);

    const resolved = await catalog.resolveCredentials("tenant-a", "google-workspace");
    assert.equal(resolved?.source, "tenant");
    assert.equal(resolved?.values.clientId, "tenant-id");
    assert.equal(resolved?.values.clientSecret, "tenant-secret");
  });

  it("locks tenant credentials after platform provisioning", async () => {
    const google = (await catalog.listConnectors("tenant-lock")).find(
      (item) => item.ref === "google-workspace",
    )!;
    await catalog.saveCredentials("platform", google.id, {
      enabled: true,
      values: { clientId: "platform-id", clientSecret: "platform-secret" },
    });

    const listed = await catalog.listConnectors("tenant-lock");
    const locked = listed.find((item) => item.ref === "google-workspace")!;
    assert.equal(locked.lockedByPlatform, true);
    assert.equal(locked.ready, true);
    assert.equal(locked.credentialSource, "platform");

    await assert.rejects(
      () => catalog.saveCredentials("tenant-lock", google.id, {
        enabled: true,
        values: { clientId: "tenant-id", clientSecret: "tenant-secret" },
      }),
      /管理员已预配/,
    );

    const host = await catalog.resolveHostOauthClient(
      "tenant-lock",
      "https://api.githubcopilot.com/mcp/",
    );
    assert.equal(host, null);

    const github = listed.find((item) => item.ref === "github")!;
    await catalog.saveCredentials("platform", github.id, {
      enabled: true,
      values: { clientId: "gh-client", clientSecret: "gh-secret" },
    });
    const ghHost = await catalog.resolveHostOauthClient(
      "tenant-lock",
      "https://api.githubcopilot.com/mcp/",
    );
    assert.equal(ghHost?.clientId, "gh-client");
    assert.equal(ghHost?.source, "platform");

    // 拆掉平台档案：它是全站生效的，留着会让后续租户级用例全部撞上
    // 「管理员已预配」而测不到本来要测的东西。
    for (const profileKey of ["google-workspace", "github"]) {
      await catalog.deleteProfile("platform", profileKey);
    }
    const unlocked = (await catalog.listConnectors("tenant-lock")).find(
      (item) => item.ref === "google-workspace",
    )!;
    assert.equal(unlocked.lockedByPlatform, false, "平台档案应已拆除");
  });

  it("rejects undeclared and missing required credential fields", async () => {
    // 用 linear：platform 作用域是全站的，前面的用例已经把 google-workspace 和 github
    // 预配成平台档案，对它们再做租户级保存会先撞上「管理员已预配」而走不到字段校验。
    const linear = (await catalog.listConnectors("tenant-b")).find(
      (item) => item.ref === "linear",
    )!;
    assert.ok(linear, "目录里应有 linear 连接器");
    assert.equal(linear.lockedByPlatform, false, "linear 不该被平台预配，否则本用例失去意义");

    await assert.rejects(
      () =>
        catalog.saveCredentials("tenant-b", linear.id, {
          values: { arbitraryToken: "not-in-schema" },
        }),
      /未知凭据字段/,
    );
    await assert.rejects(
      () =>
        catalog.saveCredentials("tenant-b", linear.id, {
          enabled: true,
          values: { clientId: "only-id" },
        }),
      /Client Secret/,
    );
  });

  it("interpolates tenant-aware OAuth endpoints without platform conditionals", async () => {
    const microsoft = (await catalog.listConnectors("tenant-ms")).find(
      (item) => item.ref === "microsoft-365",
    )!;
    await catalog.saveCredentials("tenant-ms", microsoft.id, {
      enabled: true,
      values: { clientId: "ms-client", clientSecret: "ms-secret", tenantId: "contoso" },
    });
    const target = await catalog.resolveConnectorTarget("tenant-ms", "zakura://microsoft-365/files");
    assert.equal(target?.providerId, "microsoft-365");
    assert.equal(target?.product, "files");
    assert.equal(target?.discovery.authorizationEndpoint, "https://login.microsoftonline.com/contoso/oauth2/v2.0/authorize");
    assert.equal(target?.discovery.tokenEndpoint, "https://login.microsoftonline.com/contoso/oauth2/v2.0/token");
    assert.equal(target?.client?.clientId, "ms-client");
  });

  it("marks a tool installed only after Agent installation", async () => {
    const { agents, newId, tenants } = await import("../src/db/schema.js");
    const now = new Date();
    const tenantId = "tenant-reuse";
    await db.insert(tenants).values({
      id: tenantId,
      slug: `connector-reuse-${newId().slice(0, 8)}`,
      name: "Connector reuse",
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();
    const agentId = newId();
    await db.insert(agents).values({
      id: agentId,
      tenantId,
      slug: `agent-${newId().slice(0, 6)}`,
      name: "Test Agent",
      createdAt: now,
      updatedAt: now,
    });

    const google = (await catalog.listConnectors(tenantId)).find(
      (item) => item.ref === "google-workspace",
    )!;
    await catalog.saveCredentials(tenantId, google.id, {
      enabled: true,
      values: { clientId: "tid", clientSecret: "tsecret" },
    });

    const before = await catalog.listConnectors(tenantId);
    const gmailBefore = before.flatMap((item) => item.capabilities).find((item) => item.ref === "google-gmail");
    assert.equal(gmailBefore?.installed, false);
    assert.deepEqual(
      (await catalog.listDirectConnectorTargets(tenantId, agentId)).map((t) => t.capabilityRef),
      [],
    );

    await catalog.installConnector(tenantId, "google-workspace", [agentId]);
    // OAuth 未授权前，需要授权的连接器不会进入工具列表
    assert.deepEqual(
      (await catalog.listDirectConnectorTargets(tenantId, agentId)).map((t) => t.capabilityRef),
      [],
    );

    await catalog.saveConnectorAuthorization(
      tenantId,
      "google-workspace",
      { accessToken: "access-token", refreshToken: "refresh" },
      agentId,
    );
    const after = await catalog.listConnectors(tenantId);
    const gmailAfter = after.flatMap((item) => item.capabilities).find((item) => item.ref === "google-gmail");
    assert.equal(gmailAfter?.installed, true);
    assert.equal(
      after.find((item) => item.ref === "google-workspace")?.installations.some(
        (row) => row.agentId === agentId && row.authorized,
      ),
      true,
    );
    const targets = await catalog.listDirectConnectorTargets(tenantId, agentId);
    assert.ok(targets.some((t) => t.capabilityRef === "google-gmail"));
  });
});
