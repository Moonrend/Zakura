/**
 * Image update detection: compare the local image digest against the registry
 * digest to decide whether a newer image is available.
 *
 * The probe is **read-only**. It issues a HEAD (falling back to GET) against the
 * v2 manifest API and reads `Docker-Content-Digest`; it never pulls. That matters
 * more than it sounds: an earlier version fell back to `docker pull` whenever the
 * manifest probe failed, which meant the "check" mutated the host — the pull
 * installed the new image, so the *next* check reported "up to date" even though
 * no container had been recreated. The update silently consumed itself, and every
 * 10-minute background sweep could pull multi-GB images on every node. Pulling is
 * now opt-in per call (`allowPullFallback`) and never enabled for a background sweep.
 *
 * Shared between the server (in-process probe against local Docker) and the
 * runner (probe on the runner host). Uses a minimal structural interface rather
 * than dockerode's types so this module stays dependency-free.
 */
import { log } from "./observability/index.js";

export type ImageRef = {
  /**
   * Registry host **including port** when one was given, e.g.
   * "registry-1.docker.io", "ghcr.io", "localhost:5000", "harbor.corp:8443".
   */
  registry: string;
  /** Repository (namespace/name), e.g. "sunwuyuan/zakura-workspace-dev". */
  repository: string;
  /** Tag or digest; defaults to "latest" when absent. */
  reference: string;
  /** True when reference is already a digest (sha256:...). */
  isDigest: boolean;
};

export type ImageUpdateProbeOptions = {
  /**
   * Docker Hub pull-through mirrors from the daemon config. A host behind a
   * corporate proxy or a regional mirror can reach the mirror but not
   * registry-1.docker.io, so probing upstream only would always time out. Each
   * mirror is tried first, upstream last, so a broken mirror can never mask a
   * real update.
   */
  registryMirrors?: string[];
  /** Proxy-aware fetch (the runner strips HTTP(S)_PROXY from its own env). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Without one, a blackholed registry stalls the sweep. */
  timeoutMs?: number;
  /**
   * Allow `docker pull` as a last-resort digest source when the manifest probe
   * fails. Off by default: it mutates the host and makes the reported update
   * disappear on the next check. Only enable for an explicit, user-initiated check.
   */
  allowPullFallback?: boolean;
};

const DOCKER_HUB_REGISTRY = "registry-1.docker.io";
const DOCKER_HUB_OFFICIAL = "library";
const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = "zakura/1.0";

/** Registry hosts reached over plain HTTP: loopback and explicitly-marked local names. */
function isInsecureRegistryHost(host: string): boolean {
  const name = host.split(":")[0] ?? "";
  return (
    name === "localhost" ||
    name === "127.0.0.1" ||
    name === "::1" ||
    name.endsWith(".local") ||
    name.endsWith(".localhost")
  );
}

function registryBaseUrl(host: string): string {
  return `${isInsecureRegistryHost(host) ? "http" : "https"}://${host}`;
}

/** A leading component is a registry when it has a dot, a port, or is localhost. */
function looksLikeRegistry(head: string): boolean {
  if (!head) return false;
  if (!/^[A-Za-z0-9._-]+(:\d+)?$/.test(head)) return false;
  return head.includes(".") || head.includes(":") || head === "localhost";
}

/**
 * Parse a docker image reference into registry / repository / reference,
 * following Docker's own rules.
 *
 * The registry's **port is preserved**. Dropping it (an earlier bug) meant
 * `localhost:5000/app:v1` was probed at `https://localhost/v2/...`, which always
 * failed — so every private or insecure registry with an explicit port fell
 * through to the pull fallback.
 */
export function parseImageRef(image: string): ImageRef {
  const raw = image.trim();
  if (!raw) throw new Error("empty image reference");

  // digest form: [registry/]repo@sha256:...
  const atIdx = raw.indexOf("@");
  if (atIdx >= 0) {
    const digest = raw.slice(atIdx + 1);
    const [registry, repository] = splitRegistryRepo(raw.slice(0, atIdx));
    return { registry, repository, reference: digest, isDigest: true };
  }

  const [registry, repoPath] = splitRegistryRepo(raw);

  // Tags never contain '/', so the tag separator is the last ':' after the last '/'.
  const lastSlash = repoPath.lastIndexOf("/");
  const lastColon = repoPath.lastIndexOf(":");
  let reference = "latest";
  let repository = repoPath;
  if (lastColon > lastSlash && lastColon >= 0) {
    reference = repoPath.slice(lastColon + 1) || "latest";
    repository = repoPath.slice(0, lastColon);
  }
  if (registry === DOCKER_HUB_REGISTRY && !repository.includes("/")) {
    repository = `${DOCKER_HUB_OFFICIAL}/${repository}`;
  }
  return { registry, repository, reference, isDigest: false };
}

