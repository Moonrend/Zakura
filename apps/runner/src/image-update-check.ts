/**
 * Image update detection is now shared from @zakura/core so both the server
 * (local Docker probe) and the runner use a single implementation.
 * Re-exported here to keep existing import paths (`./image-update-check.js`)
 * stable; new code should import from `@zakura/core` directly.
 */
export {
  parseImageRef,
  checkImageUpdate,
  checkImageUpdates,
  type ImageRef,
  type ImageDigestInfo,
  type DockerLike,
  type ImageInspectLike,
} from "@zakura/core";
