"use client";

const PLATFORM_ID = "0";
const INGEST = "/api/otel/v1/logs";

type Identity = { userId: string; tenantId: string };

let identity: Identity = { userId: PLATFORM_ID, tenantId: PLATFORM_ID };
let hooksInstalled = false;
let lastSent = "";
let lastSentAt = 0;

function normalizeId(id: unknown): string {
  if (typeof id !== "string") return PLATFORM_ID;
  const trimmed = id.trim();
  if (!trimmed || trimmed === "api-key") return PLATFORM_ID;
  return trimmed.slice(0, 128);
}

function sessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("zakura_session");
}

export function setOtelIdentity(userId?: string | null, tenantId?: string | null): void {
  identity = {
    userId: normalizeId(userId),
    tenantId: normalizeId(tenantId),
  };
}

function otlpErrorPayload(
  event: string,
  message: string,
  extra?: Record<string, string | number | boolean>,
): Record<string, unknown> {
  const attrs: Array<{ key: string; value: Record<string, unknown> }> = [
    { key: "event.name", value: { stringValue: event } },
    { key: "user.id", value: { stringValue: identity.userId } },
    { key: "tenant.id", value: { stringValue: identity.tenantId } },
    { key: "exception.message", value: { stringValue: message } },
    { key: "service.name", value: { stringValue: "zakura-web" } },
  ];
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (typeof value === "boolean") attrs.push({ key, value: { boolValue: value } });
    else if (typeof value === "number") attrs.push({ key, value: { doubleValue: value } });
    else attrs.push({ key, value: { stringValue: String(value) } });
  }
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "zakura-web" } },
            { key: "service.version", value: { stringValue: "0.1.0" } },
            { key: "telemetry.sdk.language", value: { stringValue: "webjs" } },
            {
              key: "user_agent.original",
              value: { stringValue: navigator.userAgent.slice(0, 240) },
            },
          ],
        },
        scopeLogs: [
          {
            scope: { name: "zakura-web" },
            logRecords: [
              {
                timeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
                severityNumber: 17,
                severityText: "ERROR",
                body: { stringValue: message },
                attributes: attrs,
              },
            ],
          },
        ],
      },
    ],
  };
}

function postError(
  event: string,
  message: string,
  extra?: Record<string, string | number | boolean>,
): void {
  if (typeof window === "undefined" || !message) return;
  const key = `${event}:${message}`;
  const now = Date.now();
  if (key === lastSent && now - lastSentAt < 5000) return;
  lastSent = key;
  lastSentAt = now;

  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = sessionToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  void fetch(INGEST, {
    method: "POST",
    headers,
    body: JSON.stringify(otlpErrorPayload(event, message.slice(0, 240), extra)),
    keepalive: true,
  }).catch(() => undefined);
}

export function reportClientError(
  event: string,
  err: unknown,
  extra?: Record<string, string | number | boolean>,
): void {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "unknown error";
  postError(event.slice(0, 80) || "client.error", message, {
    "exception.type": err instanceof Error ? err.name : "Error",
    ...extra,
  });
}

function installHooks(): void {
  if (typeof window === "undefined" || hooksInstalled) return;
  hooksInstalled = true;
  window.addEventListener("error", (ev) => {
    reportClientError("client.uncaught", ev.error ?? ev.message, { kind: "window.onerror" });
  });
  window.addEventListener("unhandledrejection", (ev) => {
    reportClientError("client.unhandledrejection", ev.reason, { kind: "unhandledrejection" });
  });
  window.addEventListener("zakura_session_changed", () => {
    if (!sessionToken()) setOtelIdentity(PLATFORM_ID, PLATFORM_ID);
  });
}

async function hydrateIdentity(): Promise<void> {
  const token = sessionToken();
  if (!token) {
    setOtelIdentity(PLATFORM_ID, PLATFORM_ID);
    return;
  }
  try {
    const res = await fetch("/api/me", {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = (await res.json()) as {
      user?: { id?: string };
      tenant?: { id?: string };
    };
    setOtelIdentity(data.user?.id, data.tenant?.id);
  } catch {
    // stay at 0
  }
}

export function initWebOtel(): void {
  installHooks();
  void hydrateIdentity();
}

if (typeof window !== "undefined") installHooks();
