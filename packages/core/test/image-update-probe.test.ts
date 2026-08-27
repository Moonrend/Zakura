/**
 * Regression tests for the image-update probe.
 *
 * Each case here corresponds to a bug that shipped: a "check" that mutated the
 * host by pulling, registry ports silently dropped, a digest taken from an
 * unrelated repository, and a mirror-discovery failure cached forever.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseImageRef,
  normalizeImageRef,
  sameImageRepository,
  checkImageUpdate,
  discoverDockerRegistryMirrors,
  groupRunningImageIds,
  _resetMirrorCacheForTests,
  type DockerLike,
  type ImageInspectLike,
} from "../src/image-update-check.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

/** Minimal docker stub. `images` maps a ref to its inspect result. */
function fakeDocker(
  images: Record<string, ImageInspectLike>,
  opts?: { onPull?: (image: string) => string | null; info?: unknown },
): DockerLike & { pulls: string[] } {
  const pulls: string[] = [];
  return {
    pulls,
    getImage: (image: string) => ({
      inspect: async () => {
        const found = images[image];
        if (!found) throw new Error(`no such image: ${image}`);
        return found;
      },
    }),
    ...(opts?.info !== undefined
      ? { info: async () => opts.info as never }
      : {}),
    ...(opts?.onPull
      ? {
          pullToDigest: async (image: string) => {
            pulls.push(image);
            return opts.onPull!(image);
          },
        }
      : {}),
  };
}

/** A fetch that always fails, i.e. the registry is unreachable. */
const unreachableFetch: typeof fetch = async () => {
  throw new Error("ECONNREFUSED");
};

/** A fetch that answers the manifest HEAD with a digest. */
function digestFetch(digest: string, seen?: string[]): typeof fetch {
  return (async (url: string | URL) => {
    seen?.push(String(url));
    return new Response(null, {
      status: 200,
      headers: { "Docker-Content-Digest": digest },
    });
  }) as typeof fetch;
}

describe("parseImageRef", () => {
  it("keeps the registry port", () => {
    // Dropping the port made every ported/private registry probe hit the wrong
    // URL, always fail, and fall through to a full pull.
    const ref = parseImageRef("localhost:5000/team/app:v1");
    assert.equal(ref.registry, "localhost:5000");
    assert.equal(ref.repository, "team/app");
    assert.equal(ref.reference, "v1");
  });

  it("handles a ported registry with a digest", () => {
    const ref = parseImageRef(`harbor.corp:8443/lib/app@${DIGEST_A}`);
    assert.equal(ref.registry, "harbor.corp:8443");
    assert.equal(ref.repository, "lib/app");
    assert.equal(ref.reference, DIGEST_A);
    assert.equal(ref.isDigest, true);
  });

  it("defaults Docker Hub official images to library/", () => {
    const ref = parseImageRef("postgres:16");
    assert.equal(ref.registry, "registry-1.docker.io");
    assert.equal(ref.repository, "library/postgres");
    assert.equal(ref.reference, "16");
  });

  it("keeps a user namespace on Hub and defaults the tag", () => {
    const ref = parseImageRef("sunwuyuan/zakura-runner-dev");
    assert.equal(ref.repository, "sunwuyuan/zakura-runner-dev");
    assert.equal(ref.reference, "latest");
  });

  it("treats a dotted first component as a registry", () => {
    const ref = parseImageRef("ghcr.io/owner/name:tag");
    assert.equal(ref.registry, "ghcr.io");
    assert.equal(ref.repository, "owner/name");
  });
});

describe("normalizeImageRef / sameImageRepository", () => {
  it("collapses Hub aliases so running containers match probes", () => {
    const bare = normalizeImageRef("sunwuyuan/zakura-workspace-dev:debian");
    assert.equal(normalizeImageRef("docker.io/sunwuyuan/zakura-workspace-dev:debian"), bare);
    assert.equal(
      normalizeImageRef("registry-1.docker.io/sunwuyuan/zakura-workspace-dev:debian"),
      bare,
    );
    assert.equal(normalizeImageRef("index.docker.io/sunwuyuan/zakura-workspace-dev:debian"), bare);
  });

  it("matches repositories across tags but not across repositories", () => {
    assert.equal(sameImageRepository("acme/runner:v1", "acme/runner:v2"), true);
    assert.equal(sameImageRepository("acme/runner:v1", "docker.io/acme/runner:v9"), true);
    assert.equal(sameImageRepository("acme/runner:v1", "acme/other:v1"), false);
    assert.equal(sameImageRepository("acme/runner:v1", "ghcr.io/acme/runner:v1"), false);
  });
});

