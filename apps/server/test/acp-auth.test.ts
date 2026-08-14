import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAuthRequiredError } from "../src/services/acp/session.js";

describe("ACP authenticate errors", () => {
  it("detects auth_required from message or data.code", () => {
    assert.equal(isAuthRequiredError(new Error("auth_required")), true);
    assert.equal(isAuthRequiredError({ data: { code: "auth_required" } }), true);
    assert.equal(isAuthRequiredError(new Error("session failed")), false);
  });
});
