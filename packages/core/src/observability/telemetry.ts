import { HealthRegistry, type HealthCheck } from "./health.js";
import {
  classifyHttpMethod,
  classifyHttpRoute,
  classifyHttpStatus,
} from "./http.js";
import { OperationalLogger, parseLogLevel, type LogLevel } from "./log.js";
import { MetricsRegistry } from "./metrics.js";
import { OtelLogsBridge, resolveOtlpLogsConfig } from "./otlp.js";

export type TelemetryOptions = {
  service: string;
  version?: string;
  level?: LogLevel;
};

export type ComponentLogger = {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
};

export class Telemetry {
  readonly service: string;
  readonly version: string;
  readonly log: OperationalLogger;
  readonly metrics: MetricsRegistry;
  readonly health: HealthRegistry;

  readonly httpRequests;
  readonly httpDuration;
  readonly depUp;
  readonly platformFaults;
  readonly logSuppressed;
  readonly componentEvents;
  readonly cloudAgentRuns;
  readonly mcpErrors;
  readonly authFailures;
  readonly processUptime;
  readonly processRss;
  readonly processHeap;
  readonly eventLoopLag;

  private collector: ReturnType<typeof setInterval> | undefined;
  private readonly startedAt = Date.now();
  private readonly otlp: OtelLogsBridge | undefined;
  readonly otlpEnabled: boolean;

  constructor(opts: TelemetryOptions) {
    this.service = opts.service;
    this.version = opts.version ?? "0.0.0";
    const otlpConfig = resolveOtlpLogsConfig();
    this.otlp = otlpConfig
      ? new OtelLogsBridge(otlpConfig, { service: this.service, version: this.version })
      : undefined;
    this.otlpEnabled = Boolean(this.otlp);
    this.log = new OperationalLogger({
      service: opts.service,
      level: opts.level ?? parseLogLevel(process.env.ZAKURA_LOG_LEVEL),
      extraSinks: this.otlp ? [this.otlp.sink] : undefined,
    });
    this.metrics = new MetricsRegistry();
    this.health = new HealthRegistry(opts.service, this.version, this.startedAt);

    this.httpRequests = this.metrics.counter(
      "zakura_http_requests_total",
      "HTTP requests by coarse route class (not path)",
    );
    this.httpDuration = this.metrics.histogram(
      "zakura_http_request_duration_ms",
      "HTTP request duration in milliseconds",
    );
    this.depUp = this.metrics.gauge(
      "zakura_dep_up",
      "Platform dependency reachability (1=up, 0=down, -1=disabled)",
    );
    this.platformFaults = this.metrics.counter(
      "zakura_platform_faults_total",
      "Platform-level faults (no tenant identity)",
    );
    this.logSuppressed = this.metrics.counter(
      "zakura_log_suppressed_total",
      "Operational log lines collapsed by rate limit",
    );
    this.componentEvents = this.metrics.counter(
      "zakura_component_events_total",
      "Provider/component events (info is metric-only)",
    );
    this.cloudAgentRuns = this.metrics.counter(
      "zakura_cloud_agent_runs_total",
      "Cloud-agent run terminals by status",
    );
    this.mcpErrors = this.metrics.counter(
      "zakura_mcp_errors_total",
      "MCP gateway errors by kind",
    );
    this.authFailures = this.metrics.counter(
      "zakura_auth_failures_total",
      "Authentication failures by surface",
    );
    this.processUptime = this.metrics.gauge(
      "zakura_process_uptime_seconds",
      "Process uptime in seconds",
    );
    this.processRss = this.metrics.gauge(
      "zakura_process_rss_bytes",
      "Resident set size",
    );
    this.processHeap = this.metrics.gauge(
      "zakura_process_heap_used_bytes",
      "Heap used",
    );
    this.eventLoopLag = this.metrics.gauge(
      "zakura_event_loop_lag_ms",
      "Event-loop lag sample",
    );

    this.log.setSuppressHandler((event) => {
      this.logSuppressed.inc({ event: event.slice(0, 64) });
    });
  }

  /** Process gauges / event-loop lag. Call from the real process entrypoint only. */
  startCollectors(): this {
    if (this.collector) return this;
    this.sampleProcess();
    this.collector = setInterval(() => this.sampleProcess(), 10_000);
    this.collector.unref();
    return this;
  }

