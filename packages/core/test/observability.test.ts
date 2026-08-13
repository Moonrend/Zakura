import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  classifyHttpRoute,
  componentLogger,
  idsFromSession,
  MetricsRegistry,
  normalizeActorId,
  OperationalLogger,
  parseOtlpLogsPayload,
  PLATFORM_ACTOR_ID,
  redactString,
  resetTelemetry,
  resolveOtlpLogsConfig,
  sanitizeFields,
  stampOtlpActorIds,
  withLogContext,
} from "../src/observability/index.js";

describe("redactString", () => {
  it("strips urls, emails, and secrets", () => {
    const raw =
      "hit https://zakura.example/mcp/agents/acme user a@b.com token zak_abc123456789 Authorization: Bearer rnr_zzzzzzzz";
    const out = redactString(raw);
    assert.equal(out.includes("https://"), false);
    assert.equal(out.includes("a@b.com"), false);
    assert.equal(out.includes("zak_abc"), false);
    assert.equal(out.includes("rnr_zzzz"), false);
    assert.match(out, /\[url\]/);
    assert.match(out, /\[email\]/);
    assert.match(out, /\[secret\]/);
  });
});

describe("sanitizeFields", () => {
  it("drops tenant identity and urls, keeps coarse scalars", () => {
    const out = sanitizeFields({
      tenantId: "t_1",
      agentId: "a_1",
      sessionId: "s_1",
      slug: "acme",
      url: "https://example.com/x",
      endpoint: "http://127.0.0.1:7443",
      started: 3,
      failed: 1,
      kind: "redis_publish",
      err: new Error("connect redis://:hunter2@127.0.0.1:6379 failed"),
    });
    assert.ok(out);
    assert.equal(out.tenantId, undefined);
    assert.equal(out.agentId, undefined);
    assert.equal(out.sessionId, undefined);
    assert.equal(out.slug, undefined);
    assert.equal(out.url, undefined);
    assert.equal(out.endpoint, undefined);
    assert.equal(out.started, 3);
    assert.equal(out.failed, 1);
    assert.equal(out.kind, "redis_publish");
    assert.equal(out.err_name, "Error");
    assert.ok(String(out.err_message).includes("[url]"));
    assert.equal(String(out.err_message).includes("hunter2"), false);
  });
});

describe("classifyHttpRoute", () => {
  it("uses coarse classes instead of raw paths", () => {
    assert.equal(classifyHttpRoute("/api/health"), "probe");
    assert.equal(classifyHttpRoute("/livez"), "probe");
    assert.equal(classifyHttpRoute("/metrics"), "metrics");
    assert.equal(classifyHttpRoute("/api/agents/abc/sessions"), "api");
    assert.equal(classifyHttpRoute("/mcp/agents/acme"), "mcp");
    assert.equal(classifyHttpRoute("/v1/chat/completions"), "openai");
    assert.equal(classifyHttpRoute("/api/socket.io/"), "realtime");
    assert.equal(classifyHttpRoute("/authorize"), "oauth");
  });
});

describe("OperationalLogger", () => {
  it("writes json without dropped keys", () => {
    const lines: string[] = [];
    const logger = new OperationalLogger({
      service: "zakura",
      level: "info",
      rateLimitMs: 0,
      sink: (e) => lines.push(JSON.stringify(e)),
    });
    logger.info("process.ready", {
      edition: "oss",
      bind_port: 8787,
      publicUrl: "https://zakura.example",
      tenantId: "should-not-appear",
    });
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(parsed.event, "process.ready");
    assert.equal(parsed.service, "zakura");
    assert.equal(parsed.edition, "oss");
    assert.equal(parsed.bind_port, 8787);
    assert.equal(parsed.publicUrl, undefined);
    assert.equal(parsed.tenantId, undefined);
    assert.equal(parsed["user.id"], "0");
    assert.equal(parsed["tenant.id"], "0");
  });

  it("rate-limits repeated warns", () => {
    const lines: string[] = [];
    const logger = new OperationalLogger({
      service: "zakura",
      level: "info",
      rateLimitMs: 60_000,
      sink: (e) => lines.push(e.event),
    });
    logger.warn("platform.fault", { kind: "redis" });
    logger.warn("platform.fault", { kind: "redis" });
    logger.warn("platform.fault", { kind: "docker" });
    assert.deepEqual(lines, ["platform.fault", "platform.fault"]);
  });
});

describe("MetricsRegistry", () => {
  it("renders prometheus text", () => {
    const reg = new MetricsRegistry();
    const c = reg.counter("zakura_http_requests_total", "HTTP requests");
    c.inc({ route_class: "api", status_class: "2xx" }, 3);
    const h = reg.histogram("zakura_http_request_duration_ms", "duration");
    h.observe(12, { route_class: "api" });
    h.observe(80, { route_class: "api" });
    const text = reg.renderPrometheus();
    assert.match(text, /zakura_http_requests_total\{.*route_class="api".*\} 3/);
    assert.match(text, /zakura_http_request_duration_ms_count\{route_class="api"\} 2/);
    assert.match(text, /le="\+Inf"/);
  });
});

