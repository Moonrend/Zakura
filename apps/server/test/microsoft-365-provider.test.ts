import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createMicrosoft365Provider,
  microsoft365BuiltinUrl,
  resolveMicrosoft365Product,
} from "../src/providers/microsoft-365/index.js";
import type { InstanceHandle } from "@zakura/core";

function handle(product: string, config: Record<string, unknown> = {}): InstanceHandle {
  return {
    id: `microsoft-${product}`,
    tenantId: "tenant-test",
    providerId: "microsoft-365",
    name: product,
    slug: product,
    config: { product, ...config },
    containers: {},
  };
}

describe("microsoft-365 connector provider", () => {
  it("resolves only catalog-declared builtin targets", () => {
    assert.equal(resolveMicrosoft365Product("outlook"), "outlook");
    assert.equal(resolveMicrosoft365Product("zakura://microsoft-365/files"), "files");
    assert.equal(resolveMicrosoft365Product("https://graph.microsoft.com/v1.0"), null);
    assert.equal(microsoft365BuiltinUrl("teams"), "zakura://microsoft-365/teams");
  });

  it("exposes product-specific tools", async () => {
    const provider = createMicrosoft365Provider();
    const outlook = new Set((await provider.listTools(handle("outlook"))).map((tool) => tool.name));
    const files = new Set((await provider.listTools(handle("files"))).map((tool) => tool.name));
    const teams = new Set((await provider.listTools(handle("teams"))).map((tool) => tool.name));
    const directory = new Set((await provider.listTools(handle("directory"))).map((tool) => tool.name));
    assert.ok(outlook.has("send_mail"));
    assert.ok(files.has("search_files"));
    assert.ok(teams.has("send_channel_message"));
    assert.ok(directory.has("search_users"));
  });

  it("returns an actionable auth error when no token exists", async () => {
    const result = await createMicrosoft365Provider().callTool(
      handle("directory"),
      "get_my_profile",
      {},
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Microsoft OAuth/);
  });
});
