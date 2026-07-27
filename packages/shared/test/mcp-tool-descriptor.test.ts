import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  authRequiredToolResult,
  buildWwwAuthenticateChallenge,
  inferToolAnnotations,
  humanizeToolTitle,
  normalizeToolResult,
  toPublicToolDescriptor,
} from "../src/mcp-tool-descriptor.js";

describe("mcp-tool-descriptor (ChatGPT Apps SDK)", () => {
  it("inferToolAnnotations 标记只读与破坏性工具", () => {
    const read = inferToolAnnotations("fs_read");
    assert.equal(read.readOnlyHint, true);
    assert.equal(read.destructiveHint, false);

    const del = inferToolAnnotations("fs_delete");
    assert.equal(del.readOnlyHint, false);
    assert.equal(del.destructiveHint, true);

    const shell = inferToolAnnotations("shell_exec");
    assert.equal(shell.openWorldHint, true);
    assert.equal(shell.readOnlyHint, false);

    const share = inferToolAnnotations("get_file_url", {
      readOnlyHint: false,
      openWorldHint: true,
    });
    assert.equal(share.readOnlyHint, false);
    assert.equal(share.openWorldHint, true);
  });

  it("toPublicToolDescriptor 补齐 title/annotations/securitySchemes/_meta", () => {
    const d = toPublicToolDescriptor(
      {
        name: "fs_read",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
      { publicName: "re_fs_read" },
    );
    assert.equal(d.name, "re_fs_read");
    assert.ok(d.title);
    assert.equal(d.annotations.readOnlyHint, true);
    assert.equal(d.annotations.destructiveHint, false);
    assert.equal(d.annotations.openWorldHint, false);
    assert.deepEqual(d.securitySchemes, [{ type: "oauth2", scopes: ["mcp"] }]);
    assert.deepEqual(d._meta.securitySchemes, d.securitySchemes);
    assert.ok(
      typeof d._meta["openai/toolInvocation/invoking"] === "string" &&
        (d._meta["openai/toolInvocation/invoking"] as string).length <= 64,
    );
  });

  it("透传 ui.resourceUri 时写入 openai/outputTemplate 兼容别名", () => {
    const d = toPublicToolDescriptor({
      name: "search",
      description: "Search",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { resourceUri: "ui://widget/story.html" } },
    });
    assert.equal(d._meta["openai/outputTemplate"], "ui://widget/story.html");
  });

  it("buildWwwAuthenticateChallenge 使用 resource_metadata", () => {
    const h = buildWwwAuthenticateChallenge({
      resourceMetadataUrl: "https://example.com/.well-known/oauth-protected-resource/mcp",
      scope: "mcp",
      error: "insufficient_scope",
      errorDescription: "login required",
    });
    assert.match(h, /^Bearer resource_metadata=/);
    assert.match(h, /error="insufficient_scope"/);
    assert.doesNotMatch(h, /resource_metadata_uri/);
  });

  it("authRequiredToolResult 带 mcp/www_authenticate", () => {
    const r = authRequiredToolResult({
      resourceMetadataUrl: "https://example.com/.well-known/oauth-protected-resource",
    });
    assert.equal(r.isError, true);
    const meta = r._meta?.["mcp/www_authenticate"];
    assert.ok(Array.isArray(meta));
    assert.match(String(meta[0]), /resource_metadata=/);
  });

  it("normalizeToolResult 保留 structuredContent 与 _meta", () => {
    const r = normalizeToolResult({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { items: [1] },
      _meta: { private: true },
    });
    assert.deepEqual(r.structuredContent, { items: [1] });
    assert.deepEqual(r._meta, { private: true });
  });

  it("humanizeToolTitle", () => {
    assert.equal(humanizeToolTitle("re_fs_read"), "Fs Read");
    assert.equal(humanizeToolTitle("x", "Custom"), "Custom");
  });
});
