/**
 * ACP Registry client + adapter provisioning.
 *
 * Replaces "every adapter baked into the workspace image" with "catalogue from the
 * upstream registry, install on demand into the workspace". See
 * `packages/shared/src/acp-registry.ts` for why, and `acp-provision.ts` for the
 * on-disk layout.
 */
import { log } from "@zakura/core";
import {
  ACP_REGISTRY_URL,
  acpDistributionUnavailableReason,
  acpDiskUsageScript,
  acpGcScript,
  acpInstalledVersionsScript,
  acpRequiresUnverifiedOptIn,
  acpUninstallScript,
  acpWorkspacePlatform,
  acpProvisionScript,
  acpProvisionedCommand,
  parseAcpRegistryIndex,
  resolveAcpDistribution,
  type AcpProvisionPlan,
  type AcpRegistryAgent,
  type AcpRegistryIndex,
  type AcpRegistryPlatform,
  type AcpResolvedDist,
  acpContainerAgents,
  acpAgentById,
  acpImageAtVersion,
  acpRegistryDigest,
  acpRegistryIsSnapshot,
  acpSnapshotVersion,
  applyAcpRegistryIndex,
} from "@zakura/shared";
import type { Agent } from "../../db/schema.js";
import type { AgentWorkspaceService } from "../agent-workspace.js";
import { readAgentAcpConfig } from "./config.js";

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Compiled index of the curated registry (`Moonrend/acp-registry`).
 *
 * This is a different source from `ACP_REGISTRY_URL`: the upstream index carries
 * provisioning metadata for adapters installed *into* the workspace, while this
 * one pins the container images for adapters that run as their own container.
 * Container adapters ship as a build-time snapshot, so without refreshing this
 * they can never report an available update.
 */
const CURATED_REGISTRY_URL =
  process.env.ZAKURA_ACP_REGISTRY_URL ??
  "https://raw.githubusercontent.com/Moonrend/acp-registry/main/dist/index.json";

/** Companion packages installed alongside certain adapters. `pi-acp` is a thin ACP
 * shim that spawns the separate `pi` coding agent (`@earendil-works/pi-coding-agent`),
 * which is not a dependency of the shim itself, so it has to be installed here. */
const ACP_COMPANION_PACKAGES: Record<string, string[]> = {
  "pi-acp": ["@earendil-works/pi-coding-agent@0.84.4"],
};

export type AcpCatalogEntry = {
  id: string;
  name: string;
  description: string;
  version: string | null;
  repository?: string;
  website?: string;
  license?: string;
  icon?: string;
  /** How it would be installed, or null when unavailable on this platform. */
  dist: AcpResolvedDist | null;
  /**
   * True when the only distribution is a binary with no published sha256, so it
   * installs only under an explicit user opt-in.
   */
  requiresUnverified: boolean;
  /** Human-readable reason when `dist` is null. */
  unavailable: string | null;
};

/**
 * Thrown when an adapter's only distribution is an unverified binary.
 *
 * Separate from a generic Error so the API can answer 409 + a consent prompt
 * instead of a flat failure: the install is possible, it just needs the user to
 * accept that the registry published no sha256 for this platform.
 */
export class AcpUnverifiedBinaryError extends Error {
  readonly requiresUnverified = true;
  constructor(readonly agentName: string) {
    super(`${agentName} 的上游注册表没有提供该平台二进制的 sha256 校验值`);
    this.name = "AcpUnverifiedBinaryError";
  }
}

