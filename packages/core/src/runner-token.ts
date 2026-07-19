import { createHash, randomBytes } from "node:crypto";

/** Generate a one-time Runner registration token (rnr_...). */
export function generateRunnerToken(): { raw: string; prefix: string; hash: string } {
  const raw = `rnr_${randomBytes(24).toString("base64url")}`;
  return {
    raw,
    prefix: raw.slice(0, 12),
    hash: hashRunnerToken(raw),
  };
}

export function hashRunnerToken(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function isRunnerToken(value: string | undefined | null): boolean {
  return typeof value === "string" && value.startsWith("rnr_");
}
