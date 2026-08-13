import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import {
  defaultResource,
  detectResources,
  envDetector,
  hostDetector,
  osDetector,
  processDetector,
  resourceFromAttributes,
  serviceInstanceIdDetector,
} from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_TYPE,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import type { LogLevel, LogSink, OperationalEvent } from "./log.js";

export type OtlpLogsConfig = {
  url: string;
  headers: Record<string, string>;
};

const SEVERITY: Record<LogLevel, { number: SeverityNumber; text: string }> = {
  debug: { number: SeverityNumber.DEBUG, text: "DEBUG" },
  info: { number: SeverityNumber.INFO, text: "INFO" },
  warn: { number: SeverityNumber.WARN, text: "WARN" },
  error: { number: SeverityNumber.ERROR, text: "ERROR" },
  fatal: { number: SeverityNumber.FATAL, text: "FATAL" },
};

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Standard OTEL logs exporter config.
 * Only `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (full URL, e.g. …/v1/logs).
 * Headers: `OTEL_EXPORTER_OTLP_HEADERS` (`Authorization=…,X-Axiom-Dataset=…`).
 */
export function resolveOtlpLogsConfig(): OtlpLogsConfig | null {
  const url = env("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT");
  if (!url) return null;
  return {
    url,
    headers: parseHeaders(env("OTEL_EXPORTER_OTLP_HEADERS")),
  };
}

export function otlpDestinationHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}

function eventAttributes(event: OperationalEvent): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    "event.name": event.event,
    "user.id": String(event["user.id"] ?? "0"),
    "tenant.id": String(event["tenant.id"] ?? "0"),
  };
  if (typeof event.err_name === "string") attrs[ATTR_EXCEPTION_TYPE] = event.err_name;
  if (typeof event.err_message === "string") attrs[ATTR_EXCEPTION_MESSAGE] = event.err_message;
  for (const [key, value] of Object.entries(event)) {
    if (
      key === "ts" ||
      key === "level" ||
      key === "service" ||
      key === "event" ||
      key === "user.id" ||
      key === "tenant.id" ||
      key === "otlp_forwarded"
    ) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      attrs[key] = value;
    }
  }
  return attrs;
}

function nodeResource(service: string, version: string) {
  return defaultResource()
    .merge(
      detectResources({
        detectors: [
          envDetector,
          hostDetector,
          osDetector,
          processDetector,
          serviceInstanceIdDetector,
        ],
      }),
    )
    .merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: service,
        [ATTR_SERVICE_VERSION]: version,
      }),
    );
}

/** Official OTEL Logs SDK → OTLP/HTTP (Axiom: /v1/logs + X-Axiom-Dataset). */
export class OtelLogsBridge {
  private readonly provider: LoggerProvider;
  private readonly logger: Logger;

  constructor(config: OtlpLogsConfig, resource: { service: string; version?: string }) {
    const exporter = new OTLPLogExporter({
      url: config.url,
      headers: config.headers,
    });
    this.provider = new LoggerProvider({
      resource: nodeResource(resource.service, resource.version ?? "0.0.0"),
      processors: [
        new BatchLogRecordProcessor({
          exporter,
          scheduledDelayMillis: 1000,
          maxExportBatchSize: 50,
        }),
      ],
    });
    this.logger = this.provider.getLogger(resource.service, resource.version);
  }

  readonly sink: LogSink = (event) => {
    if (event.otlp_forwarded === true) return;
    const sev = SEVERITY[event.level];
    this.logger.emit({
      timestamp: Date.parse(event.ts) || Date.now(),
      severityNumber: sev.number,
      severityText: sev.text,
      eventName: event.event,
      body: event.event,
      attributes: eventAttributes(event),
    });
  };

  async shutdown(): Promise<void> {
    await this.provider.shutdown();
  }
}

function upsertOtlpAttr(attrs: unknown, key: string, stringValue: string): unknown[] {
  const list = Array.isArray(attrs) ? [...attrs] : [];
  const next = list.filter(
    (item) => !(item && typeof item === "object" && (item as { key?: unknown }).key === key),
  );
  next.push({ key, value: { stringValue } });
  return next;
}

/** Overwrite user.id / tenant.id on resource + each log record (never trust the client). */
export function stampOtlpActorIds(
  body: unknown,
  ids: { userId: string; tenantId: string },
): unknown {
  if (!body || typeof body !== "object") return body;
  const clone = structuredClone(body) as {
    resourceLogs?: Array<{
      resource?: { attributes?: unknown };
      scopeLogs?: Array<{ logRecords?: Array<{ attributes?: unknown }> }>;
    }>;
  };
  if (!Array.isArray(clone.resourceLogs)) return clone;
  for (const rl of clone.resourceLogs) {
    if (!rl || typeof rl !== "object") continue;
    rl.resource = rl.resource ?? {};
    rl.resource.attributes = upsertOtlpAttr(rl.resource.attributes, "user.id", ids.userId);
    rl.resource.attributes = upsertOtlpAttr(rl.resource.attributes, "tenant.id", ids.tenantId);
    if (!Array.isArray(rl.scopeLogs)) continue;
    for (const sl of rl.scopeLogs) {
      if (!Array.isArray(sl?.logRecords)) continue;
      for (const rec of sl.logRecords) {
        rec.attributes = upsertOtlpAttr(rec.attributes, "user.id", ids.userId);
        rec.attributes = upsertOtlpAttr(rec.attributes, "tenant.id", ids.tenantId);
      }
    }
  }
  return clone;
}

/** Forward a stamped OTLP/HTTP JSON payload to the logs endpoint. */
export async function forwardOtlpLogsPayload(body: unknown): Promise<boolean> {
  const config = resolveOtlpLogsConfig();
  if (!config || body == null) return false;
  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...config.headers,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      process.stderr.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          event: "otel.export_failed",
          status: res.status,
          dest: otlpDestinationHost(config.url),
        }) + "\n",
      );
    }
    return res.ok;
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "otel.export_failed",
        dest: otlpDestinationHost(config.url),
        err_message: err instanceof Error ? err.message.slice(0, 120) : "fetch failed",
      }) + "\n",
    );
    return false;
  }
}

export type ParsedOtlpRecord = {
  event: string;
  level: LogLevel;
  fields: Record<string, string | number | boolean | null>;
};

function severityToLevel(n: number, text: string): LogLevel {
  if (n >= 21 || text === "FATAL") return "fatal";
  if (n >= 17 || text === "ERROR") return "error";
  if (n >= 13 || text === "WARN" || text === "WARNING") return "warn";
  if (n >= 9 || text === "INFO") return "info";
  return "debug";
}

function kvValue(value: Record<string, unknown> | undefined): string | number | boolean | null {
  if (!value) return null;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.boolValue === "boolean") return value.boolValue;
  if (typeof value.doubleValue === "number") return value.doubleValue;
  if (typeof value.intValue === "string" || typeof value.intValue === "number") {
    const n = Number(value.intValue);
    return Number.isFinite(n) ? n : String(value.intValue);
  }
  return null;
}

function recordBody(body: unknown): string {
  if (!body || typeof body !== "object") return "client.log";
  const rec = body as Record<string, unknown>;
  if (typeof rec.stringValue === "string" && rec.stringValue.trim()) {
    return rec.stringValue.slice(0, 240);
  }
  return "client.log";
}

/** Pull log records out of an OTLP/HTTP JSON payload (browser ingest). */
export function parseOtlpLogsPayload(body: unknown, limit = 32): ParsedOtlpRecord[] {
  if (!body || typeof body !== "object") return [];
  const resourceLogs = (body as { resourceLogs?: unknown }).resourceLogs;
  if (!Array.isArray(resourceLogs)) return [];
  const out: ParsedOtlpRecord[] = [];
  for (const rl of resourceLogs) {
    const scopeLogs =
      rl && typeof rl === "object" ? (rl as { scopeLogs?: unknown }).scopeLogs : undefined;
    if (!Array.isArray(scopeLogs)) continue;
    for (const sl of scopeLogs) {
      const records =
        sl && typeof sl === "object" ? (sl as { logRecords?: unknown }).logRecords : undefined;
      if (!Array.isArray(records)) continue;
      for (const raw of records) {
        if (out.length >= limit) return out;
        if (!raw || typeof raw !== "object") continue;
        const rec = raw as {
          severityNumber?: unknown;
          severityText?: unknown;
          body?: unknown;
          attributes?: unknown;
        };
        const n =
          typeof rec.severityNumber === "number"
            ? rec.severityNumber
            : typeof rec.severityNumber === "string"
              ? Number(rec.severityNumber) || 0
              : 0;
        const text = typeof rec.severityText === "string" ? rec.severityText.toUpperCase() : "";
        const fields: Record<string, string | number | boolean | null> = {};
        if (Array.isArray(rec.attributes)) {
          for (const item of rec.attributes) {
            if (!item || typeof item !== "object") continue;
            const key = (item as { key?: unknown }).key;
            if (typeof key !== "string" || !key || key === "user.id" || key === "tenant.id") continue;
            fields[key.slice(0, 64)] = kvValue((item as { value?: Record<string, unknown> }).value);
          }
        } else if (rec.attributes && typeof rec.attributes === "object") {
          for (const [key, value] of Object.entries(rec.attributes as Record<string, unknown>)) {
            if (!key || key === "user.id" || key === "tenant.id") continue;
            if (value && typeof value === "object") {
              fields[key.slice(0, 64)] = kvValue(value as Record<string, unknown>);
            } else if (
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean" ||
              value === null
            ) {
              fields[key.slice(0, 64)] = value;
            }
          }
        }
        out.push({
          event: recordBody(rec.body),
          level: severityToLevel(n, text),
          fields,
        });
      }
    }
  }
  return out;
}
