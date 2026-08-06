/**
 * 轻量 cron / 周期表达式：算下一次触发时间，无第三方依赖。
 *
 * 支持：
 * - 5 段 cron：分 时 日 月 周（0-59 0-23 1-31 1-12 0-6，0=周日）
 * - 字段内：星号、n、a-b、a-b/s、星号/s、a,b,c
 * - 别名：@hourly @daily @weekly @monthly
 * - 周期：@every_15m @every_2h（m=分钟 1-10080，h=小时 1-168）
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

export function parseSchedulePattern(pattern: string): ParsedSchedule {
  const raw = pattern.trim();
  if (!raw) throw new CronParseError("pattern is empty");

  const every = raw.match(/^@every_(\d+)(m|h)$/i);
  if (every) {
    const n = Number(every[1]);
    const unit = every[2]!.toLowerCase();
    if (!Number.isInteger(n) || n < 1) throw new CronParseError("invalid @every interval");
    if (unit === "m") {
      if (n > 10_080) throw new CronParseError("@every minutes max 10080 (7d)");
      return { kind: "every", everyMs: n * 60_000 };
    }
    if (n > 168) throw new CronParseError("@every hours max 168 (7d)");
    return { kind: "every", everyMs: n * 3_600_000 };
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
      "expected 5-field cron (m h dom mon dow), @hourly/@daily/@weekly/@monthly, or @every_Nm/@every_Nh",
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

/**
 * Next fire time strictly after `from` (usually now).
 * For `@every_*`, next = from + interval (rounded up if alignFrom provided as last run).
 */
export function nextRunAfter(
  pattern: string,
  from: Date = new Date(),
  opts?: { lastRunAt?: Date | null },
): Date {
  const parsed = parseSchedulePattern(pattern);
  if (parsed.kind === "every") {
    const base = opts?.lastRunAt?.getTime() ?? from.getTime();
    let next = base + parsed.everyMs;
    // 若 lastRun 很久以前，跳到「从 now 起的下一个整周期」
    while (next <= from.getTime()) next += parsed.everyMs;
    return new Date(next);
  }

  // 从下一分钟整点开始扫
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  for (let i = 0; i < MAX_SCAN_MINUTES; i += 1) {
    const m = cursor.getUTCMinutes();
    const h = cursor.getUTCHours();
    const dom = cursor.getUTCDate();
    const mon = cursor.getUTCMonth() + 1;
    const dow = cursor.getUTCDay(); // 0=Sun
    if (
      parsed.minute.has(m) &&
      parsed.hour.has(h) &&
      parsed.dom.has(dom) &&
      parsed.month.has(mon) &&
      parsed.dow.has(dow)
    ) {
      return new Date(cursor.getTime());
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new CronParseError("no matching time within 1 year (check pattern)");
}
