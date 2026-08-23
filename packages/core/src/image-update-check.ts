/**
 * Image update detection: compare local image digest against the remote
 * registry digest to decide whether a newer image is available.
 *
 * Works for Docker Hub and any registry that serves the v2 manifest API.
 * We do NOT pull the image — only fetch the manifest digest via a HEAD
 * request (Accept: application/vnd.docker.distribution.manifest.v2+json),
 * which returns the `Docker-Content-Digest` header. For multi-arch images
 * the manifest list digest is used (stable across architectures).
 *
 * Shared between the server (local Docker probe) and the runner (remote
 * probe over its API). Uses a minimal structural interface instead of the
 * `dockerode` type so this module stays dependency-free; any client whose
 * `getImage(image).inspect()` returns `{ Id, RepoDigests }` satisfies it.
 */
import { log } from "./observability/index.js";

export type ImageRef = {
  /** Full registry domain, e.g. "registry-1.docker.io" or "ghcr.io". Empty for Docker Hub implicit. */
  registry: string;
  /** Repository (namespace/name), e.g. "sunwuyuan/zakura-workspace-dev". */
  repository: string;
  /** Tag or digest; defaults to "latest" when absent. */
  reference: string;
  /** True when reference is already a digest (sha256:...). */
  isDigest: boolean;
};

/**
 * Per-probe options. `registryMirrors` lets a caller on a host whose Docker
 * daemon is configured with registry mirrors (e.g. behind a corporate proxy or
 * a China mirror like mirror.ccs.tencentyun.com) probe the mirror instead of
 * the real upstream — the host can reach the mirror but not registry-1.docker.io,
 * so probing upstream always timed out and the update check silently failed.
 * Each mirror is tried in order; the upstream registry is always the final
 * fallback so a misconfigured mirror never hides a real update. `fetchImpl`
 * lets the runner inject a proxy-aware fetch (it otherwise strips HTTP(S)_PROXY).
 */
export type ImageUpdateProbeOptions = {
  registryMirrors?: string[];
  fetchImpl?: typeof fetch;
};

/** Canonical Docker Hub registry host used when no registry is specified. */
const DOCKER_HUB_REGISTRY = "registry-1.docker.io";
const DOCKER_HUB_OFFICIAL = "library";

/**
 * Parse a docker image reference into registry / repository / reference.
 * Mirrors Docker's own reference parsing rules:
 *   - first component with '.' or ':' or is "localhost" → registry
 *   - remaining (minus tag) → repository (official images get "library/" prefix on Hub)
 *   - last component after ':' (when not a port) → tag
 *   - '@sha256:...' → digest reference
 */
export function parseImageRef(image: string): ImageRef {
  const raw = image.trim();
  if (!raw) throw new Error("empty image reference");

  // digest form: [registry/]repo@sha256:...
  const atIdx = raw.indexOf("@");
  if (atIdx >= 0) {
    const digest = raw.slice(atIdx + 1);
    const rest = raw.slice(0, atIdx);
    const [registry, repository] = splitRegistryRepo(rest);
    return { registry, repository, reference: digest, isDigest: true };
  }

  // tag form: possibly registry/repo:tag — but ':' may also be a registry port.
  // Heuristic: split on first '/' to detect registry, then split the tail on last ':'.
  const slashIdx = raw.indexOf("/");
  let head = "";
  let tail = raw;
  if (slashIdx > 0) {
    head = raw.slice(0, slashIdx);
    tail = raw.slice(slashIdx + 1);
  }
  const hasRegistry =
    head && (/^[a-z0-9.-]+(:\d+)?$/.test(head) && (head.includes(".") || head.includes(":") || head === "localhost"));

  let registry = "";
  let repoPath = raw;
  if (hasRegistry) {
    registry = head.split(":")[0] ?? "";
    repoPath = tail;
  }

  // strip tag from repoPath (last ':' that's not part of a port-like component is hard,
  // but image tags never contain '/', so find the last ':' after the final '/').
  const lastSlash = repoPath.lastIndexOf("/");
  const lastColon = repoPath.lastIndexOf(":");
  let reference = "latest";
  let repository = repoPath;
  if (lastColon > lastSlash && lastColon >= 0) {
    reference = repoPath.slice(lastColon + 1) || "latest";
    repository = repoPath.slice(0, lastColon);
  }
  if (!registry) {
    registry = DOCKER_HUB_REGISTRY;
    if (!repository.includes("/")) repository = `${DOCKER_HUB_OFFICIAL}/${repository}`;
  }
  return { registry, repository, reference, isDigest: false };
}

