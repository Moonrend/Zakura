/**
 * ACP Registry: the catalogue of installable ACP agents.
 *
 * ## Why this exists
 *
 * The original design baked every supported adapter into the workspace image with
 * one `npm install -g` + `pip install` + `curl | bash` layer, and hardcoded a
 * matching profile in `builtinAcpProfiles()`. That has four structural problems:
 *
 * 1. **Size.** Every user carries every adapter, whether they use one or none.
 * 2. **Update cost.** Bumping a single adapter means rebuilding and re-pulling a
 *    multi-GB image, because it is all one layer.
 * 3. **Coverage.** Adding an agent needs a code change plus an image release, so
 *    the supported set (10) lagged far behind what exists (~39 in the registry).
 * 4. **Drift.** Nothing was version-pinned, and the build swallowed
 *    `--version` failures, so what shipped was "whatever npm served that day".
 *
 * The upstream ACP Registry solves the catalogue half: it is a curated,
 * machine-readable index with pinned versions and per-platform distribution
 * metadata, refreshed hourly. We consume it as data, so a new agent needs no code
 * change. The install half is handled by provisioning adapters on demand into a
 * versioned directory under the agent's own workspace — see `acp-provision.ts`.
 *
 * Registry index: https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
 * Format:         https://github.com/agentclientprotocol/registry/blob/main/FORMAT.md
 */

export const ACP_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

/** Platform identifiers used by the registry's `binary` distribution. */
export type AcpRegistryPlatform =
  | "darwin-aarch64"
  | "darwin-x86_64"
  | "linux-aarch64"
  | "linux-x86_64"
  | "windows-aarch64"
  | "windows-x86_64";

export type AcpBinaryDist = {
  archive: string;
  /** SHA-256 of the archive. Optional upstream; we refuse to install without it. */
  sha256?: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
};

export type AcpRegistryDistribution = {
  npx?: { package: string; args?: string[] };
  uvx?: { package: string; args?: string[] };
  binary?: Partial<Record<AcpRegistryPlatform, AcpBinaryDist>>;
};

export type AcpRegistryAgent = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  repository?: string;
  website?: string;
  authors?: string[];
  license?: string;
  icon?: string;
  distribution?: AcpRegistryDistribution;
};

export type AcpRegistryIndex = {
  version: string;
  agents: AcpRegistryAgent[];
  extensions?: unknown[];
};

/** How an adapter will be obtained. `image` = already present (legacy/pre-baked). */
export type AcpDistKind = "npx" | "uvx" | "binary" | "image";

export type AcpResolvedDist =
  | { kind: "npx"; pkg: string; version: string; args: string[] }
  | { kind: "uvx"; pkg: string; version: string; args: string[] }
  | {
      kind: "binary";
      url: string;
      /** null when upstream published no digest and the caller opted in anyway. */
      sha256: string | null;
      cmd: string;
      args: string[];
      env: Record<string, string>;
      version: string;
    }
  | { kind: "image"; command: string; args: string[] };

/**
 * Platform id in registry terms. Explicit args (no `process` default) because this
 * package is also consumed by the browser bundle.
 */
export function acpPlatformTarget(
  arch: string,
  platform: string,
): AcpRegistryPlatform {
  const cpu = arch === "arm64" || arch === "aarch64" ? "aarch64" : "x86_64";
  const os = platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : "linux";
  return `${os}-${cpu}` as AcpRegistryPlatform;
}

/** Workspace containers are Linux; only the CPU varies with the host. */
export function acpWorkspacePlatform(arch: string): AcpRegistryPlatform {
  return acpPlatformTarget(arch, "linux");
}

function splitPackageVersion(spec: string): { pkg: string; version: string } {
  // `@scope/name@1.2.3` → name keeps its leading @, version is after the LAST @
  const at = spec.lastIndexOf("@");
  if (at > 0) return { pkg: spec.slice(0, at), version: spec.slice(at + 1) };
  return { pkg: spec, version: "latest" };
}

export function isValidSha256(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}

