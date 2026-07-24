import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearCimdCache,
  fetchCimdDocument,
  isCimdClientId,
  parseCimdDocument,
  pickCimdTokenAuthMethod,
} from "../src/services/oauth-cimd.js";
import { authorizationServerMetadata } from "../src/services/oauth.js";

describe("oauth CIMD", () => {
  beforeEach(() => {
    clearCimdCache();
  });

  it("isCimdClientId 接受带 path 的 https URL", () => {
    assert.equal(
      isCimdClientId("https://chatgpt.com/oauth/mcp/client.json"),
      true,
    );
    assert.equal(isCimdClientId("https://chatgpt.com/"), false);
    assert.equal(isCimdClientId("http://example.com/client.json"), false);
    assert.equal(isCimdClientId("ocl_abc123"), false);
    assert.equal(isCimdClientId("https://example.com/a/../b.json"), false);
  });

  it("parseCimdDocument 校验 client_id 与 redirect_uris", () => {
    const url = "https://chatgpt.com/oauth/mcp/client.json";
    const doc = parseCimdDocument(
      {
        client_id: url,
        client_name: "ChatGPT",
        redirect_uris: ["https://chatgpt.com/connector/oauth/cb"],
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      },
      url,
    );
    assert.equal(doc.client_name, "ChatGPT");
    assert.equal(doc.redirect_uris.length, 1);
  });

  it("parseCimdDocument 拒绝 client_id 不匹配", () => {
    assert.throws(
      () =>
        parseCimdDocument(
          {
            client_id: "https://other.example/client.json",
            redirect_uris: ["https://chatgpt.com/cb"],
          },
          "https://chatgpt.com/oauth/mcp/client.json",
        ),
      /完全一致/,
    );
  });

  it("pickCimdTokenAuthMethod 优先 none（即使 CIMD 也声明 private_key_jwt）", () => {
    const method = pickCimdTokenAuthMethod(
      {
        client_id: "https://chatgpt.com/oauth/client.json",
        redirect_uris: ["https://chatgpt.com/cb"],
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      },
      ["none", "client_secret_post", "private_key_jwt"],
    );
    assert.equal(method, "none");
  });

  it("pickCimdTokenAuthMethod 在 AS 仅支持 none 时选用 none", () => {
    const method = pickCimdTokenAuthMethod(
      {
        client_id: "https://chatgpt.com/oauth/client.json",
        redirect_uris: ["https://chatgpt.com/cb"],
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      },
      ["none", "client_secret_post"],
    );
    assert.equal(method, "none");
  });

  it("authorizationServerMetadata 声明 CIMD 且 DCR 走 /oauth/register", () => {
    const meta = authorizationServerMetadata("https://zakura.example");
    assert.equal(meta.client_id_metadata_document_supported, true);
    assert.equal(meta.registration_endpoint, "https://zakura.example/oauth/register");
    assert.equal(meta.userinfo_endpoint, "https://zakura.example/userinfo");
    assert.ok(meta.token_endpoint_auth_methods_supported.includes("none"));
    assert.deepEqual(meta.scopes_supported, [
      "mcp",
      "openid",
      "email",
      "profile",
      "offline_access",
    ]);
    assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(meta.id_token_signing_alg_values_supported, ["RS256"]);
    assert.equal(meta.jwks_uri, "https://zakura.example/.well-known/jwks.json");
  });

  it("fetchCimdDocument 使用 mock fetch 并缓存", async () => {
    const url = "https://example.com/oauth/client.json";
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          client_id: url,
          client_name: "Example",
          redirect_uris: ["https://example.com/cb"],
          token_endpoint_auth_method: "none",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "max-age=3600",
          },
        },
      );
    };

    // skipSsrf：避免测试依赖外网 DNS
    const doc1 = await fetchCimdDocument(url, { fetchImpl, skipSsrfCheck: true });
    const doc2 = await fetchCimdDocument(url, { fetchImpl, skipSsrfCheck: true });
    assert.equal(doc1.client_name, "Example");
    assert.equal(doc2.client_name, "Example");
    assert.equal(calls, 1, "第二次应命中缓存");
  });
});
