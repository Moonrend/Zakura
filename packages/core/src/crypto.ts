import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

const ALGO = "aes-256-gcm";

export class DecryptError extends Error {
  readonly code = "DECRYPT_FAILED" as const;
  constructor(message?: string, cause?: unknown) {
    super(
      message ??
        "解密失败：当前 ZAKURA_SECRET / data/secret.key 与密文不匹配（或数据已损坏）。请恢复原来的密钥，或重新配置受影响的实例。",
      { cause },
    );
    this.name = "DecryptError";
  }
}

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
  if (!payload || typeof payload !== "string") {
    throw new DecryptError("解密失败：密文为空");
  }
  try {
    const buf = Buffer.from(payload, "base64url");
    if (buf.length < 28) {
      throw new DecryptError("解密失败：密文格式无效");
    }
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const key = deriveKey(secret);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8")) as T;
  } catch (err) {
    if (err instanceof DecryptError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/authenticate data|Unsupported state|bad decrypt|unable to authenticate/i.test(msg)) {
      throw new DecryptError(undefined, err);
    }
    throw new DecryptError(`解密失败：${msg}`, err);
  }
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
