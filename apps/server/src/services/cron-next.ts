/**
 * 轻量 cron / 周期表达式：算下一次触发时间，无第三方依赖。
 *
 * 支持：
 * - 5 段 cron：分 时 日 月 周（0-59 0-23 1-31 1-12 0-6，0=周日）
 * - 字段内：星号、n、a-b、a-b/s、星号/s、a,b,c
 * - 别名：@hourly @daily @weekly @monthly
 * - 周期：@every 5m / @every_5m / @every_2h（最短 5 分钟）
 * - 时区：前缀 `CRON_TZ=Asia/Shanghai`，或 nextRunAfter({ timezone })
 */

const MAX_SCAN_MINUTES = 366 * 24 * 60; // ~1 year

export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronParseError";
  }
}

type FieldSet = Set<number>;

function parseField(
  raw: string,
  min: number,
  max: number,
  fieldName: string,
): FieldSet {
  const out = new Set<number>();
  const parts = raw.split(",");
  for (const part of parts) {
    const p = part.trim();
    if (!p) throw new CronParseError(`${fieldName}: empty segment`);
    const stepMatch = p.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!stepMatch) throw new CronParseError(`${fieldName}: invalid "${p}"`);
    const base = stepMatch[1]!;
    const step = stepMatch[2] ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new CronParseError(`${fieldName}: invalid step in "${p}"`);
    }
    let lo = min;
    let hi = max;
    if (base !== "*") {
      if (base.includes("-")) {
        const [a, b] = base.split("-").map(Number);
        if (!Number.isInteger(a) || !Number.isInteger(b)) {
          throw new CronParseError(`${fieldName}: invalid range "${p}"`);
        }
        lo = a!;
        hi = b!;
      } else {
        lo = Number(base);
        hi = lo;
      }
    }
    if (lo < min || hi > max || lo > hi) {
      throw new CronParseError(`${fieldName}: out of range "${p}" (${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new CronParseError(`${fieldName}: empty set`);
  return out;
}

export type ParsedSchedule =
  | { kind: "cron"; minute: FieldSet; hour: FieldSet; dom: FieldSet; month: FieldSet; dow: FieldSet }
  | { kind: "every"; everyMs: number };

const MIN_EVERY_MS = 5 * 60_000;

export type PatternMeta = {
  timezone: string | null;
  body: string;
};

/** 剥掉 `CRON_TZ=Area/City` 前缀。 */
export function splitCronTimezone(pattern: string): PatternMeta {
  const raw = pattern.trim();
  const m = raw.match(/^CRON_TZ=(\S+)\s+(.+)$/i);
  if (!m) return { timezone: null, body: raw };
  return { timezone: m[1]!, body: m[2]!.trim() };
}

export function parseSchedulePattern(pattern: string): ParsedSchedule {
  const { body: raw } = splitCronTimezone(pattern);
  if (!raw) throw new CronParseError("pattern is empty");

  const every = raw.match(/^@every(?:_| )(\d+)\s*(m|h)$/i) ?? raw.match(/^@every_(\d+)(m|h)$/i);
  if (every) {
    const n = Number(every[1]);
    const unit = every[2]!.toLowerCase();
    if (!Number.isInteger(n) || n < 1) throw new CronParseError("invalid @every interval");
    let everyMs: number;
    if (unit === "m") {
      if (n > 10_080) throw new CronParseError("@every minutes max 10080 (7d)");
      everyMs = n * 60_000;
    } else {
      if (n > 168) throw new CronParseError("@every hours max 168 (7d)");
      everyMs = n * 3_600_000;
    }
    if (everyMs < MIN_EVERY_MS) {
      throw new CronParseError("shortest interval is @every 5m");
    }
    return { kind: "every", everyMs };
  }

  const alias: Record<string, string> = {
    "@hourly": "0 * * * *",
    "@daily": "0 0 * * *",
    "@weekly": "0 0 * * 0",
    "@monthly": "0 0 1 * *",
  };
  const five = alias[raw.toLowerCase()] ?? raw;
  const fields = five.split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(
      "expected 5-field cron (m h dom mon dow), CRON_TZ=..., @hourly/@daily/@weekly/@monthly, or @every 5m/@every_2h",
    );
  }
  return {
    kind: "cron",
    minute: parseField(fields[0]!, 0, 59, "minute"),
    hour: parseField(fields[1]!, 0, 23, "hour"),
    dom: parseField(fields[2]!, 1, 31, "day-of-month"),
    month: parseField(fields[3]!, 1, 12, "month"),
    dow: parseField(fields[4]!, 0, 6, "day-of-week"),
  };
}

/** Validate only (throws CronParseError). */
export function assertValidSchedulePattern(pattern: string): void {
  parseSchedulePattern(pattern);
}

const DOW_MAP: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function zonedParts(
  date: Date,
  timeZone: string,
): { minute: number; hour: number; dom: number; month: number; dow: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    minute: "2-digit",
    hour: "2-digit",
    day: "2-digit",
    month: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const dow = DOW_MAP[get("weekday").slice(0, 3).toLowerCase()] ?? date.getUTCDay();
  return {
    minute: Number(get("minute")),
    hour: Number(get("hour")),
    dom: Number(get("day")),
    month: Number(get("month")),
    dow,
  };
}

/**
 * Next fire time strictly after `from` (usually now).
 * For `@every_*`, next = from + interval (rounded up if alignFrom provided as last run).
 */
export function nextRunAfter(
  pattern: string,
  from: Date = new Date(),
  opts?: { lastRunAt?: Date | null; timezone?: string | null },
): Date {
  const { timezone: tzPrefix } = splitCronTimezone(pattern);
  const parsed = parseSchedulePattern(pattern);
  if (parsed.kind === "every") {
    const base = opts?.lastRunAt?.getTime() ?? from.getTime();
    let next = base + parsed.everyMs;
    while (next <= from.getTime()) next += parsed.everyMs;
    return new Date(next);
  }

  const tz = (tzPrefix || opts?.timezone || "UTC").trim() || "UTC";
  const useZone = tz !== "UTC";

  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  for (let i = 0; i < MAX_SCAN_MINUTES; i += 1) {
    const parts = useZone
      ? zonedParts(cursor, tz)
      : {
          minute: cursor.getUTCMinutes(),
          hour: cursor.getUTCHours(),
          dom: cursor.getUTCDate(),
          month: cursor.getUTCMonth() + 1,
          dow: cursor.getUTCDay(),
        };
    if (
      parsed.minute.has(parts.minute) &&
      parsed.hour.has(parts.hour) &&
      parsed.dom.has(parts.dom) &&
      parsed.month.has(parts.month) &&
      parsed.dow.has(parts.dow)
    ) {
      return new Date(cursor.getTime());
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new CronParseError("no matching time within 1 year (check pattern)");
}
