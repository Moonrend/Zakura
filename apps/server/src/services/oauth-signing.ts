/**
 * OIDC / OAuth JWT 签名密钥（RS256 + JWKS）。
 * ChatGPT 等公开客户端无法验证 HS256（无共享 secret），须用非对称算法。
 * access_token 与 id_token 共用同一密钥，经 jwks_uri 校验。
 */
import {
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type OauthSigningKey = {
  kid: string;
  privateKey: KeyObject;
  /** RFC 7517 JWK（含 kid / use / alg） */
  publicJwk: Record<string, unknown>;
};

type StoredKey = {
  kid: string;
  privateKeyPem: string;
};

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function toPublicJwk(publicKey: KeyObject, kid: string): Record<string, unknown> {
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { ...jwk, kid, use: "sig", alg: "RS256" };
}

export function loadOrCreateOauthSigningKey(dataDir: string): OauthSigningKey {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "oauth-signing.json");

  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as StoredKey;
    const privateKey = createPrivateKey(raw.privateKeyPem);
    const publicKey = createPublicKey(privateKey);
    return {
      kid: raw.kid,
      privateKey,
      publicJwk: toPublicJwk(publicKey, raw.kid),
    };
  }

  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const kid = `zakura-${randomBytes(8).toString("hex")}`;
  const privateKeyPem = privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;

  const stored: StoredKey = { kid, privateKeyPem };
  writeFileSync(path, JSON.stringify(stored, null, 2), { mode: 0o600 });

  return {
    kid,
    privateKey,
    publicJwk: toPublicJwk(publicKey, kid),
  };
}

/** 签发 RS256 JWT（id_token / access token） */
export function signJwtRs256(
  key: OauthSigningKey,
  claims: Record<string, unknown>,
  opts?: { typ?: string },
): string {
  const header = b64urlJson({
    alg: "RS256",
    typ: opts?.typ ?? "JWT",
    kid: key.kid,
  });
  const payload = b64urlJson(claims);
  const data = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  const sig = signer.sign(key.privateKey).toString("base64url");
  return `${data}.${sig}`;
}

/** 校验本 AS 签发的 RS256 JWT；成功返回 claims，失败返回 null */
export function verifyJwtRs256(
  key: OauthSigningKey,
  token: string,
): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  if (!headerB64 || !payloadB64 || !sigB64) return null;

  try {
    const header = JSON.parse(
      Buffer.from(headerB64, "base64url").toString("utf8"),
    ) as { alg?: string; kid?: string };
    if (header.alg !== "RS256") return null;
    if (header.kid && header.kid !== key.kid) return null;

    const data = `${headerB64}.${payloadB64}`;
    const verifier = createVerify("RSA-SHA256");
    verifier.update(data);
    verifier.end();
    if (!verifier.verify(key.privateKey, Buffer.from(sigB64, "base64url"))) {
      return null;
    }

    return JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function jwksDocument(key: OauthSigningKey): { keys: Record<string, unknown>[] } {
  return { keys: [key.publicJwk] };
}
