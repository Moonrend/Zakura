import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { resolveDockerContextSocketPath } from "../src/docker-endpoint.js";

function writeContext(root: string, name: string, host: string): void {
  const hash = createHash("sha256").update(name).digest("hex");
  const dir = join(root, "contexts", "meta", hash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ Endpoints: { docker: { Host: host } } }),
  );
}

function tempDockerConfig(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "zakura-docker-context-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("uses the Docker Desktop Linux named pipe from the active CLI context", (t) => {
  const root = tempDockerConfig(t);
  writeFileSync(join(root, "config.json"), JSON.stringify({ currentContext: "desktop-linux" }));
  writeContext(root, "desktop-linux", "npipe:////./pipe/dockerDesktopLinuxEngine");

  assert.equal(
    resolveDockerContextSocketPath({ env: { DOCKER_CONFIG: root }, homeDir: root }),
    "//./pipe/dockerDesktopLinuxEngine",
  );
});

test("DOCKER_CONTEXT overrides the context in config.json", (t) => {
  const root = tempDockerConfig(t);
  writeFileSync(join(root, "config.json"), JSON.stringify({ currentContext: "desktop-linux" }));
  writeContext(root, "rancher-desktop", "npipe:////./pipe/docker_engine_linux");

  assert.equal(
    resolveDockerContextSocketPath({
      env: { DOCKER_CONFIG: root, DOCKER_CONTEXT: "rancher-desktop" },
      homeDir: root,
    }),
    "//./pipe/docker_engine_linux",
  );
});

test("leaves explicit DOCKER_HOST to dockerode", (t) => {
  const root = tempDockerConfig(t);
  writeFileSync(join(root, "config.json"), JSON.stringify({ currentContext: "desktop-linux" }));
  writeContext(root, "desktop-linux", "npipe:////./pipe/dockerDesktopLinuxEngine");

  assert.equal(
    resolveDockerContextSocketPath({
      env: { DOCKER_CONFIG: root, DOCKER_HOST: "tcp://127.0.0.1:2375" },
      homeDir: root,
    }),
    undefined,
  );
});

test("falls back to dockerode defaults for default or invalid contexts", (t) => {
  const root = tempDockerConfig(t);
  writeFileSync(join(root, "config.json"), JSON.stringify({ currentContext: "default" }));

  assert.equal(
    resolveDockerContextSocketPath({ env: { DOCKER_CONFIG: root }, homeDir: root }),
    undefined,
  );

  writeFileSync(join(root, "config.json"), "not-json");
  assert.equal(
    resolveDockerContextSocketPath({ env: { DOCKER_CONFIG: root }, homeDir: root }),
    undefined,
  );
});
