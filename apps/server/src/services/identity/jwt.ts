import { createPublicKey, createVerify, type JsonWebKey } from "node:crypto";

type Jwk = JsonWebKey & { kid?: string; kty?: string; alg?: string; use?: string };

const jwksCache = new Map<string, { expiresAt: number; keys: Jwk[] }>();

export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1]) return null;
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>,
      payload: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

export async function fetchJwks(jwksUrl: string): Promise<Jwk[]> {
  const cached = jwksCache.get(jwksUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;
  const res = await fetch(jwksUrl);
  if (!res.ok) throw new Error("无法读取 IdP JWKS");
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(jwksUrl, { keys, expiresAt: Date.now() + 10 * 60 * 1000 });
  return keys;
}

export async function verifyRs256Jwt(
  token: string,
  jwksUrl: string,
  expected: { issuer: string; audience: string; nonce?: string },
): Promise<Record<string, unknown>> {
  const decoded = decodeJwt(token);
  if (!decoded) throw new Error("id_token 无效");
  const alg = decoded.header.alg;
  if (alg !== "RS256") throw new Error("仅支持 RS256 id_token");
  const parts = token.split(".");
  const keys = await fetchJwks(jwksUrl);
  const kid = typeof decoded.header.kid === "string" ? decoded.header.kid : null;
  const jwk = (kid ? keys.find((k) => k.kid === kid) : keys[0]) ?? keys[0];
  if (!jwk) throw new Error("JWKS 中没有可用密钥");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  if (!verifier.verify(key, Buffer.from(parts[2]!, "base64url"))) {
    throw new Error("id_token 签名无效");
  }
  const payload = decoded.payload;
  if (payload.iss !== expected.issuer) throw new Error("id_token issuer 不匹配");
  const aud = payload.aud;
  const audOk = Array.isArray(aud) ? aud.includes(expected.audience) : aud === expected.audience;
  if (!audOk) throw new Error("id_token audience 不匹配");
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000 - 30) throw new Error("id_token 已过期");
  if (expected.nonce && payload.nonce !== expected.nonce) throw new Error("id_token nonce 不匹配");
  return payload;
}
