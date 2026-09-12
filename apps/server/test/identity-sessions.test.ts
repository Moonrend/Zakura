import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Secret, TOTP } from "otpauth";
import { sessionInvalidatedByPassword } from "../src/services/identity/sessions.js";
import { verifyTotpCode } from "../src/services/identity/mfa.js";

describe("identity sessions", () => {
  it("改密后没有 iat 的旧令牌失效", () => {
    assert.equal(sessionInvalidatedByPassword(undefined, new Date()), true);
  });

  it("改密前签发的 sid 失效，改密后签发的仍有效", () => {
    const changed = new Date("2026-01-01T00:00:10Z");
    assert.equal(sessionInvalidatedByPassword(Math.floor(changed.getTime() / 1000) - 5, changed), true);
    assert.equal(sessionInvalidatedByPassword(Math.floor(changed.getTime() / 1000) + 5, changed), false);
  });

  it("从未改密则不失效", () => {
    assert.equal(sessionInvalidatedByPassword(undefined, null), false);
    assert.equal(sessionInvalidatedByPassword(1, null), false);
  });

  it("TOTP 当前窗口验证码可通过", () => {
    const secret = new Secret({ size: 20 });
    const totp = new TOTP({
      issuer: "Zakura",
      label: "user",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret,
    });
    assert.equal(verifyTotpCode(secret.base32, totp.generate()), true);
    assert.equal(verifyTotpCode(secret.base32, "000000"), false);
  });
});
