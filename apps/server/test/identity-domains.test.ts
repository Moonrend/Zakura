import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDomain,
  registrationJoinDecision,
  txtHost,
  txtRecordsContain,
  type DomainPolicy,
} from "../src/services/identity/domains.js";

const policy = (joinMode: DomainPolicy["joinMode"]): DomainPolicy => ({
  tenantId: "t1",
  tenantName: "Acme",
  tenantSlug: "acme",
  domain: "acme.com",
  joinMode,
  verified: true,
});

describe("identity domains", () => {
  it("规范化域名并生成 TXT 主机", () => {
    assert.equal(normalizeDomain("https://Acme.COM/path"), "acme.com");
    assert.equal(txtHost("acme.com"), "_zakura-verify.acme.com");
  });

  it("验证 TXT 记录是否含 token", () => {
    assert.equal(txtRecordsContain([["zakura-verify=", "tok_abc"]], "tok_abc"), true);
    assert.equal(txtRecordsContain([["unrelated"]], "tok_abc"), false);
  });

  it("按 joinMode 决定注册行为", () => {
    assert.equal(registrationJoinDecision(null), "create_tenant");
    assert.equal(registrationJoinDecision(policy("invite_only")), "create_tenant");
    assert.equal(registrationJoinDecision(policy("auto_join")), "auto_join");
    assert.equal(registrationJoinDecision(policy("sso_required")), "sso_required");
  });
});
