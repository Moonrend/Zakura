import type { Context, Next } from "hono";
import { timingSafeEqual } from "node:crypto";
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

/** Length-safe constant-time comparison, so a mismatch leaks no timing signal. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function tokenMatches(raw: string | null | undefined, cfg: RunnerAuthConfig): boolean {
  if (!raw) return false;
  // Compare the hashes rather than short-circuiting on the raw value: both are
  // fixed-length, and `===` on a secret is a timing oracle.
  if (safeEqual(raw, cfg.token)) return true;
  return safeEqual(hashRunnerToken(raw), cfg.tokenHash);
}

/** Hono middleware — require Bearer rnr_* matching configured token. */
export function requireRunnerAuth(cfg: RunnerAuthConfig) {
  return async (c: Context, next: Next) => {
    const raw = extractBearer(c.req.header("authorization"));
    if (!tokenMatches(raw, cfg)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  };
}
