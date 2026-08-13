import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeUsageSummary, utcDay } from "../src/services/user-usage.js";
import { isUserUsageAction, isUserUsageCategory } from "@zakura/shared";

describe("user usage telemetry", () => {
  it("utcDay is YYYY-MM-DD in UTC", () => {
    assert.equal(utcDay(new Date("2026-08-13T23:30:00.000Z")), "2026-08-13");
    assert.equal(utcDay(new Date("2026-08-13T00:00:00.000Z")), "2026-08-13");
  });

  it("sanitizeUsageSummary drops noise and caps length", () => {
    assert.equal(sanitizeUsageSummary("  chat   session  "), "chat session");
    assert.equal(sanitizeUsageSummary(undefined), "");
    const long = "x".repeat(400);
    assert.equal(sanitizeUsageSummary(long).length, 120);
  });

  it("only known categories and actions are accepted", () => {
    assert.equal(isUserUsageCategory("auth"), true);
    assert.equal(isUserUsageCategory("prompt"), false);
    assert.equal(isUserUsageAction("login"), true);
    assert.equal(isUserUsageAction("dump_stdout"), false);
  });
});
