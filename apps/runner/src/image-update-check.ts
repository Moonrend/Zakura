/**
 * Re-export of the shared image-update probe.
 *
 * The implementation lives in `@zakura/core` so the server (probing local Docker
 * in-process) and the Runner (probing its own host) cannot drift apart.
 */
export {
  parseImageRef,
  normalizeImageRef,
  sameImageRepository,
  checkImageUpdate,
  checkImageUpdates,
  discoverDockerRegistryMirrors,
  groupRunningImageIds,
  type ImageRef,
  type ImageDigestInfo,
  type DockerLike,
  type ImageInspectLike,
  type ImageUpdateProbeOptions,
} from "@zakura/core";
