/**
 * Wire types for image-update reporting, shared by every hop:
 *   runner probe → RunnerClient → server cache → HTTP API → web UI
 *
 * These were previously re-declared independently in six places (core's
 * ImageDigestInfo, two inline types in runner-client, DockerRuntime's return
 * type, the runner route's cast, the server checker, and the web's copy), so
 * adding a field meant six coordinated edits and the shapes had already drifted.
 */

/** What a probed image ref is *for*, decided server-side. */
export type ImageUpdateKind = "runner" | "workspace";

export type ImageUpdateEntry = {
  image: string;
  /** Local image id (sha256:…) from `docker inspect`; null when not pulled yet. */
  localId: string | null;
  /** Local RepoDigest for this repository, when available. */
  localDigest: string | null;
  /** Registry digest for the tag; null when the probe could not complete. */
  remoteDigest: string | null;
  /** Remote digest is known and differs from local (or local is absent). */
  updateAvailable: boolean;
  /**
   * A running container is on an older image id than the current tag — the image
   * was pulled but the container never recreated. Only meaningful for workspace
   * images; the runner's own container is not a workspace container, so this is
   * always false for `kind: "runner"`.
   */
  runningStale: boolean;
  /**
   * Why the probe could not complete. Note `updateAvailable: false` with a
   * non-null error means "unknown", not "up to date" — callers must not render
   * the two identically.
   */
  error: string | null;
  /**
   * Which upgrade action applies. Set by the server, which knows each node's
   * runner image; clients must not infer it by string-matching a default
   * constant (a runner deployed under any other tag would be misrouted into the
   * workspace refresh path and silently no-op).
   */
  kind?: ImageUpdateKind;
};

export type NodeImageUpdateStatus = {
  nodeId: string;
  /** Epoch ms of the probe that produced `entries`. */
  checkedAt: number;
  entries: ImageUpdateEntry[];
  /** At least one entry has a newer image on the registry. */
  hasUpdates: boolean;
  /** At least one running workspace container lags its tag. */
  hasRunningStale: boolean;
  /** Node-level failure (offline, auth, unreachable) — distinct from per-entry errors. */
  error: string | null;
};

/** True when any entry failed to probe, i.e. "up to date" cannot be claimed. */
export function hasImageProbeErrors(status: NodeImageUpdateStatus): boolean {
  return Boolean(status.error) || status.entries.some((e) => e.error !== null);
}