export type AcpAdapterStatus = {
  id: string;
  /**
   * Profile id this adapter backs, e.g. `claude-code` for registry id
   * `claude-code-acp`.
   *
   * 12 of 42 registry agents have `id !== profileId`. The UI keys everything
   * off the profile, so without this field it looked up status by profile id,
   * missed, and fell back to rendering a workspace-style install button that
   * POSTed to a registry id that does not exist — the "点了没反应" case.
   */
  profileId: string;
  /** Versions currently present in the workspace. */
  installed: string[];
  /** Version the registry pins right now. */
  latest: string | null;
  updateAvailable: boolean;
  /** Kilobytes on disk, per installed version. */
  diskKb: Record<string, number>;
  /**
   * Where this adapter comes from.
   *
   * `container` adapters ship as prebuilt images and are never installed into
   * the workspace, so install state and disk usage do not apply to them.
   */
  source: "workspace" | "container";
  /** Image reference, for container-sourced adapters. */
  image?: string;
  /**
   * Whether the image is actually present on the machine that will run it.
   *
   * Container adapters used to report `installed: [version]` unconditionally,
   * which only ever described *which tag we intend to run* — never whether it
   * had been pulled. So the UI hid the install button while the image was
   * absent, and the failure surfaced at launch as "没镜像". This field is the
   * observed truth; `installed` stays the intended version.
   *
   * `undefined` means the probe could not run (runtime unreachable). Treat that
   * as unknown, never as ready.
   */
  imageReady?: boolean;
  /**
   * Registry version this agent has explicitly adopted, when set.
   *
   * Present only for container adapters. When absent the adapter runs the
   * version baked into this build's snapshot.
   */
  pinnedVersion?: string;
  /**
   * Set when the update state could not be determined (registry or digest probe
   * failed). Distinguishes "no update" from "could not check" so the UI never
   * silently reports an adapter as current.
   */
  checkError?: string;
};

/** Outcome of refreshing the curated container registry. */
export type AcpCuratedRefresh = {
  /** Digest of the index now in effect. */
  digest: string;
  /** True when the fetch failed and a previously loaded index is being reused. */
  stale: boolean;
  /** True when the index in effect is still the build-time snapshot. */
  usingSnapshot: boolean;
  error?: string;
};

/** Workspaces are Linux containers regardless of where the server runs. */
function workspacePlatform(arch = process.arch): AcpRegistryPlatform {
  return acpWorkspacePlatform(arch);
}

export class AcpRegistryService {
  private index: AcpRegistryIndex | null = null;
  private fetchedAt = 0;
  private curatedFetchedAt = 0;
  private inFlight: Promise<AcpRegistryIndex | null> | null = null;
  /**
   * Reports adapter versions currently backing a live session. Injected rather
   * than imported so the registry stays free of a dependency on the session
   * service (which already depends on the registry).
   */
  private inUseVersions: ((agent: Agent) => Array<{ id: string; version: string }>) | null = null;

