import assert from "node:assert/strict";
import { it } from "node:test";
import { workspaceSocketUrl } from "../../web/src/lib/workspace-socket-url.js";

it("keeps ticket paths and tokens while resolving reverse-proxy WebSocket origins", () => {
  assert.equal(workspaceSocketUrl("ws://localhost:3000/api/agents/a/desktop-proxy?token=a.b", "https://app.example/dashboard"), "wss://app.example/api/agents/a/desktop-proxy?token=a.b");
  assert.equal(workspaceSocketUrl("/api/agents/a/desktop-proxy?token=a.b", "https://app.example/dashboard"), "wss://app.example/api/agents/a/desktop-proxy?token=a.b");
  assert.equal(workspaceSocketUrl("ws://[::1]:3000/api", "http://localhost:3001/dashboard"), "ws://localhost:3001/api");
  assert.equal(workspaceSocketUrl("wss://api.example/api", "https://app.example/dashboard"), "wss://api.example/api");
});
