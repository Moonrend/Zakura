import assert from "node:assert/strict";
import test from "node:test";

import { resolveInternalBaseUrl } from "../src/config.ts";

/**
 * ACP adapters run in sibling containers and dial back into this server for the
 * Zakura MCP gateway and the model route. `ZAKURA_PUBLIC_URL` is routinely an
 * external address (a public IP, or a hostname resolved by an outside proxy)
 * that does not resolve from inside the Docker network — handing it to an
 * adapter makes the MCP handshake fail with `UnexpectedHttpStatus`, which
 * surfaces to users as "Required MCP server 'zakura' failed to start".
 *
 * The container probe is injected so both deployment shapes are exercised
 * regardless of where the suite happens to run.
 */

const IN_CONTAINER = () => true;
const ON_METAL = () => false;

const ENV_KEYS = ["ZAKURA_INTERNAL_URL", "ZAKURA_CONTAINER_ALIAS", "HOSTNAME"] as const;

function withEnv(
  vars: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  fn: () => void,
) {
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) {
      const v = vars[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const PUBLIC = "http://203.0.113.7:8787";

test("inside a container the external public URL is never handed to adapters", () => {
  // The actual regression: publicBaseUrl went straight to the adapters, so the
  // MCP handshake dialled an address the container could not route to.
  withEnv({ HOSTNAME: "6336eee233e4" }, () => {
    const resolved = resolveInternalBaseUrl(PUBLIC, 8787, IN_CONTAINER);
    assert.equal(resolved, "http://6336eee233e4:8787", "must use the container DNS alias");
    assert.notEqual(resolved, PUBLIC, "must not hand adapters the unroutable external address");
  });
});

test("an explicit container alias beats the hostname", () => {
  withEnv({ ZAKURA_CONTAINER_ALIAS: "zakura-dev", HOSTNAME: "6336eee233e4" }, () => {
    assert.equal(resolveInternalBaseUrl(PUBLIC, 8787, IN_CONTAINER), "http://zakura-dev:8787");
  });
});

test("ZAKURA_INTERNAL_URL always wins and loses its trailing slash", () => {
  // Escape hatch for split-horizon DNS and sidecar proxies.
  withEnv({ ZAKURA_INTERNAL_URL: "http://zakura.internal:8787/", HOSTNAME: "6336eee233e4" }, () => {
    assert.equal(
      resolveInternalBaseUrl(PUBLIC, 8787, IN_CONTAINER),
      "http://zakura.internal:8787",
      "explicit override must beat both the alias and the public URL",
    );
  });
});

test("outside a container the public URL is the reachable URL", () => {
  // A bare-metal server has no separate internal address, so rewriting to a
  // container alias here would break an otherwise working deployment.
  withEnv({ HOSTNAME: "some-build-host" }, () => {
    assert.equal(resolveInternalBaseUrl("https://zakura.example/", 8787, ON_METAL), "https://zakura.example");
  });
});

test("a container with no resolvable alias falls back instead of emitting http://undefined", () => {
  withEnv({}, () => {
    assert.equal(resolveInternalBaseUrl(PUBLIC, 8787, IN_CONTAINER), PUBLIC);
  });
});