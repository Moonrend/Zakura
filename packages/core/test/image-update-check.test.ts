import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseImageRef,
  normalizeImageRef,
  checkImageUpdates,
  discoverDockerRegistryMirrors,
  _resetMirrorCacheForTests,
  type DockerLike,
  type ImageInspectLike,
} from "../src/image-update-check.js";

/** Minimal fake docker client: holds a map of image-ref → inspect result. */
function fakeDocker(
  images: Record<string, ImageInspectLike>,
  opts?: { info?: () => Promise<unknown>; pullToDigest?: (image: string) => Promise<string | null> },
): DockerLike {
  return {
    getImage(image: string) {
      return {
        async inspect(): Promise<ImageInspectLike> {
          const hit = images[image];
          if (!hit) throw new Error("no such image");
          return hit;
        },
      };
    },
    ...(opts?.info ? { info: opts.info as DockerLike["info"] } : {}),
    ...(opts?.pullToDigest ? { pullToDigest: opts.pullToDigest } : {}),
  };
}

test("parseImageRef: Docker Hub namespace image keeps repository + tag", () => {
  const ref = parseImageRef("sunwuyuan/zakura-workspace-dev:debian");
  assert.equal(ref.registry, "registry-1.docker.io");
  assert.equal(ref.repository, "sunwuyuan/zakura-workspace-dev");
  assert.equal(ref.reference, "debian");
  assert.equal(ref.isDigest, false);
});

test("normalizeImageRef: aligns docker.io, registry-1.docker.io, and bare refs", () => {
  const bare = normalizeImageRef("sunwuyuan/zakura-workspace-dev:debian");
  assert.equal(
    normalizeImageRef("docker.io/sunwuyuan/zakura-workspace-dev:debian"),
    bare,
  );
  assert.equal(
    normalizeImageRef("registry-1.docker.io/sunwuyuan/zakura-workspace-dev:debian"),
    bare,
  );
  assert.equal(bare, "registry-1.docker.io/sunwuyuan/zakura-workspace-dev:debian");
});

/**
 * The running container is reported with a `docker.io/` prefix (as Docker
 * does for some pulls), but the server probes the bare `user/repo:tag`.
 * After normalizing both keys, the checker finds the stale image id and
 * flags `runningStale` — previously this silently stayed false.
 */
test("runningStale: true when running ref is docker.io-prefixed but probed is bare", async () => {
  const docker = fakeDocker({
    "sunwuyuan/zakura-workspace-dev:debian": {
      Id: "sha256:newimageid",
      RepoDigests: ["sunwuyuan/zakura-workspace-dev@sha256:newdigest"],
    },
  });
  const probed = "sunwuyuan/zakura-workspace-dev:debian";
  const reportedRef = "docker.io/sunwuyuan/zakura-workspace-dev:debian";
  const runningByRef = new Map<string, Set<string>>([
    [normalizeImageRef(reportedRef), new Set(["sha256:oldimageid"])],
  ]);
  const results = await checkImageUpdates(docker, [probed], runningByRef);
  assert.equal(results[0]!.runningStale, true);
});

test("runningStale: false when running container is already on the tag's image", async () => {
  const docker = fakeDocker({
    "sunwuyuan/zakura-workspace-dev:debian": {
      Id: "sha256:currentimageid",
      RepoDigests: ["sunwuyuan/zakura-workspace-dev@sha256:currentdigest"],
    },
  });
  const probed = "sunwuyuan/zakura-workspace-dev:debian";
  const runningByRef = new Map<string, Set<string>>([
    [normalizeImageRef("registry-1.docker.io/sunwuyuan/zakura-workspace-dev:debian"), new Set(["sha256:currentimageid"])],
  ]);
  const results = await checkImageUpdates(docker, [probed], runningByRef);
  assert.equal(results[0]!.runningStale, false);
});

/**
 * Hosts behind a Docker registry mirror (e.g. a China pull-through cache) can
 * reach the mirror but not registry-1.docker.io directly. The probe must try
 * the mirror first and return its digest so updateAvailable is detected;
 * otherwise the upstream timeout silently failed the whole check.
 */
