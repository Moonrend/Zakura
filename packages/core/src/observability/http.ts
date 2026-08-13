/** Coarse HTTP route class — never the raw path (paths leak tenant ids / slugs). */

export type HttpRouteClass =
  | "probe"
  | "metrics"
  | "api"
  | "mcp"
  | "openai"
  | "realtime"
  | "oauth"
  | "other";

export function classifyHttpRoute(path: string): HttpRouteClass {
  if (
    path === "/livez" ||
    path === "/readyz" ||
    path === "/health" ||
    path === "/healthz" ||
    path === "/api/health" ||
    path === "/api/livez" ||
    path === "/api/ready" ||
    path === "/api/readyz"
  ) {
    return "probe";
  }
  if (path === "/metrics" || path === "/api/metrics") return "metrics";
  if (path.startsWith("/mcp")) return "mcp";
  if (path.startsWith("/v1")) return "openai";
  if (path.startsWith("/api/socket.io")) return "realtime";
  if (
    path.startsWith("/authorize") ||
    path.startsWith("/token") ||
    path.startsWith("/oauth") ||
    path.includes("/.well-known/")
  ) {
    return "oauth";
  }
  if (path.startsWith("/api/")) return "api";
  return "other";
}

export function classifyHttpStatus(status: number): string {
  if (!Number.isFinite(status) || status < 100) return "0xx";
  return `${Math.floor(status / 100)}xx`;
}

export function classifyHttpMethod(method: string): string {
  const m = method.toUpperCase();
  switch (m) {
    case "GET":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
    case "OPTIONS":
    case "HEAD":
      return m;
    default:
      return "OTHER";
  }
}
