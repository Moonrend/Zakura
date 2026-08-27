/**
 * Bind-mount sources must be expressed in host-filesystem terms.
 *
 * Regression guard for the "workspace splits in two" bug: when Zakura runs in a
 * container that drives the host's docker.sock, handing the daemon our own
 * container-internal path makes it create a *different*, empty directory on the
 * host and mount that. Everything looks healthy until the user browses a folder
 * the agent created and gets
 *   ENOENT: no such file or directory, stat '<the very path they clicked>'
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapContainerPathToHost } from "../src/docker-path.js";

describe("mapContainerPathToHost", () => {
  it("rewrites a path under the mapped root", () => {
    assert.equal(
      mapContainerPathToHost(
        "/var/lib/zakura/agents/abc123/workspace",
        "/var/lib/zakura",
        "/var/zakura/node-a/data",
      ),
      "/var/zakura/node-a/data/agents/abc123/workspace",
    );
  });

  it("rewrites the root itself", () => {
    assert.equal(
      mapContainerPathToHost("/var/lib/zakura", "/var/lib/zakura", "/var/zakura/node-a/data"),
      "/var/zakura/node-a/data",
    );
  });

  it("is the identity when no host root is configured (bare-metal)", () => {
    assert.equal(
      mapContainerPathToHost(
        "/var/lib/zakura/agents/abc/workspace",
        "/var/lib/zakura",
        undefined,
      ),
      "/var/lib/zakura/agents/abc/workspace",
    );
  });

  it("is the identity when both roots match", () => {
    assert.equal(
      mapContainerPathToHost("/srv/data/agents/x/workspace", "/srv/data", "/srv/data"),
      "/srv/data/agents/x/workspace",
    );
  });

  it("maps the server's compose /data to the host bind dir", () => {
    assert.equal(
      mapContainerPathToHost("/data/agents/xyz/workspace", "/data", "/opt/zakura/data"),
      "/opt/zakura/data/agents/xyz/workspace",
    );
  });

  it("does not rewrite a path outside the mapped root", () => {
    assert.equal(
      mapContainerPathToHost("/elsewhere/agents/x", "/var/lib/zakura", "/var/zakura/a/data"),
      "/elsewhere/agents/x",
    );
  });

  it("does not treat a sibling with a shared prefix as inside the root", () => {
    // `/var/lib/zakura-old` must not be rewritten just because it starts with
    // `/var/lib/zakura`.
    assert.equal(
      mapContainerPathToHost("/var/lib/zakura-old/agents/x", "/var/lib/zakura", "/host/data"),
      "/var/lib/zakura-old/agents/x",
    );
  });

  it("tolerates trailing slashes and duplicate separators in the roots", () => {
    assert.equal(
      mapContainerPathToHost(
        "/var/lib/zakura//agents/abc/workspace",
        "/var/lib/zakura/",
        "/var/zakura/a/data/",
      ),
      "/var/zakura/a/data/agents/abc/workspace",
    );
  });
});