test("probe: tries registry mirror before upstream for Docker Hub images", async () => {
  const docker = fakeDocker({
    "sunwuyuan/zakura-runner-dev:latest": {
      Id: "sha256:localid",
      RepoDigests: ["sunwuyuan/zakura-runner-dev@sha256:aaaa1111222233334444555566667777888899990000aaaabbbbccccddddeeee"],
    },
  });
  const newDigest = "sha256:bbbb1111222233334444555566667777888899990000aaaabbbbccccddddeeee";
  const fetchImpl = mockFetch({
    "https://mirror.ccs.tencentyun.com/v2/sunwuyuan/zakura-runner-dev/manifests/latest": {
      status: 200,
      headers: { "Docker-Content-Digest": newDigest },
    },
    // upstream must NOT be hit when the mirror answers — if it were, this test
    // still passes, but the mirror-first ordering is the point.
  });
  const results = await checkImageUpdates(
    docker,
    ["sunwuyuan/zakura-runner-dev:latest"],
    undefined,
    { registryMirrors: ["mirror.ccs.tencentyun.com"], fetchImpl },
  );
  assert.equal(results[0]!.remoteDigest, newDigest);
  assert.equal(results[0]!.updateAvailable, true);
});

test("probe: falls back to upstream when mirror returns no digest", async () => {
  const docker = fakeDocker({
    "sunwuyuan/zakura-runner-dev:latest": {
      Id: "sha256:localid",
      RepoDigests: ["sunwuyuan/zakura-runner-dev@sha256:aaaa1111222233334444555566667777888899990000aaaabbbbccccddddeeee"],
    },
  });
  const upstreamDigest = "sha256:cccc1111222233334444555566667777888899990000aaaabbbbccccddddeeee";
  const fetchImpl = mockFetch({
    // mirror returns 500 (no digest) → fall through to upstream
    "https://registry-1.docker.io/v2/sunwuyuan/zakura-runner-dev/manifests/latest": {
      status: 200,
      headers: { "Docker-Content-Digest": upstreamDigest },
    },
  });
  const results = await checkImageUpdates(
    docker,
    ["sunwuyuan/zakura-runner-dev:latest"],
    undefined,
    { registryMirrors: ["broken-mirror.example"], fetchImpl },
  );
  assert.equal(results[0]!.remoteDigest, upstreamDigest);
});

