import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertValidSchedulePattern,
  CronParseError,
  nextRunAfter,
  parseSchedulePattern,
} from "../src/services/cron-next.js";

describe("parseSchedulePattern", () => {
  it("parses @every_Nm / @every_Nh", () => {
    const m = parseSchedulePattern("@every_30m");
    assert.equal(m.kind, "every");
    if (m.kind === "every") assert.equal(m.everyMs, 30 * 60_000);
    const h = parseSchedulePattern("@every_2h");
    assert.equal(h.kind, "every");
    if (h.kind === "every") assert.equal(h.everyMs, 2 * 3_600_000);
  });

  it("parses aliases", () => {
    assert.equal(parseSchedulePattern("@hourly").kind, "cron");
    assert.equal(parseSchedulePattern("@daily").kind, "cron");
  });

  it("parses 5-field cron with steps", () => {
    const p = parseSchedulePattern("*/15 9-17 * * 1-5");
    assert.equal(p.kind, "cron");
    if (p.kind === "cron") {
      assert.ok(p.minute.has(0));
      assert.ok(p.minute.has(15));
      assert.ok(p.hour.has(9));
      assert.ok(p.hour.has(17));
      assert.ok(p.dow.has(1));
      assert.ok(!p.dow.has(0));
    }
  });

  it("rejects garbage", () => {
    assert.throws(() => assertValidSchedulePattern(""), CronParseError);
    assert.throws(() => assertValidSchedulePattern("not a cron"), CronParseError);
    assert.throws(() => assertValidSchedulePattern("@every_0m"), CronParseError);
  });
});

describe("nextRunAfter", () => {
  it("advances @every from now", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const next = nextRunAfter("@every_15m", from);
    assert.equal(next.toISOString(), "2026-01-01T00:15:00.000Z");
  });

  it("finds next hourly slot", () => {
    const from = new Date("2026-06-01T10:30:00.000Z");
    const next = nextRunAfter("@hourly", from);
    assert.equal(next.getUTCMinutes(), 0);
    assert.equal(next.getUTCHours(), 11);
  });

  it("finds next weekday 9:00", () => {
    // 2026-08-03 is Monday
    const from = new Date("2026-08-03T08:00:00.000Z");
    const next = nextRunAfter("0 9 * * 1-5", from);
    assert.equal(next.toISOString(), "2026-08-03T09:00:00.000Z");
  });
});
