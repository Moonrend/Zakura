import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { Hono } from "hono";
import { resetTelemetry } from "@zakura/core";
import { registerOtelRoutes } from "../src/api/otel-routes.js";

type Vars = {
  session?: { userId: string; tenantId: string; email: string; role: string };
};

function payload(severityNumber: number, body: string) {
  return {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                severityNumber,
                severityText: severityNumber >= 17 ? "ERROR" : "INFO",
                body: { stringValue: body },
                attributes: [{ key: "event.name", value: { stringValue: "client.error" } }],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("otel ingest", () => {
  afterEach(() => {
    resetTelemetry({ service: "zakura-test", version: "test" }).shutdown();
  });

  it("accepts error records and ignores info", async () => {
    resetTelemetry({ service: "zakura-test", version: "test" });
    const app = new Hono<{ Variables: Vars }>();
    app.use("*", async (c, next) => {
      c.set("session", {
        userId: "user_1",
        tenantId: "ten_1",
        email: "a@b.c",
        role: "owner",
      });
      await next();
    });
    registerOtelRoutes(app);

    const err = await app.request("/api/otel/v1/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload(17, "boom")),
    });
    assert.equal(err.status, 202);

    const info = await app.request("/api/otel/v1/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload(9, "hello")),
    });
    assert.equal(info.status, 204);
  });

  it("exposes collector config", async () => {
    resetTelemetry({ service: "zakura-test", version: "test" });
    const app = new Hono<{ Variables: Vars }>();
    registerOtelRoutes(app);
    const res = await app.request("/api/otel/config");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ingest: string; enabled: boolean };
    assert.equal(body.ingest, "/api/otel/v1/logs");
    assert.equal(body.enabled, true);
  });
});
