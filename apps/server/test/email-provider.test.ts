import assert from "node:assert/strict";
import { createEmailProvider } from "../src/providers/email/index.js";
import { CHAT_SDK_PLATFORMS, REMOTE_PLATFORMS } from "../src/services/remote-channel-runtime.js";

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

console.log("email provider product self-check ok");

assert.deepEqual([...REMOTE_PLATFORMS], [...CHAT_SDK_PLATFORMS]);
for (const platform of ["resend", "webex", "mattermost", "weixin"] as const) {
  assert.ok(CHAT_SDK_PLATFORMS.includes(platform));
}
console.log("chat sdk platform catalog self-check ok");