/** Build a fetch mock keyed by full URL → {status, headers}. */
function mockFetch(
  routes: Record<string, { status: number; headers: Record<string, string> }>,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const route = routes[url];
    if (route) {
      return new Response(null, {
        status: route.status,
        headers: route.headers,
      });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

test("discoverDockerRegistryMirrors: reads RegistryConfig.Mirrors from the daemon info", async () => {
  _resetMirrorCacheForTests();
  const docker = fakeDocker(
    {},
    {
      info: async () => ({
        RegistryConfig: { Mirrors: ["https://mirror.ccs.tencentyun.com"] },
      }),
    },
  );
  const mirrors = await discoverDockerRegistryMirrors(docker);
  assert.deepEqual(mirrors, ["mirror.ccs.tencentyun.com"]);
});

test("discoverDockerRegistryMirrors: empty when daemon reports no mirrors (filesystem fallback)", async () => {
  _resetMirrorCacheForTests();
  // No info() and no daemon.json on the test host → clean empty array, no throw.
  const mirrors = await discoverDockerRegistryMirrors(fakeDocker({}));
  assert.ok(Array.isArray(mirrors));
  assert.equal(mirrors.length, 0);
});

test("discoverDockerRegistryMirrors: strips scheme and trailing slash from mirror URLs", async () => {
  _resetMirrorCacheForTests();
  const docker = fakeDocker(
    {},
    {
      info: async () => ({
        RegistryConfig: { Mirrors: ["https://mirror.example.com/"] },
      }),
    },
  );
  const mirrors = await discoverDockerRegistryMirrors(docker);
  assert.deepEqual(mirrors, ["mirror.example.com"]);
});

/**
 * The daemon-pull fallback still exists for hosts whose registry is only
 * reachable through a proxy/auth the in-process probe cannot see — but it is
 * **opt-in**, because pulling mutates the host: the pull installs the new image,
 * so the very next check reports "up to date" even though nothing was recreated.
 * The background sweep therefore never passes the flag; only an explicit,
 * user-initiated check does.
 */
const REMOTE_DIGEST =
  "sha256:bbbb1111222233334444555566667777888899990000aaaabbbbccccddddeeee";
const LOCAL_DIGEST =
  "sha256:aaaa1111222233334444555566667777888899990000aaaabbbbccccddddeeee";

function pullFallbackDocker(pulls: string[]) {
  return fakeDocker(
    {
      "sunwuyuan/zakura-runner-dev:latest": {
        Id: "sha256:localid",
        RepoDigests: [`sunwuyuan/zakura-runner-dev@${LOCAL_DIGEST}`],
      },
    },
    {
      // No mirrors surfaced, so the manifest probe runs and fails via 404.
      info: async () => ({ RegistryConfig: {} }),
      pullToDigest: async (image: string) => {
        pulls.push(image);
        return REMOTE_DIGEST;
      },
    },
  );
}

test("checkImageUpdates: uses pullToDigest only when allowPullFallback is set", async () => {
  _resetMirrorCacheForTests();
  const pulls: string[] = [];
  const results = await checkImageUpdates(
    pullFallbackDocker(pulls),
    ["sunwuyuan/zakura-runner-dev:latest"],
    undefined,
    { fetchImpl: mockFetch({}), allowPullFallback: true },
  );
  assert.deepEqual(pulls, ["sunwuyuan/zakura-runner-dev:latest"]);
  assert.equal(results[0]!.remoteDigest, REMOTE_DIGEST);
  assert.equal(results[0]!.updateAvailable, true);
  assert.equal(results[0]!.error, null);
});

test("checkImageUpdates: never pulls during a default (background) check", async () => {
  _resetMirrorCacheForTests();
  const pulls: string[] = [];
  const results = await checkImageUpdates(
    pullFallbackDocker(pulls),
    ["sunwuyuan/zakura-runner-dev:latest"],
    undefined,
    { fetchImpl: mockFetch({}) },
  );
  assert.deepEqual(pulls, [], "a read-only check must not pull");
  assert.equal(results[0]!.remoteDigest, null);
  assert.equal(results[0]!.updateAvailable, false);
  // "unknown" must be distinguishable from "up to date".
  assert.equal(results[0]!.error, "registry_probe_unavailable");
});

/**
 * The host pulled the image through a registry mirror, so the bare-ref
 * inspect fails but the mirror-prefixed ref exists locally. Without trying
 * the prefixed candidate, localDigest stays null and every image falsely
 * reports "update available"; with it the digest is found and a same-digest
 * image correctly reports no update.
 */
test("inspectLocalImage: falls back to mirror-prefixed ref for local inspect", async () => {
  const docker = fakeDocker({
    "mirror.ccs.tencentyun.com/sunwuyuan/zakura-runner-dev:latest": {
      Id: "sha256:sameimageid",
      RepoDigests: ["sunwuyuan/zakura-runner-dev@sha256:aaaa1111222233334444555566667777888899990000aaaabbbbccccddddeeee"],
    },
  });
  const fetchImpl = mockFetch({
    "https://mirror.ccs.tencentyun.com/v2/sunwuyuan/zakura-runner-dev/manifests/latest": {
      status: 200,
      headers: { "Docker-Content-Digest": "sha256:aaaa1111222233334444555566667777888899990000aaaabbbbccccddddeeee" },
    },
  });
  const results = await checkImageUpdates(
    docker,
    ["sunwuyuan/zakura-runner-dev:latest"],
    undefined,
    { registryMirrors: ["mirror.ccs.tencentyun.com"], fetchImpl },
  );
  // local digest found via the prefixed ref == remote digest → no update.
  assert.equal(results[0]!.localDigest, results[0]!.remoteDigest);
  assert.equal(results[0]!.updateAvailable, false);
});
