/**
 * Client for the standalone ACP registry (`Moonrend/acp-registry`).
 *
 * Zakura deliberately holds no per-agent knowledge. Everything about an adapter
 * — its image, how its credentials persist, which auth flows it supports —
 * comes from the registry index, so adding an adapter is a pull request against
 * that repo and no change here.
 *
 * The compiled index ships with the app as a build-time snapshot, and can be
 * refreshed at runtime from `ZAKURA_ACP_REGISTRY_URL` for hosts that want
 * updates without redeploying.
 */

import { ACP_REGISTRY_SNAPSHOT } from "./acp-registry-snapshot.js";

/** How an adapter's credentials and config persist between sessions. */
export type AcpStorageMode = "home" | "state-home" | "files" | "none";

/** When a runtime file is copied back to durable storage. */
export type AcpArtifactSync = "none" | "exit" | "codex_auth";

export type AcpSetupMode = "self" | "oauth" | "api_key";

export interface AcpStorageArtifact {
  /** Path relative to the durable root. */
  durable: string;
  /** Path relative to the runtime state dir. */
  runtime: string;
  sync?: AcpArtifactSync;
  /** Restrict this artifact to specific setup modes. Absent means all. */
  when?: AcpSetupMode[];
}

export interface AcpStorageSpec {
  mode: AcpStorageMode;
  /** Extra adapter env. `${STATE_DIR}`/`${RUNTIME_DIR}`/`${HOME_DIR}` expand at launch. */
  env?: Record<string, string>;
  /** Point XDG_CONFIG_HOME / XDG_DATA_HOME at the persisted home. */
  xdg?: boolean;
  artifacts?: AcpStorageArtifact[];
}

export interface AcpAuthSpec {
  modes: AcpSetupMode[];
  apiKeyEnv?: string[];
  /** Env forcing device-code flow instead of opening a browser. */
  noBrowserEnv?: Record<string, string>;
}

export interface AcpIntegrationSpec {
  /** Agent can be pointed at Zakura's own model gateway. */
  zakuraRoute?: boolean;
  /** Prefix prepended to model ids when routed through Zakura. */
  modelPrefix?: string;
  /** ACP session mode id to request on session/new. */
  sessionModeId?: string;
  /** Agent only speaks HTTP MCP; never hand it a stdio gateway. */
  forceHttpMcp?: boolean;
  /** Binary already lives in the image; skip any install step. */
  preinstalled?: boolean;
  /** Human-facing hint shown when setup needs manual action. */
  installHint?: string;
  /** Files written into the adapter home before launch. Values may use ${VAR}. */
  dotenv?: Record<string, string>;
  /** Runtime-only files, keyed by a path relative to the adapter home. */
  runtimeFiles?: Record<string, string>;
}

export interface AcpCuratedAgent {
  id: string;
  name: string;
  version: string;
  /** Stable Zakura-side profile id. */
  profileId: string;
  /** Fully qualified image ref, including tag. */
  image: string;
  dist: { kind: "npx" | "uvx" | "binary" };
  storage: AcpStorageSpec;
  auth: AcpAuthSpec;
  description?: string;
  homepage?: string;
  /**
   * How the host wires this agent up. Ships with the registry so Zakura
   * needs no per-agent code -- adding an agent is a registry-only change.
   */
  integration?: AcpIntegrationSpec;
}

export interface AcpCuratedIndex {
  schemaVersion: number;
  imagePrefix: string;
  digest: string;
  agents: AcpCuratedAgent[];
}

const SNAPSHOT = ACP_REGISTRY_SNAPSHOT;

let active: AcpCuratedIndex = SNAPSHOT;
let byProfile = new Map<string, AcpCuratedAgent>();
let byId = new Map<string, AcpCuratedAgent>();

/** Versions frozen at build time, keyed by agent id. See `acpSnapshotVersion`. */
const SNAPSHOT_VERSIONS = new Map(SNAPSHOT.agents.map((a) => [a.id, a.version]));

/**
 * The container image version baked in at build time.
 *
 * Container adapters launch `image` straight from the active index, so once a
 * refresh lands the newer tag is what sessions pull. Comparing against the
 * snapshot is what lets the UI say "a newer adapter image is published"
 * instead of silently swapping the tag underneath the user.
 */
export function acpSnapshotVersion(id: string): string | undefined {
  return SNAPSHOT_VERSIONS.get(id);
}

function reindex(index: AcpCuratedIndex): void {
  byProfile = new Map(index.agents.map((a) => [a.profileId, a]));
  byId = new Map(index.agents.map((a) => [a.id, a]));
}
reindex(active);

/** Current index, including any successful runtime refresh. */
export const acpRegistryIndex = (): AcpCuratedIndex => active;

export const acpAgentByProfile = (profileId: string): AcpCuratedAgent | undefined =>
  byProfile.get(profileId);

export const acpAgentById = (id: string): AcpCuratedAgent | undefined => byId.get(id);

export const acpAgents = (): AcpCuratedAgent[] => active.agents;

/**
 * Agents the registry publishes container images for.
 *
 * The registry publishes an image for every declaration it carries, so this is
 * currently all of them. It stays a named helper because callers mean
 * "adapters that run as containers", not "everything the index knows".
 */
export const acpContainerAgents = (): AcpCuratedAgent[] => active.agents;

/**
 * Rebuild an image ref at an explicit version.
 *
 * Derived from `imagePrefix` + agent id rather than string-editing the tag off
 * `agent.image`, because an image ref may legitimately contain `:` in a
 * registry host:port. Returns null when the agent is unknown.
 */
export function acpImageAtVersion(id: string, version: string): string | null {
  const agent = byId.get(id);
  if (!agent) return null;
  return `${active.imagePrefix}/${agent.id}:${version}`;
}

function isValidIndex(value: unknown): value is AcpCuratedIndex {
  if (!value || typeof value !== "object") return false;
  const idx = value as Partial<AcpCuratedIndex>;
  if (idx.schemaVersion !== SNAPSHOT.schemaVersion) return false;
  if (!Array.isArray(idx.agents) || idx.agents.length === 0) return false;
  return idx.agents.every(
    (a) =>
      typeof a?.id === "string" &&
      typeof a?.profileId === "string" &&
      typeof a?.image === "string" &&
      typeof a?.storage?.mode === "string",
  );
}

/**
 * Validate and install a freshly fetched index.
 *
 * This module stays free of IO so it can run in the browser as well as on the
 * server; callers do the fetching and hand the parsed value here. A malformed
 * index must never take the adapter layer down, so it is rejected and the
 * previous index stays active.
 */
export function applyAcpRegistryIndex(
  value: unknown,
): { ok: boolean; digest: string; reason?: string } {
  if (!isValidIndex(value)) {
    return { ok: false, digest: active.digest, reason: "index failed validation" };
  }
  active = value;
  reindex(active);
  return { ok: true, digest: active.digest };
}

/** Restore the built-in snapshot. Primarily for tests. */
export function resetAcpRegistry(): void {
  active = SNAPSHOT;
  reindex(active);
}

/** Digest of the index currently in effect. */
export const acpRegistryDigest = (): string => active.digest;

/** True when the active index is still the build-time snapshot. */
export const acpRegistryIsSnapshot = (): boolean => active === SNAPSHOT;

/** Digest of the build-time snapshot, for reporting drift against the live index. */
export const acpSnapshotDigest = (): string => SNAPSHOT.digest;
