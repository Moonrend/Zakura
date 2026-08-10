/**
 * account-status：封号缓存失效与文案。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  invalidateAllSuspensions,
  invalidateTenantSuspension,
  invalidateUserSuspension,
  suspensionMessage,
  type SuspensionInfo,
} from "../src/services/account-status.js";

describe("account-status", () => {
  it("formats suspension messages", () => {
    const user: SuspensionInfo = {
      scope: "user",
      reason: null,
      suspendedAt: new Date(),
    };
    assert.equal(suspensionMessage(user), "账号已被封禁");

    const userReason: SuspensionInfo = {
      scope: "user",
      reason: "滥用",
      suspendedAt: new Date(),
    };
    assert.equal(suspensionMessage(userReason), "账号已被封禁：滥用");

    const tenant: SuspensionInfo = {
      scope: "tenant",
      reason: "欠费",
      suspendedAt: new Date(),
    };
    assert.equal(suspensionMessage(tenant), "所在团队已被封禁：欠费");
  });

  it("invalidate helpers are callable without throwing", () => {
    invalidateUserSuspension("u1");
    invalidateTenantSuspension("t1");
    invalidateAllSuspensions();
    assert.ok(true);
  });
});