describe("Telemetry health + component logger", () => {
  afterEach(() => {
    resetTelemetry({ service: "zakura-test", version: "test" }).shutdown();
  });

  it("fails ready until booted and critical deps are up", async () => {
    const t = resetTelemetry({ service: "zakura", version: "1.0.0" });
    t.registerCheck("db", async () => ({ status: "up" }), { critical: true });
    t.registerCheck("docker", async () => ({ status: "down" }), { critical: false });
    const before = await t.health.ready();
    assert.equal(before.status, "not_ready");
    t.health.setReady(true);
    const after = await t.health.ready();
    assert.equal(after.status, "ready");
    assert.equal(after.checks.docker?.status, "down");
    assert.equal(t.health.live().status, "ok");
    assert.equal(t.health.live().service, "zakura");
  });

  it("component info is metric-only", () => {
    const t = resetTelemetry({ service: "zakura", version: "test" });
    const logger = t.componentLogger("orch");
    logger.info("stdio-mcp ready", {
      instanceId: "i1",
      url: "http://127.0.0.1:9/mcp",
    });
    assert.equal(t.componentEvents.get({ component: "orch", level: "info" }), 1);
  });
});

describe("componentLogger export", () => {
  beforeEach(() => {
    resetTelemetry({ service: "zakura-test", version: "test" });
  });
  afterEach(() => {
    resetTelemetry({ service: "zakura-test", version: "test" }).shutdown();
  });

  it("does not throw when meta contains tenant fields", () => {
    const l = componentLogger("generic-mcp");
    l.warn("probe failed", { instanceId: "x", url: "https://evil.example" });
  });
});

describe("actor ids", () => {
  it("maps platform aliases to 0 and keeps real ids", () => {
    assert.equal(normalizeActorId(null), PLATFORM_ACTOR_ID);
    assert.equal(normalizeActorId("api-key"), PLATFORM_ACTOR_ID);
    assert.equal(normalizeActorId("0"), PLATFORM_ACTOR_ID);
    assert.equal(normalizeActorId("user_abc"), "user_abc");
    assert.deepEqual(idsFromSession({ userId: "api-key", tenantId: "ten_1" }), {
      userId: "0",
      tenantId: "ten_1",
    });
  });

  it("attaches context ids to every log line", () => {
    const lines: Array<Record<string, unknown>> = [];
    const logger = new OperationalLogger({
      service: "zakura",
      level: "info",
      rateLimitMs: 0,
      sink: (e) => lines.push(e),
    });
    withLogContext({ userId: "u_1", tenantId: "t_1" }, () => {
      logger.error("client.error", { kind: "window.onerror" });
    });
    assert.equal(lines[0]?.["user.id"], "u_1");
    assert.equal(lines[0]?.["tenant.id"], "t_1");
    assert.equal(lines[0]?.kind, "window.onerror");
  });
});

describe("otlp config + ingest parse", () => {
  const prev = {
    logs: process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
  };

  afterEach(() => {
    if (prev.logs === undefined) delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = prev.logs;
    if (prev.headers === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = prev.headers;
  });

  it("is disabled without LOGS_ENDPOINT", () => {
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    assert.equal(resolveOtlpLogsConfig(), null);
  });

  it("reads the official logs URL and headers", () => {
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "https://example.invalid/v1/logs";
    process.env.OTEL_EXPORTER_OTLP_HEADERS =
      "Authorization=Bearer tok,X-Axiom-Dataset=demo";
    const cfg = resolveOtlpLogsConfig();
    assert.equal(cfg?.url, "https://example.invalid/v1/logs");
    assert.equal(cfg?.headers.Authorization, "Bearer tok");
    assert.equal(cfg?.headers["X-Axiom-Dataset"], "demo");
  });

  it("parses browser OTLP JSON and drops client-supplied identity", () => {
    const recs = parseOtlpLogsPayload({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  severityNumber: 17,
                  severityText: "ERROR",
                  body: { stringValue: "boom" },
                  attributes: [
                    { key: "event.name", value: { stringValue: "client.error" } },
                    { key: "user.id", value: { stringValue: "spoof" } },
                    { key: "kind", value: { stringValue: "window.onerror" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    assert.equal(recs.length, 1);
    assert.equal(recs[0]?.level, "error");
    assert.equal(recs[0]?.event, "boom");
    assert.equal(recs[0]?.fields["event.name"], "client.error");
    assert.equal(recs[0]?.fields["user.id"], undefined);
    assert.equal(recs[0]?.fields.kind, "window.onerror");
  });

  it("accepts string severityNumber", () => {
    const recs = parseOtlpLogsPayload({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  severityNumber: "17",
                  severityText: "ERROR",
                  body: { stringValue: "str" },
                },
              ],
            },
          ],
        },
      ],
    });
    assert.equal(recs[0]?.level, "error");
  });

  it("stamps trusted actor ids onto resource and records", () => {
    const stamped = stampOtlpActorIds(
      {
        resourceLogs: [
          {
            resource: {
              attributes: [{ key: "service.name", value: { stringValue: "zakura-web" } }],
            },
            scopeLogs: [
              {
                logRecords: [
                  {
                    attributes: [{ key: "user.id", value: { stringValue: "spoof" } }],
                  },
                ],
              },
            ],
          },
        ],
      },
      { userId: "u_1", tenantId: "t_1" },
    ) as {
      resourceLogs: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
        scopeLogs: Array<{
          logRecords: Array<{ attributes: Array<{ key: string; value: { stringValue: string } }> }>;
        }>;
      }>;
    };
    const resource = stamped.resourceLogs[0]?.resource.attributes ?? [];
    const rec = stamped.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.attributes ?? [];
    assert.equal(resource.find((a) => a.key === "user.id")?.value.stringValue, "u_1");
    assert.equal(resource.find((a) => a.key === "tenant.id")?.value.stringValue, "t_1");
    assert.equal(rec.find((a) => a.key === "user.id")?.value.stringValue, "u_1");
    assert.equal(resource.some((a) => a.key === "service.name"), true);
  });
});
