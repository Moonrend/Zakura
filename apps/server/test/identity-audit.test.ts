import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactAuditDetail } from "../src/services/identity/util.js";

describe("identity audit", () => {
  it("append 用的 detail 不含密钥字段", () => {
    const redacted = redactAuditDetail({
      email: "a@b.com",
      token: "atk_secret",
      clientSecret: "shh",
      protocol: "oidc",
    });
    assert.equal(redacted.email, "a@b.com");
    assert.equal(redacted.protocol, "oidc");
    assert.equal("token" in redacted, false);
    assert.equal("clientSecret" in redacted, false);
  });
});