  registerCheck(
    name: string,
    check: HealthCheck,
    opts?: { critical?: boolean; timeoutMs?: number },
  ): void {
    this.health.register(name, async () => {
      const result = await check();
      this.depUp.set(
        result.status === "up" ? 1 : result.status === "disabled" ? -1 : 0,
        { dep: name },
      );
      return result;
    }, opts);
  }

  recordHttp(method: string, path: string, status: number, durationMs: number): void {
    const routeClass = classifyHttpRoute(path);
    const labels = {
      route_class: routeClass,
      method: classifyHttpMethod(method),
      status_class: classifyHttpStatus(status),
    };
    this.httpRequests.inc({
      route_class: routeClass,
      method: labels.method,
      status_class: labels.status_class,
    });
    this.httpDuration.observe(durationMs, { route_class: routeClass });
  }

  /**
   * Infra fault while serving a tenant. Increments a metric and emits a
   * rate-limited operational warn — never include tenant/agent/session ids.
   */
  recordFault(kind: string, err?: unknown, extra?: { subsystem?: string; dep?: string }): void {
    this.platformFaults.inc({ kind: kind.slice(0, 64) });
    this.log.warn("platform.fault", {
      kind,
      subsystem: extra?.subsystem,
      dep: extra?.dep,
      err,
    });
  }

  /**
   * Provider logger compatible with ProviderContext.
   * info is metric-only (tenant instance lifecycle is not operator signal).
   */
  componentLogger(component: string): ComponentLogger {
    return {
      info: () => {
        this.componentEvents.inc({ component, level: "info" });
      },
      warn: (msg) => {
        this.componentEvents.inc({ component, level: "warn" });
        this.recordFault(`component.${component}`, msg, { subsystem: component });
      },
      error: (msg) => {
        this.componentEvents.inc({ component, level: "error" });
        this.platformFaults.inc({ kind: `component.${component}` });
        this.log.error("component.error", { component, err: msg });
      },
    };
  }

  sampleProcess(): void {
    const mem = process.memoryUsage();
    this.processUptime.set(process.uptime());
    this.processRss.set(mem.rss);
    this.processHeap.set(mem.heapUsed);
    const t0 = performance.now();
    setImmediate(() => {
      this.eventLoopLag.set(performance.now() - t0);
    });
  }

  shutdown(): void {
    if (this.collector) {
      clearInterval(this.collector);
      this.collector = undefined;
    }
    void this.otlp?.shutdown();
  }
}

export function otlpExportEnabled(): boolean {
  return getTelemetry().otlpEnabled;
}

let current: Telemetry | undefined;

export function initTelemetry(opts: TelemetryOptions): Telemetry {
  current?.shutdown();
  current = new Telemetry(opts);
  current.startCollectors();
  return current;
}

export function getTelemetry(): Telemetry {
  if (!current) {
    current = new Telemetry({
      service: process.env.ZAKURA_SERVICE ?? "zakura",
      version: process.env.ZAKURA_VERSION,
    });
  }
  return current;
}

export function resetTelemetry(opts?: TelemetryOptions): Telemetry {
  current?.shutdown();
  current = new Telemetry(opts ?? { service: "zakura-test", version: "test" });
  return current;
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) =>
    getTelemetry().log.debug(event, fields),
  info: (event: string, fields?: Record<string, unknown>) =>
    getTelemetry().log.info(event, fields),
  warn: (event: string, fields?: Record<string, unknown>) =>
    getTelemetry().log.warn(event, fields),
  error: (event: string, fields?: Record<string, unknown>) =>
    getTelemetry().log.error(event, fields),
  fatal: (event: string, fields?: Record<string, unknown>) =>
    getTelemetry().log.fatal(event, fields),
};

export function recordPlatformFault(
  kind: string,
  err?: unknown,
  extra?: { subsystem?: string; dep?: string },
): void {
  getTelemetry().recordFault(kind, err, extra);
}

export function recordHttpRequest(
  method: string,
  path: string,
  status: number,
  durationMs: number,
): void {
  getTelemetry().recordHttp(method, path, status, durationMs);
}

export function componentLogger(component: string): ComponentLogger {
  return getTelemetry().componentLogger(component);
}

export function observabilityHttpMiddleware() {
  return async (
    c: { req: { method: string; path: string }; res: { status: number } },
    next: () => Promise<void>,
  ): Promise<void> => {
    const t0 = performance.now();
    try {
      await next();
    } finally {
      recordHttpRequest(c.req.method, c.req.path, c.res.status, performance.now() - t0);
    }
  };
}
