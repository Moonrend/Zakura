import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildByoOauthClient,
  defaultScopesForMcpUrl,
  oauthAppIdForMcpUrl,
} from "../src/services/mcp-oauth-clients.js";

describe("mcp-oauth-clients BYO", () => {
  it("maps Google MCP hosts to google oauth app", () => {
    assert.equal(
      oauthAppIdForMcpUrl("https://gmailmcp.googleapis.com/mcp/v1"),
      "google",
    );
    assert.equal(
      oauthAppIdForMcpUrl("https://drivemcp.googleapis.com/mcp/v1"),
      "google",
    );
    assert.equal(
      oauthAppIdForMcpUrl("https://api.githubcopilot.com/mcp/"),
      "github",
    );
  });

  it("buildByoOauthClient prefers product default scopes", () => {
    const byo = buildByoOauthClient("https://gmailmcp.googleapis.com/mcp/v1", {
      clientId: "abc.apps.googleusercontent.com",
      clientSecret: "sec",
    });
    assert.ok(byo);
    assert.equal(byo!.source, "byo");
    assert.equal(byo!.oauthAppId, "google");
    assert.equal(byo!.clientId, "abc.apps.googleusercontent.com");
    assert.ok(byo!.scopes?.includes("gmail.readonly"));
  });

  it("buildByoOauthClient allows scope override", () => {
    const byo = buildByoOauthClient("https://calendarmcp.googleapis.com/mcp/v1", {
      clientId: "x",
      scopes: "openid email",
    });
    assert.equal(byo?.scopes, "openid email");
  });

  it("defaultScopesForMcpUrl covers calendar", () => {
    const scopes = defaultScopesForMcpUrl("https://calendarmcp.googleapis.com/mcp/v1");
    assert.ok(scopes?.includes("calendar.events"));
  });
});
