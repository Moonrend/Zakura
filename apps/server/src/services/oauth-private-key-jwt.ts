/**
 * OAuth private_key_jwt（RFC 7523）客户端断言验签。
 * ChatGPT CIMD 在 AS 支持时优先使用；JWKS 来自 CIMD 的 jwks_uri。
 * @see https://developers.openai.com/apps-sdk/build/auth
 */
import { createPublicKey, createVerify, type JsonWebKey } from "node:crypto";

const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

export { CLIENT_ASSERTION_TYPE };

type JwtHeader = {
  alg?: string;
  kid?: string;
  typ?: string;
};

type JwtClaims = {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nbf?: number;
  jti?: string;
};

function decodePart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
}

function audMatches(aud: string | string[] | undefined, expected: string): boolean {
  if (!aud) return false;
  if (typeof aud === "string") {
    return aud === expected || aud === expected.replace(/\/$/, "") || `${aud}/` === expected;
  }
  return aud.some((a) => audMatches(a, expected));
}

/** 从 JWKS 选中与 JWT header.kid 匹配的密钥（无 kid 则取第一把 RS256） */
export function pickJwk(
  jwks: { keys?: JsonWebKey[] },
  kid?: string,
): JsonWebKey {
  const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
  if (!keys.length) throw new Error("JWKS 为空");
  if (kid) {
    const hit = keys.find((k) => (k as { kid?: string }).kid === kid);
    if (!hit) throw new Error(`JWKS 中找不到 kid=${kid}`);
    return hit;
  }
  const rs = keys.find((k) => (k as { alg?: string }).alg === "RS256" || k.kty === "RSA");
  if (!rs) throw new Error("JWKS 中无可用 RSA 密钥");
  return rs;
}

export function verifyRs256Jwt(token: string, jwk: JsonWebKey): JwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("client_assertion 不是合法 JWT");
  const [h, p, s] = parts as [string, string, string];
  const header = decodePart<JwtHeader>(h);
  if (header.alg && header.alg !== "RS256") {
    throw new Error(`不支持的 client_assertion alg=${header.alg}`);
  }
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  verifier.end();
  if (!verifier.verify(key, Buffer.from(s, "base64url"))) {
    throw new Error("client_assertion 签名无效");
  }
  return decodePart<JwtClaims>(p);
}

/**
 * 校验 ChatGPT / CIMD 的 private_key_jwt 客户端断言。
 * 要求：iss=sub=client_id，aud=token_endpoint，未过期。
 */
export function verifyClientAssertion(input: {
  assertion: string;
  assertionType?: string;
  clientId: string;
  tokenEndpoint: string;
  jwk: JsonWebKey;
}): JwtClaims {
  if (
    input.assertionType &&
    input.assertionType !== CLIENT_ASSERTION_TYPE
  ) {
    throw new Error(
      `client_assertion_type 必须为 ${CLIENT_ASSERTION_TYPE}`,
    );
  }
  const claims = verifyRs256Jwt(input.assertion, input.jwk);
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== input.clientId) {
    throw new Error("client_assertion iss 必须等于 client_id");
  }
  if (claims.sub !== input.clientId) {
    throw new Error("client_assertion sub 必须等于 client_id");
  }
  if (!audMatches(claims.aud, input.tokenEndpoint)) {
    throw new Error(
      `client_assertion aud 必须为 token_endpoint（期望 ${input.tokenEndpoint}）`,
    );
  }
  if (typeof claims.exp !== "number" || claims.exp < now) {
    throw new Error("client_assertion 已过期");
  }
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) {
    throw new Error("client_assertion 尚未生效");
  }
  return claims;
}

/** 拉取远程 JWKS（短缓存由调用方负责） */
export async function fetchJwks(
  jwksUri: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ keys: JsonWebKey[] }> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts?.timeoutMs ?? 10_000);
  try {
    const res = await fetchImpl(jwksUri, {
      method: "GET",
      redirect: "manual",
      signal: ac.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "Zakura-MCP-OAuth/1.0 (private_key_jwt)",
      },
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`JWKS 被重定向（HTTP ${res.status}）`);
    }
    if (!res.ok) throw new Error(`JWKS 拉取失败: HTTP ${res.status}`);
    const raw = (await res.json()) as { keys?: JsonWebKey[] };
    if (!Array.isArray(raw.keys)) throw new Error("JWKS 缺少 keys");
    return { keys: raw.keys };
  } finally {
    clearTimeout(timer);
  }
}

export function decodeJwtHeader(token: string): JwtHeader {
  const h = token.split(".")[0];
  if (!h) throw new Error("空 JWT");
  return decodePart<JwtHeader>(h);
}
