import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { Hono } from "hono";
import { resetTelemetry } from "@zakura/core";
import { mountPlatformProbes, SERVER_VERSION } from "../src/observability.js";

describe("platform probes", () => {
  afterEach(() => {
    resetTelemetry({ service: "zakura", version: SERVER_VERSION }).shutdown();
  });

  it("livez is 200 without leaking urls", async () => {
    const t = resetTelemetry({ service: "zakura", version: SERVER_VERSION });
    const app = new Hono();
    mountPlatformProbes(app);
    const res = await app.request("/livez");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, "ok");
    assert.equal(body.service, "zakura");
    assert.equal(body.version, SERVER_VERSION);
    assert.equal("endpoints" in body, false);
    assert.equal(typeof body.uptimeSec, "number");
    t.shutdown();
  });

  it("readyz is 503 until boot completes", async () => {
    resetTelemetry({ service: "zakura", version: SERVER_VERSION });
    const app = new Hono();
    mountPlatformProbes(app);
    const res = await app.request("/readyz");
    assert.equal(res.status, 503);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "not_ready");
  });

  it("metrics is prometheus text", async () => {
    const t = resetTelemetry({ service: "zakura", version: SERVER_VERSION });
    t.recordHttp("GET", "/api/agents/secret-slug", 200, 12);
    const app = new Hono();
    mountPlatformProbes(app);
    const res = await app.request("/metrics");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /zakura_http_requests_total/);
    assert.equal(text.includes("secret-slug"), false);
    assert.match(text, /route_class="api"/);
  });
});