export type AcpDistributionOptions = {
  /**
   * Accept a binary the registry published without a `sha256`.
   *
   * Off by default: we are downloading an executable that will run with the user's
   * workspace mounted, and "the registry said so" is not sufficient provenance on
   * its own. About a quarter of current entries (Cursor, Devin, Junie, …) ship no
   * digest, so rather than making them permanently unavailable this is exposed as
   * an explicit per-install choice, and the resolved dist records that it is
   * unverified so the UI can say so.
   */
  allowUnverifiedBinary?: boolean;
};

/**
 * Pick the distribution to use for `agent` on `platform`.
 *
 * Order is deliberate: a digest-verified binary is preferred (single artifact,
 * integrity checked, no package-manager resolution at install time), then npx,
 * then uvx. An unverified binary is only considered when nothing else works *and*
 * the caller opted in — never ahead of a package manager.
 */
export function resolveAcpDistribution(
  agent: AcpRegistryAgent,
  platform: AcpRegistryPlatform,
  opts?: AcpDistributionOptions,
): AcpResolvedDist | null {
  const dist = agent.distribution;
  if (!dist) return null;

  const bin = dist.binary?.[platform];
  if (bin?.archive && isValidSha256(bin.sha256)) {
    return {
      kind: "binary",
      url: bin.archive,
      sha256: bin.sha256.toLowerCase(),
      cmd: bin.cmd,
      args: bin.args ?? [],
      env: bin.env ?? {},
      version: agent.version ?? "unknown",
    };
  }

  if (dist.npx?.package) {
    const { pkg, version } = splitPackageVersion(dist.npx.package);
    return { kind: "npx", pkg, version, args: dist.npx.args ?? [] };
  }

  if (dist.uvx?.package) {
    const { pkg, version } = splitPackageVersion(dist.uvx.package);
    return { kind: "uvx", pkg, version, args: dist.uvx.args ?? [] };
  }

  // Last resort, and only on explicit opt-in.
  if (bin?.archive && opts?.allowUnverifiedBinary) {
    return {
      kind: "binary",
      url: bin.archive,
      sha256: null,
      cmd: bin.cmd,
      args: bin.args ?? [],
      env: bin.env ?? {},
      version: agent.version ?? "unknown",
    };
  }

  return null;
}

/** True when this agent can only be installed without a digest check. */
export function acpRequiresUnverifiedOptIn(
  agent: AcpRegistryAgent,
  platform: AcpRegistryPlatform,
): boolean {
  if (resolveAcpDistribution(agent, platform)) return false;
  return resolveAcpDistribution(agent, platform, { allowUnverifiedBinary: true }) !== null;
}

/** Reason an agent from the index cannot be offered, for surfacing in the UI. */
export function acpDistributionUnavailableReason(
  agent: AcpRegistryAgent,
  platform: AcpRegistryPlatform,
): string | null {
  if (resolveAcpDistribution(agent, platform)) return null;
  const dist = agent.distribution;
  if (!dist || Object.keys(dist).length === 0) return "注册表未提供安装方式";
  const bin = dist.binary?.[platform];
  if (bin && !isValidSha256(bin.sha256)) {
    return "注册表缺少该平台二进制的 sha256，出于校验要求不予安装";
  }
  if (dist.binary && !bin) return `注册表未提供 ${platform} 的二进制`;
  return "没有可用的安装方式";
}

export function parseAcpRegistryIndex(raw: unknown): AcpRegistryIndex {
  if (!raw || typeof raw !== "object") throw new Error("ACP 注册表响应不是对象");
  const obj = raw as { version?: unknown; agents?: unknown };
  if (!Array.isArray(obj.agents)) throw new Error("ACP 注册表缺少 agents 数组");
  const agents: AcpRegistryAgent[] = [];
  for (const entry of obj.agents) {
    if (!entry || typeof entry !== "object") continue;
    const a = entry as AcpRegistryAgent;
    // id/name are the minimum needed to render and address an entry.
    if (typeof a.id !== "string" || !a.id) continue;
    if (typeof a.name !== "string" || !a.name) continue;
    agents.push(a);
  }
  return {
    version: typeof obj.version === "string" ? obj.version : "unknown",
    agents,
  };
}
