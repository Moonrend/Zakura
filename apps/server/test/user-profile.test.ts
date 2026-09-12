import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BIO_MAX, TITLE_MAX, normalizeProfilePatch } from "../src/services/identity/account.js";
import { newRecoveryCode, startTotpSetup, normalizeRecoveryCode } from "../src/services/identity/mfa.js";

describe("user profile", () => {
  it("空字符串写成 null，超长拒绝", () => {
    assert.deepEqual(normalizeProfilePatch({ name: "  Ada  ", title: " 后端 ", bio: " 写基础设施 " }), {
      name: "Ada",
      title: "后端",
      bio: "写基础设施",
    });
    assert.deepEqual(normalizeProfilePatch({ name: "  ", title: "", bio: "   " }), {
      name: null,
      title: null,
      bio: null,
    });
    assert.throws(() => normalizeProfilePatch({ title: "x".repeat(TITLE_MAX + 1) }), /头衔/);
    assert.throws(() => normalizeProfilePatch({ bio: "x".repeat(BIO_MAX + 1) }), /简介/);
  });
});

describe("totp recovery", () => {
  it("恢复码是可手抄的 xxxxx-xxxxx", () => {
    const code = newRecoveryCode();
    assert.match(code, /^[a-f0-9]{5}-[a-f0-9]{5}$/);
    assert.equal(normalizeRecoveryCode(`${code} `), code.replace("-", ""));
    assert.equal(normalizeRecoveryCode(code.replace("-", "")), code.replace("-", ""));
  });

  it("已启用时拒绝重新绑定", async () => {
    await assert.rejects(
      startTotpSetup({} as never, "secret", {
        id: "u1",
        email: "a@b.c",
        totpEnabledAt: new Date(),
      }),
      /已启用/,
    );
  });
});
