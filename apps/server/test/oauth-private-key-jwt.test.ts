import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSign, generateKeyPairSync } from "node:crypto";
import {
  CLIENT_ASSERTION_TYPE,
  pickJwk,
  verifyClientAssertion,
  verifyRs256Jwt,
} from "../src/services/oauth-private-key-jwt.js";

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

describe("oauth private_key_jwt", () => {
  it("验签合法 client_assertion", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    const clientId = "https://chatgpt.com/oauth/pRRt3ecBwyHH/client.json";
    const tokenEndpoint = "https://preview.moonrend.com/token";
    const now = Math.floor(Date.now() / 1000);
    const header = b64urlJson({ alg: "RS256", typ: "JWT", kid: "test" });
    const payload = b64urlJson({
      iss: clientId,
      sub: clientId,
      aud: tokenEndpoint,
      iat: now,
      exp: now + 300,
      jti: "jti-1",
    });
    const data = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(data);
    signer.end();
    const assertion = `${data}.${signer.sign(privateKey).toString("base64url")}`;

    const claims = verifyClientAssertion({
      assertion,
      assertionType: CLIENT_ASSERTION_TYPE,
      clientId,
      tokenEndpoint,
      jwk: pickJwk({ keys: [{ ...jwk, kid: "test", alg: "RS256" }] }, "test"),
    });
    assert.equal(claims.iss, clientId);
    assert.equal(verifyRs256Jwt(assertion, jwk).sub, clientId);
  });

  it("拒绝错误 aud", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    const clientId = "https://chatgpt.com/oauth/client.json";
    const now = Math.floor(Date.now() / 1000);
    const header = b64urlJson({ alg: "RS256", typ: "JWT" });
    const payload = b64urlJson({
      iss: clientId,
      sub: clientId,
      aud: "https://evil.example/token",
      exp: now + 300,
    });
    const data = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(data);
    signer.end();
    const assertion = `${data}.${signer.sign(privateKey).toString("base64url")}`;
    assert.throws(
      () =>
        verifyClientAssertion({
          assertion,
          clientId,
          tokenEndpoint: "https://preview.moonrend.com/token",
          jwk,
        }),
      /aud/,
    );
  });
});
