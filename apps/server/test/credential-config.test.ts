import assert from "node:assert/strict";
import test from "node:test";
import { applyConnectorCredentialsToConfig } from "../src/providers/credential-config.js";

test("injects generic static token credentials without provider-specific branches", () => {
  const result = applyConnectorCredentialsToConfig(
    { product: "records" },
    {
      kind: "token",
      profile: "records-default",
      fields: [{ key: "apiKey", label: "API key", type: "secret", required: true }],
      settings: [{ key: "baseUrl", label: "Base URL", type: "url" }],
      tokenField: "apiKey",
      tokenHeader: "X-API-Key",
      tokenScheme: "",
    },
    { apiKey: "secret-token" },
    { baseUrl: "https://api.example.test" },
  );

  assert.deepEqual(result, {
    product: "records",
    baseUrl: "https://api.example.test",
    apiToken: "secret-token",
    tokenHeader: "X-API-Key",
    tokenScheme: "",
    authRequired: false,
  });
});
