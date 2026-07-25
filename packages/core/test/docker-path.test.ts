import { describe, it } from "node:test";
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
  it("maps Windows drive paths to Linux /mnt/<drive>/…", () => {
    assert.equal(
      toDockerHostPath("d:\\data\\agents\\x\\workspace"),
      "/mnt/d/data/agents/x/workspace",
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
