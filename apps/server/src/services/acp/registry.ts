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
} from "@zakura/shared";
import type { Agent } from "../../db/schema.js";
import type { AgentWorkspaceService } from "../agent-workspace.js";

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

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
  /** Human-readable reason when `dist` is null. */
  unavailable: string | null;
};

export type AcpAdapterStatus = {
  id: string;
  /** Versions currently present in the workspace. */
  installed: string[];
  /** Version the registry pins right now. */
  latest: string | null;
  updateAvailable: boolean;
  /** Kilobytes on disk, per installed version. */
  diskKb: Record<string, number>;
};

/** Workspaces are Linux containers regardless of where the server runs. */
function workspacePlatform(arch = process.arch): AcpRegistryPlatform {
  return acpWorkspacePlatform(arch);
}

export class AcpRegistryService {
  private index: AcpRegistryIndex | null = null;
  private fetchedAt = 0;
  private inFlight: Promise<AcpRegistryIndex | null> | null = null;

  constructor(
    private readonly workspace: AgentWorkspaceService,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

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

  /** Registry entries decorated with the install plan for the workspace platform. */
  async catalog(opts?: { force?: boolean }): Promise<AcpCatalogEntry[]> {
    const index = await this.getIndex(opts);
    if (!index) return [];
    const platform = workspacePlatform();
    return index.agents.map((agent) => this.toCatalogEntry(agent, platform));
  }

  private toCatalogEntry(
    agent: AcpRegistryAgent,
    platform: AcpRegistryPlatform,
  ): AcpCatalogEntry {
    const dist = resolveAcpDistribution(agent, platform);
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
      unavailable: dist ? null : acpDistributionUnavailableReason(agent, platform),
    };
  }

  async findAgent(id: string): Promise<AcpCatalogEntry | null> {
    const index = await this.getIndex();
    const agent = index?.agents.find((a) => a.id === id);
    return agent ? this.toCatalogEntry(agent, workspacePlatform()) : null;
  }

  private planFor(entry: AcpCatalogEntry): AcpProvisionPlan | null {
    const d = entry.dist;
    if (!d) return null;
    switch (d.kind) {
      case "npx": {
        const extra = ACP_COMPANION_PACKAGES[entry.id];
        return extra
          ? { kind: "npx", pkg: d.pkg, version: d.version, extraPackages: extra }
          : { kind: "npx", pkg: d.pkg, version: d.version };
      }
      case "uvx":
        return { kind: "uvx", pkg: d.pkg, version: d.version };
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
  ): Promise<{ command: string; args: string[]; version: string; installed: boolean }> {
    const entry = await this.findAgent(registryId);
    if (!entry) throw new Error(`ACP 注册表里没有 ${registryId}`);
    if (!entry.dist) {
      throw new Error(`${entry.name} 无法安装：${entry.unavailable ?? "没有可用的分发方式"}`);
    }
    const plan = this.planFor(entry);
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
  async status(agent: Agent): Promise<AcpAdapterStatus[]> {
    const [versionsOut, diskOut, index] = await Promise.all([
      this.workspace.execInWorkspace(agent, ["bash", "-lc", acpInstalledVersionsScript()]),
      this.workspace.execInWorkspace(agent, ["bash", "-lc", acpDiskUsageScript()]),
      this.getIndex(),
    ]);

    const byId = new Map<string, AcpAdapterStatus>();
    for (const line of versionsOut.stdout.split("\n")) {
      const [id, version] = line.trim().split("\t");
      if (!id || !version) continue;
      const existing = byId.get(id) ?? {
        id,
        installed: [],
        latest: null,
        updateAvailable: false,
        diskKb: {},
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