/** Split "[registry/]rest" keeping any registry port intact. */
function splitRegistryRepo(s: string): [registry: string, rest: string] {
  const slashIdx = s.indexOf("/");
  if (slashIdx > 0) {
    const head = s.slice(0, slashIdx);
    if (looksLikeRegistry(head)) return [head, s.slice(slashIdx + 1)];
  }
  const repo = s.includes("/") ? s : `${DOCKER_HUB_OFFICIAL}/${s}`;
  return [DOCKER_HUB_REGISTRY, repo];
}

/**
 * Canonical hostname for Docker Hub. Docker reports container `Image` refs as
 * `docker.io/...`, `registry-1.docker.io/...` or bare, so normalizing lets
 * callers match running containers against the refs we probe.
 */
function canonicalRegistry(registry: string): string {
  return registry === "docker.io" || registry === "index.docker.io"
    ? DOCKER_HUB_REGISTRY
    : registry;
}

/** Canonical comparison key: `<canonical-registry>/<repo>:<ref>`. */
export function normalizeImageRef(image: string): string {
  const { registry, repository, reference } = parseImageRef(image);
  return `${canonicalRegistry(registry)}/${repository}:${reference}`;
}

/** True when two refs name the same repository, ignoring tag and Hub aliases. */
export function sameImageRepository(a: string, b: string): boolean {
  try {
    const x = parseImageRef(a);
    const y = parseImageRef(b);
    return (
      canonicalRegistry(x.registry) === canonicalRegistry(y.registry) &&
      x.repository === y.repository
    );
  } catch {
    return false;
  }
}

export type ImageDigestInfo = {
  image: string;
  localId: string | null;
  localDigest: string | null;
  remoteDigest: string | null;
  updateAvailable: boolean;
  runningStale: boolean;
  error: string | null;
};

export interface ImageInspectLike {
  Id: string | null;
  RepoDigests?: string[];
}
export interface DockerLike {
  getImage(image: string): { inspect(): Promise<ImageInspectLike> };
  info?(): Promise<DockerInfoLike>;
  /**
   * Ask the daemon to pull `image` and return the resulting RepoDigest. The
   * daemon honors its own mirrors, proxies and credentials — paths an in-process
   * fetch cannot see. Only invoked when `allowPullFallback` is set, because it
   * changes host state.
   */
  pullToDigest?(image: string): Promise<string | null>;
}
export interface DockerInfoLike {
  RegistryConfig?: {
    Mirrors?: string[];
    IndexConfigs?: Record<string, { Mirrors?: string[]; Name?: string; Secure?: boolean }>;
  };
  /** Some daemon versions surface mirrors at the top level instead. */
  Mirrors?: string[];
}

// —— registry mirror discovery ——

let mirrorCache: string[] | null = null;
let mirrorInFlight: Promise<string[]> | null = null;

/** Reset the mirror cache (test-only). */
export function _resetMirrorCacheForTests(): void {
  mirrorCache = null;
  mirrorInFlight = null;
}

/**
 * Discover the daemon's configured Docker Hub mirrors by asking the daemon over
 * the socket. That is the only reliable source from inside a container: the
 * host's `/etc/docker/daemon.json` is not mounted, so the old filesystem
 * fallback could never match anything and has been dropped.
 *
 * Only a **successful, non-empty** result is cached. Caching a failure (which the
 * previous version did, since `[]` is truthy) meant one transient error while the
 * daemon was still starting permanently disabled mirror probing for the process
 * lifetime — on a mirror-only host that silently broke update detection until
 * restart. Concurrent callers share one in-flight query.
 */
