import type { Context, Next } from "hono";
import { hashRunnerToken } from "@zakura/core";

export type RunnerAuthConfig = {
  /** Raw rnr_ token expected from Server */
  token: string;
  tokenHash: string;
};

export function createAuthConfig(token: string): RunnerAuthConfig {
  if (!token || !token.startsWith("rnr_")) {
    throw new Error("ZAKURA_RUNNER_TOKEN must be a rnr_* token");
  }
  return { token, tokenHash: hashRunnerToken(token) };
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() || null;
}

export function tokenMatches(raw: string | null | undefined, cfg: RunnerAuthConfig): boolean {
  if (!raw) return false;
  if (raw === cfg.token) return true;
  return hashRunnerToken(raw) === cfg.tokenHash;
}

/** Hono middleware — require Bearer rnr_* matching configured token. */
export function requireRunnerAuth(cfg: RunnerAuthConfig) {
  return async (c: Context, next: Next) => {
    // ping is public for health probes; still works with auth
    if (c.req.path === "/v1/ping" || c.req.path === "/health") {
      await next();
      return;
    }
    const raw = extractBearer(c.req.header("authorization"));
    if (!tokenMatches(raw, cfg)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  };
}
