import assert from "node:assert/strict";
import { render } from "@react-email/render";
import { isSilentAgentTool, SILENT_AGENT_TOOL_NAMES } from "@zakura/shared";
import {
  CRISIS_SUPPORT_TOOL,
  isCrisisSupportToolName,
  listCrisisSupportToolDefinitions,
} from "../src/services/cloud-agent/crisis-support-tools.js";
import { CrisisSupportEmail, crisisSupportText } from "../src/emails/crisis-support.js";
import {
  bindTransactionalEmail,
  isTransactionalEmailConfigured,
  resolveTransactionalEmailConfig,
} from "../src/services/transactional-email.js";
import {
  PLATFORM_TRANSACTIONAL_EMAIL_KEY,
  patchPlatformTransactionalEmail,
  getPlatformTransactionalEmailPublic,
  resolvePlatformTransactionalEmail,
  type PlatformTransactionalEmailStored,
} from "../src/services/platform-transactional-email.js";
import { encryptJson } from "@zakura/core";

assert.equal(CRISIS_SUPPORT_TOOL, "send_crisis_support_resources");
assert.ok(isSilentAgentTool(CRISIS_SUPPORT_TOOL));
assert.ok(isCrisisSupportToolName(CRISIS_SUPPORT_TOOL));
assert.ok(SILENT_AGENT_TOOL_NAMES.includes(CRISIS_SUPPORT_TOOL));
assert.equal(PLATFORM_TRANSACTIONAL_EMAIL_KEY, "email.transactional");

const defs = listCrisisSupportToolDefinitions();
assert.equal(defs.length, 1);
assert.equal(defs[0]?.function.name, CRISIS_SUPPORT_TOOL);
assert.deepEqual(defs[0]?.function.parameters, {
  type: "object",
  properties: {},
  additionalProperties: false,
});

const text = crisisSupportText();
assert.match(text, /Zakura 支持/);
assert.match(text, /400-161-9995/);
assert.doesNotMatch(text, /988/);

const html = await render(CrisisSupportEmail());
assert.match(html, /400-161-9995/);
assert.match(html, /Zakura支持资源/);

{
  const secret = "test-secret-for-transactional-email-self-check";
  const stored: PlatformTransactionalEmailStored = {
    enabled: true,
    fromEmail: "noreply@zakura.test",
    baseUrl: "https://amail.example",
    providerId: "auto",
    apiTokenEnc: encryptJson(secret, { secret: "tok_test" }),
  };
  const resolved = resolvePlatformTransactionalEmail(stored, secret);
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.fromEmail, "noreply@zakura.test");
  assert.equal(resolved.apiToken, "tok_test");
  assert.equal(resolved.baseUrl, "https://amail.example");

  const disabled = resolvePlatformTransactionalEmail(
    { ...stored, enabled: false },
    secret,
  );
  assert.equal(disabled.enabled, false);

  const missingToken = resolvePlatformTransactionalEmail(
    { ...stored, apiTokenEnc: "" },
    secret,
  );
  assert.equal(missingToken.enabled, false);
}

{
  // 未 bind 时不应视为已配置
  assert.equal(await isTransactionalEmailConfigured(), false);
  assert.equal(await resolveTransactionalEmailConfig(), null);

  const rows = new Map<string, string>();
  const fakeDb = {
    query: {
      settings: {
        findFirst: async ({ where: _where }: { where: unknown }) => {
          const value = rows.get(`platform:${PLATFORM_TRANSACTIONAL_EMAIL_KEY}`);
          return value ? { value } : null;
        },
      },
    },
    insert: (_table: unknown) => ({
      values: (row: { ownerKey: string; key: string; value: string }) => ({
        onConflictDoUpdate: async ({ set }: { set: { value: string } }) => {
          rows.set(`${row.ownerKey}:${row.key}`, set.value ?? row.value);
          return [];
        },
      }),
    }),
  };

  const secret = "db-backed-amail-secret";
  bindTransactionalEmail({ db: fakeDb as never, secret });

  assert.equal(await isTransactionalEmailConfigured(), false);

  const pub = await patchPlatformTransactionalEmail(fakeDb as never, secret, {
    enabled: true,
    fromEmail: "support@zakura.test",
    apiToken: "amail-token",
    baseUrl: "",
    providerId: "",
  });
  assert.equal(pub.ready, true);
  assert.equal(pub.hasApiToken, true);
  assert.equal(pub.fromEmail, "support@zakura.test");

  const again = await getPlatformTransactionalEmailPublic(fakeDb as never, secret);
  assert.equal(again.ready, true);

  assert.equal(await isTransactionalEmailConfigured(), true);
  const cfg = await resolveTransactionalEmailConfig();
  assert.ok(cfg);
  assert.equal(cfg.fromEmail, "support@zakura.test");
  assert.equal(cfg.apiToken, "amail-token");

  // 留空 token 保持原值
  const kept = await patchPlatformTransactionalEmail(fakeDb as never, secret, {
    fromEmail: "noreply@zakura.test",
  });
  assert.equal(kept.fromEmail, "noreply@zakura.test");
  assert.equal(kept.hasApiToken, true);
  const cfg2 = await resolveTransactionalEmailConfig();
  assert.equal(cfg2?.apiToken, "amail-token");
}

console.log("transactional email / crisis support self-check ok");