export async function discoverDockerRegistryMirrors(docker?: DockerLike): Promise<string[]> {
  if (mirrorCache) return mirrorCache;
  if (mirrorInFlight) return mirrorInFlight;
  if (!docker?.info) return [];

  mirrorInFlight = (async () => {
    const hosts = new Set<string>();
    try {
      const info = await docker.info!();
      for (const m of [...(info.RegistryConfig?.Mirrors ?? []), ...(info.Mirrors ?? [])]) {
        if (typeof m === "string" && m.trim()) hosts.add(m.trim());
      }
      // IndexConfigs is the older per-index map form.
      for (const v of Object.values(info.RegistryConfig?.IndexConfigs ?? {})) {
        for (const m of v?.Mirrors ?? []) {
          if (typeof m === "string" && m.trim()) hosts.add(m.trim());
        }
      }
    } catch (err) {
      // Do not cache: the daemon may simply not be up yet. Log it — a silent
      // failure here is the single hardest-to-diagnose mode of this feature.
      log.warn("image.mirror_discovery_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
    const resolved = [...hosts]
      .map(stripScheme)
      .filter((h) => h && h !== DOCKER_HUB_REGISTRY && h !== "docker.io");
    if (resolved.length > 0) {
      mirrorCache = resolved;
      log.info("image.mirrors_discovered", { mirrors: resolved.join(",") });
    }
    return resolved;
  })();

  try {
    return await mirrorInFlight;
  } finally {
    mirrorInFlight = null;
  }
}

function stripScheme(host: string): string {
  return host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

// —— local inspect ——

/**
 * Inspect a local image and extract its id plus the RepoDigest **for this
 * repository**.
 *
 * Picking `RepoDigests[0]` blindly (the previous behaviour) returns a digest
 * from an unrelated repo whenever the image is tagged more than once — e.g.
 * present under both `docker.io/x` and a mirror prefix — which then never
 * matches the remote digest and reports a permanent phantom update.
 */
async function inspectLocalImage(
  docker: DockerLike,
  image: string,
  mirrors?: string[],
): Promise<{ id: string | null; digest: string | null }> {
  const ref = parseImageRef(image);
  const candidates = [image];
  // A host that pulled through a mirror may have the image tagged with the
  // mirror prefix, in which case the bare ref does not resolve.
  if (mirrors && canonicalRegistry(ref.registry) === DOCKER_HUB_REGISTRY) {
    for (const m of mirrors) candidates.push(`${m}/${ref.repository}:${ref.reference}`);
  }

  for (const candidate of candidates) {
    let info: ImageInspectLike;
    try {
      info = await docker.getImage(candidate).inspect();
    } catch {
      continue;
    }
    return { id: info.Id ?? null, digest: pickRepoDigest(info.RepoDigests ?? [], ref) };
  }
  return { id: null, digest: null };
}

/**
 * Choose the RepoDigest that actually belongs to `ref`.
 *
 * Preference order matters: an image pulled through a mirror carries *both*
 * `mirror.host/acme/app@sha256:…` and `acme/app@sha256:…`, and only the one whose
 * registry matches the ref we probed is comparable to the digest the registry
 * reports. Matching on repository alone would pick whichever came first.
 */
function pickRepoDigest(repoDigests: string[], ref: ImageRef): string | null {
  const parsed: Array<{ digest: string; registry: string; repository: string }> = [];
  for (const entry of repoDigests) {
    const at = entry.lastIndexOf("@");
    if (at < 0) continue;
    const digest = entry.slice(at + 1);
    if (!digest) continue;
    try {
      const p = parseImageRef(entry.slice(0, at));
      parsed.push({ digest, registry: canonicalRegistry(p.registry), repository: p.repository });
    } catch {
      /* unparseable entry — ignore */
    }
  }
  if (parsed.length === 0) return null;

  const wantRegistry = canonicalRegistry(ref.registry);
  return (
    parsed.find((p) => p.registry === wantRegistry && p.repository === ref.repository)?.digest ??
    parsed.find((p) => p.repository === ref.repository)?.digest ??
    parsed[0]!.digest
  );
}

// —— remote probe ——

async function probeRemoteDigest(
  ref: ImageRef,
  opts?: ImageUpdateProbeOptions,
): Promise<string | null> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Mirrors are Hub pull-through caches; they are meaningless for ghcr.io or a
  // private registry, so only Hub images consult them.
  const mirrors =
    canonicalRegistry(ref.registry) === DOCKER_HUB_REGISTRY
      ? (opts?.registryMirrors ?? [])
      : [];
  for (const host of [...mirrors, ref.registry]) {
    const digest = await probeDigestOnHost(ref, host, fetchImpl, timeoutMs);
    if (digest) return digest;
  }
  return null;
}

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

async function probeDigestOnHost(
  ref: ImageRef,
  host: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string | null> {
  const { repository, reference } = ref;
  const encodedRepo = repository
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const refPath = `/v2/${encodedRepo}/manifests/${
    ref.isDigest ? reference : encodeURIComponent(reference)
  }`;
  const url = `${registryBaseUrl(host)}${refPath}`;

  const request = async (method: "HEAD" | "GET", token?: string): Promise<Response | null> => {
    try {
      return await fetchImpl(url, {
        method,
        headers: {
          Accept: MANIFEST_ACCEPT,
          "User-Agent": USER_AGENT,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      log.debug("image.remote_digest_probe_failed", {
        image: `${host}/${repository}:${reference}`,
        method,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  let res = await request("HEAD");
  if (!res) return null;

  let token: string | undefined;
  if (res.status === 401) {
    const challenge = res.headers.get("WWW-Authenticate") ?? res.headers.get("Www-Authenticate");
    const got = await fetchRegistryToken(challenge, host, repository, fetchImpl, timeoutMs);
    if (!got) return null;
    token = got;
    res = await request("HEAD", token);
    if (!res) return null;
  }
  if (!res.ok) return null;

  const head = res.headers.get("Docker-Content-Digest");
  if (head && DIGEST_RE.test(head)) return head;

  // Some caching proxies and pull-through mirrors answer 200 to HEAD without the
  // digest header. Fall back to GET, which lets us read the header (or compute
  // the digest from the body, which is exactly what the header would contain).
  const got = await request("GET", token);
  if (!got || !got.ok) return null;
  const viaGet = got.headers.get("Docker-Content-Digest");
  if (viaGet && DIGEST_RE.test(viaGet)) return viaGet;
  try {
    const body = new Uint8Array(await got.arrayBuffer());
    const { createHash } = await import("node:crypto");
    return `sha256:${createHash("sha256").update(body).digest("hex")}`;
  } catch {
    return null;
  }
}

/**
 * Obtain a bearer token for a 401'd registry by honoring the `WWW-Authenticate`
 * challenge, which carries the realm/service/scope to use.
 *
 * The previous implementation guessed instead: any host that was not ghcr.io was
 * assumed to be a Docker Hub mirror and handed a Hub token for a repository that
 * does not exist on Hub. That wasted a round trip against quay.io, ECR, Harbor
 * and GitLab, and it discarded the very header that says what to do.
 */
async function fetchRegistryToken(
  challenge: string | null,
  host: string,
  repository: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string | null> {
  let realm: string | null = null;
  let service: string | null = null;
  let scope: string | null = null;

  if (challenge && /^\s*bearer/i.test(challenge)) {
    realm = matchAuthParam(challenge, "realm");
    service = matchAuthParam(challenge, "service");
    scope = matchAuthParam(challenge, "scope");
  }
  if (!realm && canonicalRegistry(host) === DOCKER_HUB_REGISTRY) {
    // Hub always uses this realm; keep it as a fallback for mirrors that 401
    // without a challenge header.
    realm = "https://auth.docker.io/token";
    service = "registry.docker.io";
  }
  if (!realm) return null;

  const url = new URL(realm);
  if (service) url.searchParams.set("service", service);
  url.searchParams.set("scope", scope ?? `repository:${repository}:pull`);

  try {
    const res = await fetchImpl(url.toString(), {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { token?: string; access_token?: string };
    return json.token ?? json.access_token ?? null;
  } catch {
    return null;
  }
}

function matchAuthParam(challenge: string, key: string): string | null {
  const m = new RegExp(`${key}="([^"]+)"`, "i").exec(challenge);
  return m?.[1] ?? null;
}

// —— comparison ——

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
    if (remoteDigest === null && probeOptions?.allowPullFallback && docker.pullToDigest) {
      remoteDigest = await docker.pullToDigest(image);
    }
    if (remoteDigest === null) {
      // Report the failure even when a local digest exists. Otherwise a failed
      // probe is indistinguishable from "you are up to date".
      error = "registry_probe_unavailable";
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const updateAvailable =
    remoteDigest !== null && (local.digest === null || local.digest !== remoteDigest);
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

/** Bounded-concurrency map so one slow registry cannot serialize the whole sweep. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function checkImageUpdates(
  docker: DockerLike,
  images: string[],
  runningImageIds?: Map<string, Set<string>>,
  probeOptions?: ImageUpdateProbeOptions,
): Promise<ImageDigestInfo[]> {
  return mapWithConcurrency(images, 4, (image) =>
    // Look up running ids by normalized ref so a container reported as
    // `docker.io/...` matches a probe for the bare `user/repo:tag`.
    checkImageUpdate(docker, image, runningImageIds?.get(normalizeImageRef(image)), probeOptions),
  );
}

/**
 * Group running containers by the normalized ref of the image they were started
 * from. Shared so the runner and the server cannot drift (they previously had
 * near-identical copies, one of which forgot to skip empty image ids and so
 * inserted `""` into the set, making `runningStale` spuriously true).
 */
export function groupRunningImageIds(
  containers: Array<{ Image?: string | null; ImageID?: string | null }>,
): Map<string, Set<string>> {
  const byRef = new Map<string, Set<string>>();
  for (const c of containers) {
    const image = c.Image?.trim();
    const imageId = c.ImageID?.trim();
    if (!image || !imageId) continue;
    let key: string;
    try {
      key = normalizeImageRef(image);
    } catch {
      continue;
    }
    const set = byRef.get(key) ?? new Set<string>();
    set.add(imageId);
    byRef.set(key, set);
  }
  return byRef;
}