function splitRegistryRepo(s: string): [string, string] {
  const slashIdx = s.indexOf("/");
  const head = s.slice(0, slashIdx);
  if (slashIdx > 0 && head && (head.includes(".") || head.includes(":") || head === "localhost")) {
    return [head.split(":")[0] ?? "", s.slice(slashIdx + 1)];
  }
  // no explicit registry → Docker Hub
  const repo = slashIdx > 0 ? s : `${DOCKER_HUB_OFFICIAL}/${s}`;
  return [DOCKER_HUB_REGISTRY, repo];
}

/**
 * Canonical hostname for Docker Hub. Docker reports container `Image` refs
 * with either `docker.io` or `registry-1.docker.io` (and bare for Hub images),
 * so normalizing to the one host lets callers group + match running
 * containers against the bare refs the server probes.
 */
function canonicalRegistry(registry: string): string {
  return registry === "docker.io" ? DOCKER_HUB_REGISTRY : registry;
}

/**
 * Canonical comparison key for an image ref: `<canonical-registry>/<repo>:<ref>`.
 * Use this to key the running-container map and to look it up by the probed
 * ref string, so a container reported as `docker.io/...` or
 * `registry-1.docker.io/...` matches a probe for the bare `user/repo:tag`.
 */
export function normalizeImageRef(image: string): string {
  const { registry, repository, reference } = parseImageRef(image);
  return `${canonicalRegistry(registry)}/${repository}:${reference}`;
}

export type ImageDigestInfo = {
  image: string;
  /** Local image id (sha256:...) from `docker inspect`. */
  localId: string | null;
  /** Local RepoDigest (registry/repo@sha256:...) when available. */
  localDigest: string | null;
  /** Remote registry digest (sha256:...) when probeable. */
  remoteDigest: string | null;
  /** True when remote digest differs from local (or local is missing). */
  updateAvailable: boolean;
  /**
   * True when a running workspace container uses an image id that differs from
   * the current tag's image id — i.e. the image was pulled but the container
   * was never recreated, so it's still on an older image. The user must
   * "refresh workspace image" (recreate) to pick up the new image.
   */
  runningStale: boolean;
  /** Reason when the probe could not complete (offline / private registry / auth). */
  error: string | null;
};

/**
 * Minimal structural view of a dockerode-like client. We only need
 * `getImage(image).inspect()` returning `{ Id, RepoDigests }`, so we accept
 * any object that satisfies this shape and avoid a hard `dockerode` dep here.
 */
export interface ImageInspectLike {
  Id: string | null;
  RepoDigests?: string[];
}
export interface DockerLike {
  getImage(image: string): { inspect(): Promise<ImageInspectLike> };
}

/**
 * Discover Docker registry mirror hosts the daemon is configured to use, so a
 * host that can reach its mirror but not registry-1.docker.io directly (common
 * behind a China mirror like mirror.ccs.tencentyun.com) can still probe for
 * image updates. Reads `registry-mirrors` from the Docker daemon config and
 * the docker CLI config; returns bare hosts (no scheme). Cached for the
 * process lifetime — mirrors don't change without a daemon restart.
 *
 * ponytail: this is best-effort discovery; if neither file is readable or
 * lists no mirrors, callers fall back to probing the upstream registry
 * (the previous behavior). No schema/env wiring needed — the host's existing
 * daemon config is the source of truth.
 */
let discoveredMirrors: string[] | null = null;
export async function discoverDockerRegistryMirrors(): Promise<string[]> {
  if (discoveredMirrors) return discoveredMirrors;
  const hosts = new Set<string>();
  // Daemon config: /etc/docker/daemon.json (Linux) — `registry-mirrors` array.
  // Also check ~/.docker/daemon.json and DOCKER_CONFIG for completeness.
  const daemonPaths = [
    "/etc/docker/daemon.json",
    `${process.env.HOME ?? ""}/.docker/daemon.json`,
    `${process.env.DOCKER_CONFIG ?? ""}/daemon.json`,
  ].filter(Boolean);
  for (const p of daemonPaths) {
    await readMirrorsFromJsonFile(p, "registry-mirrors", hosts);
  }
  // CLI config: ~/.docker/config.json — `credsStore`/`auths` aside, the daemon
  // mirror list lives in daemon.json, but some setups (rootless, colima) put a
  // `registry-mirrors` key in the CLI config too.
  const cliPath = `${process.env.DOCKER_CONFIG ?? `${process.env.HOME ?? ""}/.docker`}/config.json`;
  await readMirrorsFromJsonFile(cliPath, "registry-mirrors", hosts);
  discoveredMirrors = [...hosts].map(stripScheme).filter((h) => h && h !== DOCKER_HUB_REGISTRY && h !== "docker.io");
  return discoveredMirrors;
}

