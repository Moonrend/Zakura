import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

const ALGO = "aes-256-gcm";

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, "zakura-v1", 32);
}

export function encryptJson(secret: string, value: unknown): string {
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

export function decryptJson<T = unknown>(secret: string, payload: string): T {
  const buf = Buffer.from(payload, "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const key = deriveKey(secret);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const raw = `zak_${randomBytes(24).toString("base64url")}`;
  return {
    raw,
    prefix: raw.slice(0, 12),
    hash: hashApiKey(raw),
  };
}

export function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    isError,
  };
}
