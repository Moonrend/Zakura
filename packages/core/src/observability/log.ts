import { getLogContext } from "./context.js";
import { PLATFORM_ACTOR_ID } from "./ids.js";
import { sanitizeFields, type SanitizedFields } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export type OperationalEvent = {
  ts: string;
  level: LogLevel;
  service: string;
  event: string;
  "user.id": string;
  "tenant.id": string;
} & SanitizedFields;

export type LogSink = (event: OperationalEvent) => void;

export type LoggerOptions = {
  service: string;
  level?: LogLevel;
  sink?: LogSink;
  /** Extra destinations (OTLP). Default stdout/stderr sink still runs unless `sink` is set. */
  extraSinks?: LogSink[];
  /** Default 30s. Identical event+kind+dep+subsystem is collapsed. */
  rateLimitMs?: number;
};

export type LogFields = Record<string, unknown>;

const DEFAULT_RATE_LIMIT_MS = 30_000;

export function parseLogLevel(raw: string | undefined): LogLevel {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error" || v === "fatal") {
    return v;
  }
  return "info";
}

function composeSinks(primary: LogSink, extra?: LogSink[]): LogSink {
  if (!extra || extra.length === 0) return primary;
  const sinks = [primary, ...extra];
  return (event) => {
    for (const sink of sinks) {
      try {
        sink(event);
      } catch {
        // a broken exporter must not take down logging
      }
    }
  };
}

function defaultSink(event: OperationalEvent): void {
  const line = JSON.stringify(event);
  if (event.level === "error" || event.level === "fatal") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export class OperationalLogger {
  readonly service: string;
  level: LogLevel;
  private readonly sink: LogSink;
  private readonly rateLimitMs: number;
  private readonly lastEmit = new Map<string, number>();
  private onSuppress: ((event: string) => void) | undefined;

  constructor(opts: LoggerOptions) {
    this.service = opts.service;
    this.level = opts.level ?? parseLogLevel(process.env.ZAKURA_LOG_LEVEL);
    this.sink = composeSinks(opts.sink ?? defaultSink, opts.extraSinks);
    this.rateLimitMs =
      opts.rateLimitMs ??
      Number(process.env.ZAKURA_LOG_RATE_LIMIT_MS ?? DEFAULT_RATE_LIMIT_MS);
  }

  setSuppressHandler(handler: ((event: string) => void) | undefined): void {
    this.onSuppress = handler;
  }

  debug(event: string, fields?: LogFields): void {
    this.emit("debug", event, fields);
  }

  info(event: string, fields?: LogFields): void {
    this.emit("info", event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.emit("warn", event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.emit("error", event, fields);
  }

  fatal(event: string, fields?: LogFields): void {
    this.emit("fatal", event, fields);
  }

  private emit(level: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;
    const sanitized = sanitizeFields(fields);
    if (level !== "fatal" && level !== "info" && this.rateLimited(event, sanitized)) {
      this.onSuppress?.(event);
      return;
    }
    const ctx = getLogContext();
    this.sink({
      ts: new Date().toISOString(),
      level,
      service: this.service,
      event,
      ...sanitized,
      "user.id": ctx.userId || PLATFORM_ACTOR_ID,
      "tenant.id": ctx.tenantId || PLATFORM_ACTOR_ID,
    });
  }

  private rateLimited(event: string, fields?: SanitizedFields): boolean {
    if (!this.rateLimitMs || this.rateLimitMs <= 0) return false;
    const ctx = getLogContext();
    const key = [
      event,
      ctx.userId,
      ctx.tenantId,
      fields?.kind ?? "",
      fields?.dep ?? "",
      fields?.subsystem ?? "",
      fields?.component ?? "",
    ].join("|");
    const now = Date.now();
    const last = this.lastEmit.get(key) ?? 0;
    if (now - last < this.rateLimitMs) return true;
    this.lastEmit.set(key, now);
    if (this.lastEmit.size > 1000) {
      for (const [k, ts] of this.lastEmit) {
        if (now - ts > this.rateLimitMs * 4) this.lastEmit.delete(k);
      }
    }
    return false;
  }
}
