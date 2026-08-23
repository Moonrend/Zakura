import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseImageRef,
  normalizeImageRef,
  checkImageUpdates,
  type DockerLike,
  type ImageInspectLike,
} from "../src/image-update-check.js";

/** Minimal fake docker client: holds a map of image-ref → inspect result. */
function fakeDocker(images: Record<string, ImageInspectLike>): DockerLike {
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
