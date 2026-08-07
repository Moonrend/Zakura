import assert from "node:assert/strict";
import { createEmailProvider } from "../src/providers/email/index.js";
import { CHAT_SDK_PLATFORMS, REMOTE_PLATFORMS } from "../src/services/remote-channel-runtime.js";
import catalog from "../src/catalog/integration-packages.json" with { type: "json" };

const provider = createEmailProvider();

for (const [product, expectedTool] of [
  ["smtp", "send_email"],
  ["amail", "send_email"],
  ["bettermail", "receive_emails"],
] as const) {
  const config = provider.validateConfig({ product });
  assert.equal(config.product, product);
  assert.equal(config.mcpUrl, `zakura://email/${product}`);

  const tools = await provider.listTools({
    id: `test:${product}`,
    tenantId: "tenant-1",
    providerId: "email",
    name: product,
    slug: product,
    config,
    endpointUrl: null,
    containers: {},
  });
  assert.ok(tools.some((tool) => tool.name === expectedTool));
}

{
  const amailTools = await provider.listTools({
    id: "test:amail-only",
    tenantId: "tenant-1",
    providerId: "email",
    name: "amail",
    slug: "amail",
    config: provider.validateConfig({ product: "amail" }),
    endpointUrl: null,
    containers: {},
  });
  assert.ok(amailTools.every((tool) => tool.name !== "receive_emails"));

  const bettermailTools = await provider.listTools({
    id: "test:bettermail-only",
    tenantId: "tenant-1",
    providerId: "email",
    name: "bettermail",
    slug: "bettermail",
    config: provider.validateConfig({ product: "bettermail" }),
    endpointUrl: null,
    containers: {},
  });
  assert.ok(bettermailTools.every((tool) => tool.name !== "send_email"));
}

{
  const emailPackages = catalog.filter((pkg) => pkg.slug.startsWith("email-"));
  assert.deepEqual(
    emailPackages.map((pkg) => pkg.slug).sort(),
    ["email-amail", "email-bettermail", "email-mailgun", "email-resendapi", "email-smtp"],
  );
  for (const pkg of emailPackages) {
    const connectors = pkg.components.filter((c) => c.kind === "connector");
    assert.equal(connectors.length, 1, `${pkg.slug} should be a single connector package`);
    assert.equal(connectors[0]?.ref, pkg.slug);
  }
  const amail = emailPackages.find((pkg) => pkg.slug === "email-amail");
  const amailAuth = (amail?.components[0] as { config?: { auth?: { fields?: Array<{ key: string }>; settings?: Array<{ key: string }> } } })?.config?.auth;
  assert.ok(amailAuth?.fields?.some((field) => field.key === "baseUrl"), "Amail must allow custom API baseUrl");
  assert.ok(!amailAuth?.settings?.some((field) => field.key === "inboundEnabled"), "Amail is send-only");
  const bettermail = emailPackages.find((pkg) => pkg.slug === "email-bettermail");
  const bettermailAuth = (bettermail?.components[0] as { config?: { auth?: { settings?: Array<{ key: string }> } } })?.config?.auth;
  assert.ok(bettermailAuth?.settings?.some((field) => field.key === "pollIntervalSeconds"), "Bettermail polls inbound");
}

console.log("email provider product self-check ok");

assert.deepEqual([...REMOTE_PLATFORMS], [...CHAT_SDK_PLATFORMS]);
for (const platform of ["resend", "webex", "mattermost", "weixin"] as const) {
  assert.ok(CHAT_SDK_PLATFORMS.includes(platform));
}
console.log("chat sdk platform catalog self-check ok");
