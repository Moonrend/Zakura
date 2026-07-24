import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, createVerify } from "node:crypto";
import {
  jwksDocument,
  loadOrCreateOauthSigningKey,
  signJwtRs256,
} from "../src/services/oauth-signing.js";

describe("oauth-signing RS256", () => {
  it("持久化密钥并签发可验证的 JWT", () => {
    const dir = mkdtempSync(join(tmpdir(), "zakura-oauth-"));
    try {
      const key1 = loadOrCreateOauthSigningKey(dir);
      const key2 = loadOrCreateOauthSigningKey(dir);
      assert.equal(key1.kid, key2.kid);

      const token = signJwtRs256(key1, {
        iss: "https://example.com",
        sub: "user1",
        aud: "https://chatgpt.com/oauth/client.json",
        iat: 1,
        exp: 9999999999,
      });
      const [h, p, s] = token.split(".");
      assert.ok(h && p && s);
      const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as {
        alg: string;
        kid: string;
      };
      assert.equal(header.alg, "RS256");
      assert.equal(header.kid, key1.kid);

      const jwks = jwksDocument(key1);
      assert.equal(jwks.keys.length, 1);
      const pub = createPublicKey({ key: jwks.keys[0]!, format: "jwk" });
      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${h}.${p}`);
      verifier.end();
      assert.equal(verifier.verify(pub, Buffer.from(s, "base64url")), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