describe("checkImageUpdate", () => {
  it("does not pull by default, even when the registry is unreachable", async () => {
    // The whole point: a check must not change host state. Pulling here made the
    // reported update disappear on the next check, because the pull installed it.
    const docker = fakeDocker(
      { "acme/app:v1": { Id: "sha256:local", RepoDigests: [`acme/app@${DIGEST_A}`] } },
      { onPull: () => DIGEST_B },
    );
    const res = await checkImageUpdate(docker, "acme/app:v1", undefined, {
      fetchImpl: unreachableFetch,
    });
    assert.deepEqual(docker.pulls, [], "must not have pulled");
    assert.equal(res.remoteDigest, null);
    assert.equal(res.updateAvailable, false);
    assert.equal(res.error, "registry_probe_unavailable", "a failed probe must be reported");
  });

  it("pulls only when the caller opts in", async () => {
    const docker = fakeDocker(
      { "acme/app:v1": { Id: "sha256:local", RepoDigests: [`acme/app@${DIGEST_A}`] } },
      { onPull: () => DIGEST_B },
    );
    const res = await checkImageUpdate(docker, "acme/app:v1", undefined, {
      fetchImpl: unreachableFetch,
      allowPullFallback: true,
    });
    assert.deepEqual(docker.pulls, ["acme/app:v1"]);
    assert.equal(res.remoteDigest, DIGEST_B);
    assert.equal(res.updateAvailable, true);
  });

  it("reports an error rather than silently claiming up-to-date", async () => {
    // updateAvailable:false + error:null used to be returned for a failed probe,
    // which is indistinguishable from "you are current".
    const docker = fakeDocker({
      "acme/app:v1": { Id: "sha256:local", RepoDigests: [`acme/app@${DIGEST_A}`] },
    });
    const res = await checkImageUpdate(docker, "acme/app:v1", undefined, {
      fetchImpl: unreachableFetch,
    });
    assert.notEqual(res.error, null);
  });

  it("picks the RepoDigest for the right repository", async () => {
    // A multi-tagged image lists several RepoDigests. Taking [0] blindly yields a
    // digest from an unrelated repo, which never matches remote → phantom update.
    const docker = fakeDocker({
      "acme/app:v1": {
        Id: "sha256:local",
        RepoDigests: [
          `mirror.example.com/acme/app@${DIGEST_B}`,
          `acme/app@${DIGEST_A}`,
        ],
      },
    });
    const res = await checkImageUpdate(docker, "acme/app:v1", undefined, {
      fetchImpl: digestFetch(DIGEST_A),
    });
    assert.equal(res.localDigest, DIGEST_A);
    assert.equal(res.updateAvailable, false, "same digest must not report an update");
  });

  it("flags an update when digests differ", async () => {
    const docker = fakeDocker({
      "acme/app:v1": { Id: "sha256:local", RepoDigests: [`acme/app@${DIGEST_A}`] },
    });
    const res = await checkImageUpdate(docker, "acme/app:v1", undefined, {
      fetchImpl: digestFetch(DIGEST_B),
    });
    assert.equal(res.updateAvailable, true);
    assert.equal(res.error, null);
  });

  it("probes an insecure local registry over http", async () => {
    const urls: string[] = [];
    const docker = fakeDocker({
      "localhost:5000/acme/app:v1": { Id: "sha256:x", RepoDigests: [] },
    });
    await checkImageUpdate(docker, "localhost:5000/acme/app:v1", undefined, {
      fetchImpl: digestFetch(DIGEST_A, urls),
    });
    assert.ok(
      urls.some((u) => u.startsWith("http://localhost:5000/v2/")),
      `expected an http probe against the ported host, got ${JSON.stringify(urls)}`,
    );
  });

  it("reports runningStale when a container lags the tag", async () => {
    const docker = fakeDocker({
      "acme/app:v1": { Id: "sha256:new", RepoDigests: [`acme/app@${DIGEST_A}`] },
    });
    const res = await checkImageUpdate(docker, "acme/app:v1", new Set(["sha256:old"]), {
      fetchImpl: digestFetch(DIGEST_A),
    });
    assert.equal(res.runningStale, true);
    assert.equal(res.updateAvailable, false, "the tag itself is current");
  });
});

describe("groupRunningImageIds", () => {
  it("groups by normalized ref and skips entries without an image id", () => {
    const grouped = groupRunningImageIds([
      { Image: "docker.io/acme/app:v1", ImageID: "sha256:1" },
      { Image: "acme/app:v1", ImageID: "sha256:2" },
      // No ImageID: must be skipped, not inserted as "" (which made
      // runningStale spuriously true).
      { Image: "acme/app:v1", ImageID: "" },
      { Image: "", ImageID: "sha256:3" },
    ]);
    const key = normalizeImageRef("acme/app:v1");
    assert.deepEqual([...(grouped.get(key) ?? [])].sort(), ["sha256:1", "sha256:2"]);
    assert.equal(grouped.size, 1);
  });
});

describe("discoverDockerRegistryMirrors", () => {
  beforeEach(() => _resetMirrorCacheForTests());

  it("reads mirrors from the daemon and strips the scheme", async () => {
    const docker = fakeDocker({}, {
      info: { RegistryConfig: { Mirrors: ["https://mirror.example.com/"] } },
    });
    assert.deepEqual(await discoverDockerRegistryMirrors(docker), ["mirror.example.com"]);
  });

  it("does not cache a failure", async () => {
    // Caching `[]` (which is truthy) meant one transient error while the daemon
    // was still starting disabled mirror probing for the whole process lifetime.
    let calls = 0;
    const flaky: DockerLike = {
      getImage: () => ({ inspect: async () => ({ Id: null }) }),
      info: async () => {
        calls += 1;
        if (calls === 1) throw new Error("daemon not ready");
        return { RegistryConfig: { Mirrors: ["mirror.example.com"] } } as never;
      },
    };
    assert.deepEqual(await discoverDockerRegistryMirrors(flaky), []);
    assert.deepEqual(await discoverDockerRegistryMirrors(flaky), ["mirror.example.com"]);
    assert.equal(calls, 2);
  });

  it("caches a successful result", async () => {
    let calls = 0;
    const docker: DockerLike = {
      getImage: () => ({ inspect: async () => ({ Id: null }) }),
      info: async () => {
        calls += 1;
        return { RegistryConfig: { Mirrors: ["m.example.com"] } } as never;
      },
    };
    await discoverDockerRegistryMirrors(docker);
    await discoverDockerRegistryMirrors(docker);
    assert.equal(calls, 1);
  });

  it("ignores Docker Hub's own hosts listed as mirrors", async () => {
    const docker = fakeDocker({}, {
      info: { Mirrors: ["docker.io", "registry-1.docker.io", "real.mirror"] },
    });
    assert.deepEqual(await discoverDockerRegistryMirrors(docker), ["real.mirror"]);
  });
});