  constructor(
    private readonly workspace: AgentWorkspaceService,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Wired up at composition time by the ACP session service. */
  setInUseVersionsProvider(
    provider: (agent: Agent) => Array<{ id: string; version: string }>,
  ): void {
    this.inUseVersions = provider;
  }

  /**
   * Registry index, cached for 6h. A fetch failure keeps serving the previous
   * snapshot: the registry being briefly unreachable must not make every adapter
   * vanish from the UI, and it must not read as "no updates available".
   */
  async getIndex(opts?: { force?: boolean }): Promise<AcpRegistryIndex | null> {
    const fresh = Date.now() - this.fetchedAt < REFRESH_INTERVAL_MS;
    if (this.index && fresh && !opts?.force) return this.index;
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      try {
        const res = await this.fetchImpl(ACP_REGISTRY_URL, {
          headers: { Accept: "application/json", "User-Agent": "zakura/1.0" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = parseAcpRegistryIndex(await res.json());
        this.index = parsed;
        this.fetchedAt = Date.now();
        log.info("acp_registry.refreshed", {
          agents: parsed.agents.length,
          version: parsed.version,
        });
        return parsed;
      } catch (err) {
        log.warn("acp_registry.fetch_failed", {
          error: err instanceof Error ? err.message : String(err),
          stale: this.index !== null,
        });
        return this.index;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /**
   * Refresh the curated container registry, cached on the same 6h cycle.
   *
   * Container adapters are pinned by a build-time snapshot, so without this they
   * are structurally incapable of reporting an update. On failure we keep the
   * index already in effect and report `stale`, so the UI can distinguish
   * "checked, nothing new" from "could not check".
   */
  async refreshCuratedIndex(opts?: { force?: boolean }): Promise<AcpCuratedRefresh> {
    const fresh = Date.now() - this.curatedFetchedAt < REFRESH_INTERVAL_MS;
    if (fresh && !opts?.force) {
      return { digest: acpRegistryDigest(), stale: false, usingSnapshot: acpRegistryIsSnapshot() };
    }

    const before = acpRegistryDigest();
    try {
      const res = await this.fetchImpl(CURATED_REGISTRY_URL, {
        headers: { Accept: "application/json", "User-Agent": "zakura/1.0" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // A malformed index is rejected rather than thrown, and leaves the previous
      // one active — treat that as a failed check, not a successful refresh.
      const applied = applyAcpRegistryIndex(await res.json());
      if (!applied.ok) {
        throw new Error(applied.reason ?? "registry index failed validation");
      }
      this.curatedFetchedAt = Date.now();
      if (applied.digest !== before) {
        log.info("acp_curated_registry.updated", {
          from: before,
          to: applied.digest,
        });
      }
      return { digest: applied.digest, stale: false, usingSnapshot: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("acp_curated_registry.fetch_failed", {
        error: message,
        usingSnapshot: acpRegistryIsSnapshot(),
      });
      return {
        digest: acpRegistryDigest(),
        stale: true,
        usingSnapshot: acpRegistryIsSnapshot(),
        error: message,
      };
    }
  }

  /** Registry entries decorated with the install plan for the workspace platform. */
  async catalog(opts?: { force?: boolean; allowUnverifiedBinary?: boolean }): Promise<AcpCatalogEntry[]> {
    const index = await this.getIndex(opts);
    if (!index) return [];
    const platform = workspacePlatform();
    return index.agents.map((agent) => this.toCatalogEntry(agent, platform, opts));
  }

  private toCatalogEntry(
    agent: AcpRegistryAgent,
    platform: AcpRegistryPlatform,
    opts?: { allowUnverifiedBinary?: boolean },
  ): AcpCatalogEntry {
    const allowUnverified = opts?.allowUnverifiedBinary ?? false;
    const dist = resolveAcpDistribution(
      agent,
      platform,
      allowUnverified ? { allowUnverifiedBinary: true } : undefined,
    );
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description ?? "",
      version: agent.version ?? null,
      ...(agent.repository ? { repository: agent.repository } : {}),
      ...(agent.website ? { website: agent.website } : {}),
      ...(agent.license ? { license: agent.license } : {}),
      ...(agent.icon ? { icon: agent.icon } : {}),
      dist,
      // Cursor/Devin/Junie publish no digest. Rather than presenting them as
      // broken, tell the UI an install is possible if the user accepts the
      // missing check, so the refusal becomes a decision instead of a dead end.
      requiresUnverified: acpRequiresUnverifiedOptIn(agent, platform),
      unavailable: dist ? null : acpDistributionUnavailableReason(agent, platform),
    };
  }

  async findAgent(
    id: string,
    opts?: { allowUnverifiedBinary?: boolean },
  ): Promise<AcpCatalogEntry | null> {
    const index = await this.getIndex();
    const agent = index?.agents.find((a) => a.id === id);
    return agent ? this.toCatalogEntry(agent, workspacePlatform(), opts) : null;
  }

  private planFor(entry: AcpCatalogEntry, versionOverride?: string): AcpProvisionPlan | null {
    const d = entry.dist;
    if (!d) return null;
    // An explicit version is how "update" and "switch version" are expressed:
    // only npm/uv can resolve an arbitrary version, since a binary URL is minted
    // per release and the registry gives us no way to rewrite it safely.
    switch (d.kind) {
      case "npx": {
        const extra = ACP_COMPANION_PACKAGES[entry.id];
        const v = versionOverride ?? d.version;
        return extra
          ? { kind: "npx", pkg: d.pkg, version: v, extraPackages: extra }
          : { kind: "npx", pkg: d.pkg, version: v };
      }
      case "uvx":
        return { kind: "uvx", pkg: d.pkg, version: versionOverride ?? d.version };
      case "binary":
        return {
          kind: "binary",
          url: d.url,
          sha256: d.sha256,
          cmd: d.cmd,
          version: d.version,
        };
      case "image":
        return null;
    }
  }

  /**
   * Ensure `registryId` is installed in this agent's workspace, returning the
   * absolute path of its executable.
   *
   * When `useSidecar` is true, the install runs in the ACP sidecar container
   * instead of the workspace. The adapter binaries live on the shared
   * /workspace volume either way.
   */
  async ensureInstalled(
    agent: Agent,
    registryId: string,
    useSidecar = false,
    opts?: { allowUnverifiedBinary?: boolean; version?: string },
  ): Promise<{ command: string; args: string[]; version: string; installed: boolean }> {
    const entry = await this.findAgent(registryId, opts);
    if (!entry) throw new Error(`ACP 注册表里没有 ${registryId}`);

    // Container adapters are "installed" by pulling their image. `planFor`
    // returns null for dist.kind === "image", so without this branch every
    // install request for a containerized agent fell through to the generic
    // "无法安装" error — the click that appeared to do nothing.
    if (entry.dist?.kind === "image") {
      // `dist.kind === "image"` carries no image ref — resolve it from the
      // snapshot, which is the same source the launcher uses.
      const version = opts?.version ?? entry.version ?? acpSnapshotVersion(registryId);
      const image = version ? acpImageAtVersion(registryId, version) : null;
      if (!image || !version) throw new Error(`${entry.name} 没有可用的镜像`);
      const pulled = await this.workspace.ensureAcpAdapterImage(agent, image);
      return {
        command: entry.dist.command,
        args: entry.dist.args ?? [],
        version,
        installed: pulled,
      };
    }

    if (!entry.dist) {
      // Distinguish "cannot" from "will not without consent": the second is
      // recoverable by the caller passing allowUnverifiedBinary.
      if (entry.requiresUnverified) {
        throw new AcpUnverifiedBinaryError(entry.name);
      }
      throw new Error(`${entry.name} 无法安装：${entry.unavailable ?? "没有可用的分发方式"}`);
    }
    const plan = this.planFor(entry, opts?.version);
    if (!plan) throw new Error(`${entry.name} 无法安装`);

    const script = acpProvisionScript(registryId, plan);
    let result;
    if (useSidecar) {
      await this.workspace.ensureAcpSidecar(agent);
      result = await this.workspace.execInSidecar(agent, ["bash", "-lc", script]);
    } else {
      await this.workspace.ensureStarted(agent, { require: "shell" });
      result = await this.workspace.execInWorkspace(agent, ["bash", "-lc", script]);
    }

    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      if (stderr.includes("ZAKURA_ACP_NEED_UV")) {
        throw new Error(
          `${entry.name} 需要 uv（Python 工具链），当前工作区镜像未提供。请更新工作区镜像后重试。`,
        );
      }
      if (stderr.includes("ZAKURA_ACP_BIN_NOT_FOUND")) {
        throw new Error(
          `${entry.name} 安装完成但没找到可执行文件，可能是上游包结构变化：\n${stderr.slice(-800)}`,
        );
      }
      throw new Error(`${entry.name} 安装失败：\n${stderr.slice(-800)}`);
    }

    const installed = result.stderr.includes("ZAKURA_ACP_INSTALLED");
    // Drop the version this run replaced, so an update does not double the footprint.
    if (installed) {
      await this.collectGarbage(agent).catch(() => undefined);
    }

    const args = entry.dist.kind === "binary" ? entry.dist.args : entry.dist.args;
    return {
      command: acpProvisionedCommand(registryId, plan),
      args,
      version: plan.version,
      installed,
    };
  }

  /** Installed versions + disk usage + whether the registry has something newer. */
  async status(agent: Agent, opts?: { force?: boolean }): Promise<AcpAdapterStatus[]> {
    const [versionsOut, diskOut, index, curated] = await Promise.all([
      this.workspace.execInWorkspace(agent, ["bash", "-lc", acpInstalledVersionsScript()]),
      this.workspace.execInWorkspace(agent, ["bash", "-lc", acpDiskUsageScript()]),
      // `force` lets the UI's "check for updates" bypass the 6h index TTL; without
      // it an update published minutes ago stays invisible for hours.
      this.getIndex(opts),
      // Container adapters are pinned by the curated index, not the upstream one,
      // so they need their own refresh or they can never show an update.
      this.refreshCuratedIndex(opts),
    ]);

    // Adapter status is keyed by registry id, but the adopted version lives on
    // the agent's ACP setup, which is keyed by profile id.
    const setups = readAgentAcpConfig(agent).agents ?? {};
    const pinnedByRegistryId = new Map<string, string>();
    for (const containerAgent of acpContainerAgents()) {
      const pin = setups[containerAgent.profileId]?.pinnedVersion;
      if (pin) pinnedByRegistryId.set(containerAgent.id, pin);
    }

    const byId = new Map<string, AcpAdapterStatus>();
    for (const line of versionsOut.stdout.split("\n")) {
      const [id, version] = line.trim().split("\t");
      if (!id || !version) continue;
      const existing = byId.get(id) ?? {
        id,
        profileId: acpAgentById(id)?.profileId ?? id,
        installed: [],
        latest: null,
        updateAvailable: false,
        diskKb: {},
        source: "workspace" as const,
      };
      existing.installed.push(version);
      byId.set(id, existing);
    }

    for (const line of diskOut.stdout.split("\n")) {
      const [kb, path] = line.trim().split("\t");
      if (!kb || !path) continue;
      const parts = path.split("/");
      const version = parts.pop();
      const id = parts.pop();
      if (!id || !version) continue;
      const entry = byId.get(id);
      if (entry) entry.diskKb[version] = Number(kb) || 0;
    }

    for (const entry of byId.values()) {
      const latest = index?.agents.find((a) => a.id === entry.id)?.version ?? null;
      entry.latest = latest;
      // Only claim an update when we actually know the target version; an
      // unreachable registry must not render as "up to date" either way.
      entry.updateAvailable = Boolean(latest && !entry.installed.includes(latest));
      if (!latest) {
        // An adapter that moved to a container is absent from the upstream index
        // by design; that is a leftover workspace install, not a delisting.
        const curatedEntry = acpContainerAgents().find((a) => a.id === entry.id);
        if (curatedEntry) {
          entry.latest = curatedEntry.version;
          entry.updateAvailable = !entry.installed.includes(curatedEntry.version);
        } else {
          entry.checkError = index
            ? "This adapter is no longer listed in the registry."
            : "Could not reach the adapter registry; update state is unknown.";
        }
      }
    }

    // Containerized adapters ship as prebuilt images. They never appear in the
    // workspace scan above, so without this they would render as "not
    // installed" forever and offer an install button that does nothing.
    //
    // Probe the runtime once for every image we are about to report on. Without
    // this, "installed" meant nothing more than "we know a tag", and a missing
    // image only surfaced at launch time.
    const containerImages = acpContainerAgents()
      .filter((a) => !byId.has(a.id))
      .map((a) => {
        const pinned = pinnedByRegistryId.get(a.id);
        const shipped = pinned ?? acpSnapshotVersion(a.id) ?? a.version;
        return acpImageAtVersion(a.id, shipped) ?? a.image;
      })
      .filter((img): img is string => Boolean(img));
    const imagePresence = await this.workspace.acpAdapterImagePresence(
      agent,
      containerImages,
    );
    for (const containerAgent of acpContainerAgents()) {
      if (byId.has(containerAgent.id)) continue;
      // `containerAgent.version` comes from the *active* index, which a refresh
      // may have advanced past the build-time snapshot. Sessions launch the tag
      // in `image`, so the honest "installed" value is whatever this deployment
      // shipped with, and an update is a published tag we have not adopted yet.
      //
      // An adopted pin overrides the shipped version, because that is the tag
      // sessions will actually launch (see acpAdapterSource).
      const pinned = pinnedByRegistryId.get(containerAgent.id);
      const shipped =
        pinned ?? acpSnapshotVersion(containerAgent.id) ?? containerAgent.version;
      const image =
        acpImageAtVersion(containerAgent.id, shipped) ?? containerAgent.image;
      byId.set(containerAgent.id, {
        id: containerAgent.id,
        profileId: containerAgent.profileId,
        installed: [shipped],
        latest: containerAgent.version,
        updateAvailable: shipped !== containerAgent.version,
        diskKb: {},
        source: "container",
        image,
        imageReady: imagePresence.get(image),
        ...(pinned ? { pinnedVersion: pinned } : {}),
        ...(curated.stale
          ? {
              checkError:
                curated.error ??
                "Could not reach the adapter registry; showing the last known version.",
            }
          : {}),
      });
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Prune everything except the registry-pinned version of each installed adapter.
   * Called after an install and from the maintenance path.
   */
  async collectGarbage(agent: Agent): Promise<{ pruned: string[] }> {
    const [statuses, index] = await Promise.all([this.rawInstalled(agent), this.getIndex()]);
    const keep: Array<{ id: string; version: string }> = [];
    for (const [id, versions] of statuses) {
      const pinned = index?.agents.find((a) => a.id === id)?.version;
      // Keep the pinned version when installed, else the newest-looking one, so GC
      // can never leave an adapter with nothing installed.
      const chosen =
        pinned && versions.includes(pinned) ? pinned : [...versions].sort().pop();
      if (chosen) keep.push({ id, version: chosen });
    }
    // An update makes the previous version unpinned, but a running session is
    // still executing from that directory: the adapter CLIs resolve modules at
    // runtime, so pruning it would kill the session with MODULE_NOT_FOUND.
    // Those directories are reclaimed by a later GC, once the session ends.
    for (const inUse of this.inUseVersions?.(agent) ?? []) {
      const known = statuses.get(inUse.id)?.includes(inUse.version) ?? false;
      const already = keep.some((k) => k.id === inUse.id && k.version === inUse.version);
      if (known && !already) keep.push(inUse);
    }
    const out = await this.workspace.execInWorkspace(agent, [
      "bash",
      "-lc",
      acpGcScript(keep),
    ]);
    const pruned = out.stderr
      .split("\n")
      .filter((l) => l.includes("ZAKURA_ACP_PRUNED:"))
      .map((l) => l.split("ZAKURA_ACP_PRUNED:")[1]!.trim());
    if (pruned.length) log.info("acp_registry.pruned", { count: pruned.length });
    return { pruned };
  }

  /**
   * Remove an adapter (or one of its versions) from the workspace.
   *
   * This is not GC with a narrower keep-list: {@link collectGarbage} always keeps a
   * survivor per adapter, so it structurally cannot remove the last version. An
   * explicit uninstall is the only way for the user to reclaim that disk.
   */
  async uninstall(
    agent: Agent,
    registryId: string,
    version?: string,
  ): Promise<{ removed: boolean }> {
    await this.workspace.ensureStarted(agent, { require: "shell" });
    const out = await this.workspace.execInWorkspace(agent, [
      "bash",
      "-lc",
      acpUninstallScript(registryId, version),
    ]);
    if (out.exitCode !== 0) {
      throw new Error(`卸载 ${registryId} 失败：\n${out.stderr.trim().slice(-800)}`);
    }
    const removed = out.stderr.includes("ZAKURA_ACP_REMOVED:");
    log.info("acp_registry.uninstalled", {
      id: registryId,
      version: version ?? "all",
      removed,
    });
    return { removed };
  }

  private async rawInstalled(agent: Agent): Promise<Map<string, string[]>> {
    const out = await this.workspace.execInWorkspace(agent, [
      "bash",
      "-lc",
      acpInstalledVersionsScript(),
    ]);
    const map = new Map<string, string[]>();
    for (const line of out.stdout.split("\n")) {
      const [id, version] = line.trim().split("\t");
      if (!id || !version) continue;
      map.set(id, [...(map.get(id) ?? []), version]);
    }
    return map;
  }
}