async function readMirrorsFromJsonFile(
  path: string,
  key: string,
  into: Set<string>,
): Promise<void> {
  try {
    const { readFileSync } = await import("node:fs");
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return;
    }
    const json = JSON.parse(raw) as Record<string, unknown>;
    const val = json[key];
    if (Array.isArray(val)) {
      for (const h of val) {
        if (typeof h === "string") into.add(h.trim());
      }
    }
  } catch {
    /* ignore unreadable/invalid config — fall back to upstream */
  }
}

function stripScheme(host: string): string {
  return host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/** Inspect a local image and extract its digest + image id. */
async function inspectLocalImage(
  docker: DockerLike,
  image: string,
  mirrors?: string[],
): Promise<{ id: string | null; digest: string | null }> {
  // The host may have pulled the image through a registry mirror, in which case
  // the image is tagged with the mirror prefix (e.g.
  // `mirror.ccs.tencentyun.com/sunwuyuan/...`) and the bare ref inspect fails.
  // Try the bare ref first, then each mirror-prefixed ref so the local digest
  // is found and the update comparison is correct (otherwise it stays null and
  // every image falsely reports "update available").
  const candidates = [image];
  const ref = parseImageRef(image);
  if (mirrors && ref.registry === DOCKER_HUB_REGISTRY) {
    for (const m of mirrors) {
      candidates.push(`${m}/${ref.repository}:${ref.reference}`);
    }
  }
  for (const candidate of candidates) {
    try {
      const info = await docker.getImage(candidate).inspect();
      const id = info.Id ?? null;
      const digests = info.RepoDigests ?? [];
      const digest = digests.length ? (digests[0]!.split("@")[1] ?? null) : null;
      return { id, digest };
    } catch {
      /* try next candidate / fall through to null */
    }
  }
  return { id: null, digest: null };
}

/**
 * Fetch the remote registry manifest digest for `ref` without pulling.
 * Uses an anonymous (unauthenticated) HEAD against the v2 manifest API.
 * Returns null when the registry requires auth or is unreachable.
 *
 * When `mirrors` is non-empty, each mirror host is probed first (the host can
 * reach its configured mirror but not registry-1.docker.io directly — common
 * behind a China registry mirror). The upstream registry is always the last
 * attempt so a misconfigured mirror can never mask a real update.
 */
async function probeRemoteDigest(
  ref: ImageRef,
  opts?: ImageUpdateProbeOptions,
): Promise<string | null> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  // Mirror hosts are only valid for Docker Hub images (a mirror is a Hub
  // pull-through cache). For ghcr.io / private registries, probe upstream only.
  const mirrors =
    ref.registry === DOCKER_HUB_REGISTRY ? opts?.registryMirrors ?? [] : [];
  const hosts = [...mirrors, ref.registry];
  for (const host of hosts) {
    const digest = await probeDigestOnHost(ref, host, fetchImpl);
    if (digest) return digest;
  }
  return null;
}

