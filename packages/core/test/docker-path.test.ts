import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { toDockerHostPath, unwrapShellCommand } from "../src/docker-path.js";

describe("unwrapShellCommand", () => {
  it("strips wrapping double quotes around a pipeline", () => {
    const raw =
      `"find /workspace -maxdepth 3 -type f -not -path '*/node_modules/*' -printf '%P\\n' | sort"`;
    const out = unwrapShellCommand(raw);
    assert.equal(
      out,
      "find /workspace -maxdepth 3 -type f -not -path '*/node_modules/*' -printf '%P\\n' | sort",
    );
  });

  it("strips wrapping single quotes around a multi-token command", () => {
    assert.equal(unwrapShellCommand("'ls -la /workspace'"), "ls -la /workspace");
  });

  it("keeps intentional single-token quotes", () => {
    assert.equal(unwrapShellCommand("'hello'"), "'hello'");
  });

  it("leaves unquoted commands unchanged", () => {
    assert.equal(unwrapShellCommand("python3 main.py"), "python3 main.py");
  });
});

describe("toDockerHostPath", () => {
  const prevPrefix = process.env.ZAKURA_DOCKER_HOST_MOUNT_PREFIX;

  beforeEach(() => {
    delete process.env.ZAKURA_DOCKER_HOST_MOUNT_PREFIX;
  });

  afterEach(() => {
    if (prevPrefix === undefined) delete process.env.ZAKURA_DOCKER_HOST_MOUNT_PREFIX;
    else process.env.ZAKURA_DOCKER_HOST_MOUNT_PREFIX = prevPrefix;
  });

  it("maps Windows drive paths for Docker Desktop (/mnt/host) on win32", () => {
    if (process.platform !== "win32") return;
    assert.equal(
      toDockerHostPath("d:\\data\\agents\\x\\workspace"),
      "/mnt/host/d/data/agents/x/workspace",
    );
  });

  it("maps Windows drive paths to /mnt on non-win32 by default", () => {
    if (process.platform === "win32") return;
    assert.equal(
      toDockerHostPath("d:\\data\\agents\\x\\workspace"),
      "/mnt/d/data/agents/x/workspace",
    );
  });

  it("respects ZAKURA_DOCKER_HOST_MOUNT_PREFIX", () => {
    process.env.ZAKURA_DOCKER_HOST_MOUNT_PREFIX = "/mnt/host";
    assert.equal(
      toDockerHostPath("d:\\data\\agents\\x\\workspace"),
      "/mnt/host/d/data/agents/x/workspace",
    );
    process.env.ZAKURA_DOCKER_HOST_MOUNT_PREFIX = "/mnt";
    assert.equal(
      toDockerHostPath("d:\\data\\agents\\x\\workspace"),
      "/mnt/d/data/agents/x/workspace",
    );
  });

  it("rewrites WSL /mnt/<drive> paths when prefix is /mnt/host", () => {
    process.env.ZAKURA_DOCKER_HOST_MOUNT_PREFIX = "/mnt/host";
    assert.equal(
      toDockerHostPath("/mnt/d/github/reCloud/data/agents/x/workspace"),
      "/mnt/host/d/github/reCloud/data/agents/x/workspace",
    );
  });

  it("does not double-prefix /mnt/host paths", () => {
    process.env.ZAKURA_DOCKER_HOST_MOUNT_PREFIX = "/mnt/host";
    assert.equal(
      toDockerHostPath("/mnt/host/d/data/agents/x/workspace"),
      "/mnt/host/d/data/agents/x/workspace",
    );
  });

  it("passes through Linux absolute paths", () => {
    assert.equal(
      toDockerHostPath("/var/lib/zakura/agents/x/workspace"),
      "/var/lib/zakura/agents/x/workspace",
    );
  });

  it("collapses duplicate slashes", () => {
    assert.equal(toDockerHostPath("/var//lib///zakura"), "/var/lib/zakura");
  });
});
