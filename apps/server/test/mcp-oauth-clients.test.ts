import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildByoOauthClient } from "../src/services/mcp-oauth-clients.js";

describe("mcp-oauth-clients BYO", () => {
  it("uses the supplied endpoint identity without platform branches", () => {
    const byo = buildByoOauthClient("https://mcp.example.com/v1", {
      clientId: "client-id",
      clientSecret: " client-secret ",
      scopes: " read write ",
    });
    assert.ok(byo);
    assert.equal(byo!.source, "byo");
    assert.equal(byo!.providerId, "mcp.example.com");
    assert.equal(byo!.connectorRef, "mcp.example.com");
    assert.equal(byo!.clientId, "client-id");
    assert.equal(byo!.clientSecret, "client-secret");
    assert.equal(byo!.scopes, "read write");
  });

  it("supports custom schemes and rejects an empty client id", () => {
    const byo = buildByoOauthClient("zakura://workspace/product", {
      clientId: "x",
    });
    assert.equal(byo?.providerId, "workspace");
    assert.equal(
      buildByoOauthClient("https://mcp.example.com", { clientId: "  " }),
      null,
    );
  });
});