async function probeDigestOnHost(
  ref: ImageRef,
  host: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const { repository, reference } = ref;
  const accept =
    "application/vnd.oci.image.index.v1+json, " +
    "application/vnd.docker.distribution.manifest.list.v2+json, " +
    "application/vnd.oci.image.manifest.v1+json, " +
    "application/vnd.docker.distribution.manifest.v2+json";
  const refPath = ref.isDigest
    ? `/v2/${encodeURIComponent(repository).replace(/%2F/g, "/")}/manifests/${reference}`
    : `/v2/${encodeURIComponent(repository).replace(/%2F/g, "/")}/manifests/${encodeURIComponent(reference)}`;
  const url = `https://${host}${refPath}`;
  try {
    const res = await fetchImpl(url, {
      method: "HEAD",
      headers: { Accept: accept, "User-Agent": "zakura-runner/1.0" },
      redirect: "follow",
    });
    if (!res.ok && res.status !== 401) return null;
    const digest = res.headers.get("Docker-Content-Digest");
    if (digest && /^sha256:[0-9a-f]{64}$/.test(digest)) return digest;
    // Docker Hub (and Hub mirrors) require a bearer token for anonymous reads.
    if (res.status === 401) {
      const token = await fetchAnonymousToken(host, repository, fetchImpl);
      if (!token) return null;
      const retry = await fetchImpl(url, {
        method: "HEAD",
        headers: { Accept: accept, Authorization: `Bearer ${token}`, "User-Agent": "zakura-runner/1.0" },
        redirect: "follow",
      });
      if (!retry.ok) return null;
      const d2 = retry.headers.get("Docker-Content-Digest");
      return d2 && /^sha256:[0-9a-f]{64}$/.test(d2) ? d2 : null;
    }
    return null;
  } catch (err) {
    log.debug("image.remote_digest_probe_failed", {
      image: `${host}/${repository}:${reference}`,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Docker Hub / OCI anonymous token bootstrap for 401 responses. */
async function fetchAnonymousToken(
  host: string,
  repository: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    let authUrl: string;
    if (host === DOCKER_HUB_REGISTRY) {
      authUrl = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`;
    } else {
      // A Hub mirror serves the same token realm as Hub. For other generic OCI
      // registries the 401 carries a Www-Authenticate realm we don't parse here
      // (private images are rare here) — skip so the upstream fallback tries.
      if (isDockerHubMirror(host)) {
        authUrl = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`;
      } else {
        return null;
      }
    }
    const res = await fetchImpl(authUrl, { headers: { "User-Agent": "zakura-runner/1.0" } });
    if (!res.ok) return null;
    const json = (await res.json()) as { token?: string; access_token?: string };
    return json.token ?? json.access_token ?? null;
  } catch {
    return null;
  }
}

/** Heuristic: a registry host that is a Docker Hub pull-through mirror. */
function isDockerHubMirror(host: string): boolean {
  return host !== DOCKER_HUB_REGISTRY && !host.includes("ghcr.io");
}

/**
 * Compare local and remote digests for one image ref.
 * `updateAvailable` is true only when the remote digest is known and differs
 * from the local one (or the local image is missing).
 * `runningStale` is true when a running container's image id differs from the
 * current tag's image id (image pulled but container not recreated).
 */
export async function checkImageUpdate(
  docker: DockerLike,
  image: string,
  runningImageIds?: Set<string>,
  probeOptions?: ImageUpdateProbeOptions,
): Promise<ImageDigestInfo> {
  const ref = parseImageRef(image);
  const local = await inspectLocalImage(docker, image, probeOptions?.registryMirrors);
  let remoteDigest: string | null = null;
  let error: string | null = null;
  try {
    remoteDigest = await probeRemoteDigest(ref, probeOptions);
    if (remoteDigest === null && local.digest === null) {
      error = "registry_probe_unavailable";
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const updateAvailable =
    remoteDigest !== null &&
    (local.digest === null || local.digest !== remoteDigest);
  // A running container on a different (older) image id than the current tag
  // means the image was refreshed but the container was never recreated.
  const runningStale =
    local.id !== null &&
    runningImageIds !== undefined &&
    runningImageIds.size > 0 &&
    ![...runningImageIds].every((rid) => rid === local.id);
  return {
    image,
    localId: local.id,
    localDigest: local.digest,
    remoteDigest,
    updateAvailable,
    runningStale,
    error,
  };
}

/**
 * Batch-check a set of images. Used by the Runner heartbeat so the Server
 * gets a concise "which images have updates" snapshot per node.
 * `runningImageIds` (when provided) maps each workspace image to the set of
 * image ids of running containers that started from that image ref, so each
 * entry's `runningStale` reflects whether those containers lag the tag.
 * `probeOptions.registryMirrors` is tried first for each Docker Hub image so
 * a host behind a registry mirror can still detect updates.
 */
export async function checkImageUpdates(
  docker: DockerLike,
  images: string[],
  runningImageIds?: Map<string, Set<string>>,
  probeOptions?: ImageUpdateProbeOptions,
): Promise<ImageDigestInfo[]> {
  const out: ImageDigestInfo[] = [];
  for (const image of images) {
    // Look up running ids by the normalized ref so a container reported as
    // `docker.io/...` or `registry-1.docker.io/...` matches a probe for the
    // bare `user/repo:tag`. Callers key the map with normalizeImageRef too.
    const runningIds = runningImageIds?.get(normalizeImageRef(image));
    out.push(await checkImageUpdate(docker, image, runningIds, probeOptions));
  }
  return out;
}
