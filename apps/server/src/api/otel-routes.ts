import type { Hono } from "hono";
import {
  forwardOtlpLogsPayload,
  idsFromSession,
  log,
  otlpDestinationHost,
  otlpExportEnabled,
  parseOtlpLogsPayload,
  resolveOtlpLogsConfig,
  stampOtlpActorIds,
  withLogContext,
} from "@zakura/core";
type AppVariables = {
  session?: { userId: string; tenantId: string; email: string; role: string };
};

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;
const hits = new Map<string, { n: number; resetAt: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const cur = hits.get(key);
  if (!cur || now >= cur.resetAt) {
    hits.set(key, { n: 1, resetAt: now + WINDOW_MS });
    if (hits.size > 2000) {
      for (const [k, v] of hits) {
        if (now >= v.resetAt) hits.delete(k);
      }
    }
    return false;
  }
  cur.n += 1;
  return cur.n > MAX_PER_WINDOW;
}

export function registerOtelRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.get("/api/otel/config", (c) => {
    const otlp = resolveOtlpLogsConfig();
    return c.json({
      enabled: true,
      ingest: "/api/otel/v1/logs",
      collector: otlpExportEnabled(),
      dest: otlp ? otlpDestinationHost(otlp.url) : null,
    });
  });

  app.post("/api/otel/v1/logs", async (c) => {
    const session = c.get("session");
    const ids = idsFromSession(session);
    const bucket = `${ids.userId}:${ids.tenantId}:${c.req.header("x-forwarded-for") ?? "local"}`;
    if (rateLimited(bucket)) return c.body(null, 429);

    const body = await c.req.json().catch(() => null);
    const records = parseOtlpLogsPayload(body, 32).filter(
      (rec) => rec.level === "error" || rec.level === "fatal",
    );
    if (records.length === 0) return c.body(null, 204);

    const stamped = stampOtlpActorIds(body, ids);
    void forwardOtlpLogsPayload(stamped);
    withLogContext(ids, () => {
      for (const rec of records) {
        const event =
          typeof rec.fields["event.name"] === "string"
            ? String(rec.fields["event.name"]).slice(0, 80)
            : rec.event.startsWith("client.")
              ? rec.event.slice(0, 80)
              : "client.error";
        const fields = {
          ...rec.fields,
          source: "web",
          err_message: rec.event,
          otlp_forwarded: true,
        };
        delete fields["event.name"];
        if (rec.level === "fatal") log.fatal(event, fields);
        else log.error(event, fields);
      }
    });
    return c.body(null, 202);
  });
}
