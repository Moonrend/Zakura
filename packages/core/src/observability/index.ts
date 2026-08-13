/**
 * Platform observability — health, metrics, operational logs.
 *
 * Two planes:
 * - Control plane (this module): process lifecycle, dependency health,
 *   coarse request metrics. JSON stdout, optional OTLP logs, /metrics.
 * - Data plane: tenant agent runs, tool calls, session events. Stays in
 *   product stores and the realtime event bus. Never printed in full.
 *
 * Every log line carries `user.id` and `tenant.id` (0 = platform).
 * Do not write URLs, emails, secrets, or raw request paths.
 */

export { redactString, sanitizeFields, errorFields } from "./redact.js";
export type { SanitizedFields } from "./redact.js";

export {
  Counter,
  Gauge,
  Histogram,
  MetricsRegistry,
  HTTP_DURATION_BUCKETS_MS,
} from "./metrics.js";
export type { LabelSet } from "./metrics.js";

export { HealthRegistry } from "./health.js";
export type {
  DependencyStatus,
  HealthCheck,
  HealthCheckResult,
  LiveStatus,
  ReadyStatus,
} from "./health.js";

export { OperationalLogger, parseLogLevel } from "./log.js";
export type {
  LogLevel,
  LogFields,
  LogSink,
  LoggerOptions,
  OperationalEvent,
} from "./log.js";

export {
  classifyHttpRoute,
  classifyHttpStatus,
  classifyHttpMethod,
} from "./http.js";
export type { HttpRouteClass } from "./http.js";

export {
  Telemetry,
  initTelemetry,
  getTelemetry,
  resetTelemetry,
  log,
  recordPlatformFault,
  recordHttpRequest,
  componentLogger,
  observabilityHttpMiddleware,
  otlpExportEnabled,
} from "./telemetry.js";
export type { TelemetryOptions, ComponentLogger } from "./telemetry.js";

export {
  PLATFORM_ACTOR_ID,
  PLATFORM_ACTOR_IDS,
  normalizeActorId,
  idsFromSession,
} from "./ids.js";
export type { LogActorIds } from "./ids.js";

export { getLogContext, withLogContext } from "./context.js";

export {
  resolveOtlpLogsConfig,
  otlpDestinationHost,
  parseOtlpLogsPayload,
  stampOtlpActorIds,
  forwardOtlpLogsPayload,
  OtelLogsBridge,
} from "./otlp.js";
export type { OtlpLogsConfig, ParsedOtlpRecord } from "./otlp.js";
