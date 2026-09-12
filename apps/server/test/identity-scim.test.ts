import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  listScimGroups,
  membershipStatusFromScimActive,
  parseScimFilter,
  readScimUserPayload,
  ScimError,
} from "../src/services/identity/scim.js";

describe("identity scim", () => {
  it("解析 userName eq 过滤器", () => {
    assert.deepEqual(parseScimFilter('userName eq "ada@acme.com"'), { email: "ada@acme.com" });
    assert.deepEqual(parseScimFilter('emails.value eq "Ada@Acme.com"'), { email: "ada@acme.com" });
    assert.deepEqual(parseScimFilter(undefined), {});
    assert.deepEqual(parseScimFilter("nonsense"), {});
  });

  it("创建 Users 时从 payload 读出邮箱与 active", () => {
    const created = readScimUserPayload({
      userName: "Ada@Acme.com",
      displayName: "Ada",
      externalId: "ext-1",
    });
    assert.equal(created.email, "ada@acme.com");
    assert.equal(created.name, "Ada");
    assert.equal(created.active, true);
    assert.equal(created.externalId, "ext-1");
    assert.throws(() => readScimUserPayload({}), (err: unknown) => err instanceof ScimError);
  });

  it("停用只映射为本租户 membership suspended，不删全局用户", () => {
    assert.equal(membershipStatusFromScimActive(true), "active");
    assert.equal(membershipStatusFromScimActive(false), "suspended");
  });

  it("Groups 用 groupRoleMap 列出 IdP 组", () => {
    const listed = listScimGroups({ Admins: "admin", Everyone: "member" });
    assert.equal(listed.totalResults, 2);
    assert.deepEqual(
      listed.Resources.map((row) => row.displayName).sort(),
      ["Admins", "Everyone"],
    );
  });
});
