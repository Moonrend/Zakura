import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mergeScopes,
  normalizeGrantedScopes,
} from "../src/services/oauth.js";

describe("oauth OIDC scopes", () => {
  it("mergeScopes 去重并保留顺序语义", () => {
    assert.equal(mergeScopes("mcp openid", "email", "mcp"), "mcp openid email");
    assert.equal(mergeScopes(null, undefined, ""), "");
  });

  it("ChatGPT CIMD 自动附带 openid/email/profile/offline_access", () => {
    const scope = normalizeGrantedScopes("mcp", {
      clientId: "https://chatgpt.com/oauth/pRRt3ecBwyHH/client.json",
    });
    assert.ok(scope.includes("mcp"));
    assert.ok(scope.includes("openid"));
    assert.ok(scope.includes("email"));
    assert.ok(scope.includes("profile"));
    assert.ok(scope.includes("offline_access"));
  });

  it("非 ChatGPT 客户端不强制 OIDC scope", () => {
    assert.equal(normalizeGrantedScopes("mcp", { clientId: "ocl_abc" }), "mcp");
    assert.equal(
      normalizeGrantedScopes("mcp", {
        clientId: "https://claude.ai/oauth/client.json",
      }),
      "mcp",
    );
  });
});
