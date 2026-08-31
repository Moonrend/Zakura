/**
 * On-demand provisioning of ACP adapters.
 *
 * ## Where adapters live, and why there
 *
 * `/workspace/.zakura/acp/<agentId>/<version>/`
 *
 * `/workspace` is the bind-mounted host directory, so this survives container
 * recreation. That single property is what fixes the update story: refreshing the
 * workspace image no longer discards installed adapters, and conversely updating an
 * adapter no longer requires touching the image at all. The two lifecycles are
 * finally independent.
 *
 * Versioned directories give idempotent installs (a `.ok` marker means "this exact
 * version is complete"), atomic switching (install beside, then flip), and trivial
 * rollback. They also make disk usage legible and prunable — see `acpGcScript`.
 *
 * ## Space
 *
 * Only adapters the user actually enables get installed, and only one version of
 * each is kept warm. `npm install --prefix` (not `-g`) keeps each adapter's
 * dependency tree inside its own version dir, so removing a version reclaims
 * everything it pulled in. The npm cache is redirected into the workspace too, so
 * it is prunable rather than accumulating invisibly in the image layer.
 */

/** Root for all provisioned adapters, inside the bind-mounted workspace. */
export const ACP_PROVISION_ROOT = "/workspace/.zakura/acp";
/** Shared package-manager caches, kept inside the workspace so they are prunable. */
export const ACP_PROVISION_CACHE = "/workspace/.zakura/cache";

const shq = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;

/** Filesystem-safe segment for an id/version. */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "");
  return cleaned || "unknown";
}

export function acpAgentRoot(agentId: string): string {
  return `${ACP_PROVISION_ROOT}/${safeSegment(agentId)}`;
}

export function acpVersionDir(agentId: string, version: string): string {
  return `${acpAgentRoot(agentId)}/${safeSegment(version)}`;
}

/** Marker written only after a fully successful install. */
export function acpInstallMarker(agentId: string, version: string): string {
  return `${acpVersionDir(agentId, version)}/.ok`;
}

export type AcpProvisionPlan =
  | { kind: "npx"; pkg: string; version: string }
  | { kind: "uvx"; pkg: string; version: string }
  | { kind: "binary"; url: string; sha256: string | null; cmd: string; version: string };

/**
 * Absolute path of the adapter executable once installed.
 *
 * Returned as a path rather than a bare name on purpose: adapters run with `HOME`
 * pointed at a throwaway state dir, so anything an installer appended to a shell
 * rc file is not in effect, and a PATH lookup is unreliable. (This is the same
 * class of bug that made `fx` unusable.)
 */
export function acpProvisionedCommand(agentId: string, plan: AcpProvisionPlan): string {
  const dir = acpVersionDir(agentId, plan.version);
  switch (plan.kind) {
    case "npx":
      // `npm install --prefix <dir>` exposes executables in <dir>/node_modules/.bin,
      // not <dir>/bin (npm's local-install bin dir is always node_modules/.bin).
      return `${dir}/node_modules/.bin/${binNameForPackage(plan.pkg)}`;
    case "uvx":
      return `${dir}/bin/${binNameForPackage(plan.pkg)}`;
    case "binary":
      // `cmd` is relative to the extracted archive root (registry convention).
      return `${dir}/root/${plan.cmd.replace(/^\.\//, "")}`;
  }
}

/** Executable name npm/uv will expose for a package, absent better metadata. */
function binNameForPackage(pkg: string): string {
  const withoutScope = pkg.startsWith("@") ? pkg.slice(pkg.indexOf("/") + 1) : pkg;
  return withoutScope;
}

/**
 * Shell script that installs `plan` if, and only if, it is not already complete.
 *
 * Installs into a `.partial` directory and renames into place, so an interrupted
 * install can never be mistaken for a finished one — the marker and the final path
 * appear together or not at all.
 */
export function acpProvisionScript(
  agentId: string,
  plan: AcpProvisionPlan,
  opts?: { binNameOverride?: string },
): string {
  const dir = acpVersionDir(agentId, plan.version);
  const partial = `${dir}.partial`;
  const marker = `${dir}/.ok`;
  const lines: string[] = [
    "set -eu",
    `if [ -f ${shq(marker)} ]; then exit 0; fi`,
    `rm -rf ${shq(partial)}`,
    `mkdir -p ${shq(partial)} ${shq(ACP_PROVISION_CACHE)}`,
  ];

  if (plan.kind === "npx") {
    const spec = plan.version === "latest" ? plan.pkg : `${plan.pkg}@${plan.version}`;
    lines.push(
      // --prefix keeps the dependency tree inside this version dir, so deleting
      // the dir reclaims everything. --no-fund/--no-audit keep output clean.
      `npm_config_cache=${shq(`${ACP_PROVISION_CACHE}/npm`)} ` +
        `npm install --prefix ${shq(partial)} --no-fund --no-audit --loglevel=error ${shq(spec)} >&2`,
    );
  } else if (plan.kind === "uvx") {
    const spec = plan.version === "latest" ? plan.pkg : `${plan.pkg}==${plan.version}`;
    lines.push(
      `command -v uv >/dev/null 2>&1 || { echo "ZAKURA_ACP_NEED_UV" >&2; exit 127; }`,
      `UV_CACHE_DIR=${shq(`${ACP_PROVISION_CACHE}/uv`)} ` +
        `uv tool install --force --tool-dir ${shq(`${partial}/tools`)} ` +
        `--tool-bin-dir ${shq(`${partial}/bin`)} ${shq(spec)} >&2`,
    );
  } else {
    const archive = `${partial}/archive`;
    lines.push(
      `mkdir -p ${shq(`${partial}/root`)}`,
      `curl -fsSL --max-time 300 -o ${shq(archive)} ${shq(plan.url)}`,
      // Verify before extracting: this is an executable that will run against the
      // user's workspace, so a corrupted or swapped artifact must not be unpacked.
      ...(plan.sha256
        ? [`echo ${shq(`${plan.sha256}  ${archive}`)} | sha256sum -c - >&2`]
        : [
            // Opt-in path: upstream published no digest. Record it in the log so the
            // provenance gap is visible after the fact, not just at the click.
            `echo ${shq(`ZAKURA_ACP_UNVERIFIED:${agentId}:${plan.version}`)} >&2`,
          ]),
      `case ${shq(plan.url)} in`,
      `  *.tar.gz|*.tgz) tar -xzf ${shq(archive)} -C ${shq(`${partial}/root`)} ;;`,
      `  *.tar.bz2|*.tbz2) tar -xjf ${shq(archive)} -C ${shq(`${partial}/root`)} ;;`,
      `  *.zip) unzip -q ${shq(archive)} -d ${shq(`${partial}/root`)} ;;`,
      `  *) cp ${shq(archive)} ${shq(`${partial}/root/${plan.cmd.replace(/^\.\//, "")}`)} ;;`,
      `esac`,
      `rm -f ${shq(archive)}`,
      `find ${shq(`${partial}/root`)} -type f -name ${shq(plan.cmd.replace(/^\.\//, "").split("/").pop() ?? plan.cmd)} -exec chmod +x {} + 2>/dev/null || true`,
    );
  }

  const expectedBin = opts?.binNameOverride
    ? `${dir}/bin/${opts.binNameOverride}`
    : acpProvisionedCommand(agentId, plan);
  const partialBin = expectedBin.replace(dir, partial);
  // npm puts executables in <partial>/node_modules/.bin for npx installs and in
  // <partial>/bin for uvx; the fallback alias scan below must look in the right one.
  const partialBinDir =
    plan.kind === "npx" ? `${partial}/node_modules/.bin` : `${partial}/bin`;

  lines.push(
    // The expected bin name is derived from the package name, but upstream
    // sometimes renames the executable (e.g. qwen-code → qwen), so the file we
    // look for may not exist even though the install succeeded. When the bin dir
    // holds exactly one executable, alias the expected path to it so the launch
    // command stays stable across upstream renames. Otherwise fail here rather
    // than at first launch and name the mismatch.
    `if [ ! -e ${shq(partialBin)} ]; then`,
    `  set -- $(ls -1 ${shq(partialBinDir)} 2>/dev/null || true)`,
    `  if [ $# -eq 1 ] && [ -n "$1" ]; then`,
    `    ln -s "$1" ${shq(partialBin)}`,
    `  else`,
    `    echo ${shq(`ZAKURA_ACP_BIN_NOT_FOUND:${expectedBin}`)} >&2`,
    `    ls -1 ${shq(partialBinDir)} 2>/dev/null >&2 || true`,
    `    rm -rf ${shq(partial)}`,
    `    exit 1`,
    `  fi`,
    `fi`,
    `touch ${shq(`${partial}/.ok`)}`,
    `rm -rf ${shq(dir)}`,
    `mv ${shq(partial)} ${shq(dir)}`,
    `echo ${shq(`ZAKURA_ACP_INSTALLED:${agentId}:${plan.version}`)} >&2`,
  );
  return lines.join("\n");
}

/** Report installed versions per adapter, one `id<TAB>version` line each. */
export function acpInstalledVersionsScript(): string {
  return [
    "set -eu",
    `root=${shq(ACP_PROVISION_ROOT)}`,
    `[ -d "$root" ] || exit 0`,
    `for agent in "$root"/*; do`,
    `  [ -d "$agent" ] || continue`,
    `  for ver in "$agent"/*; do`,
    `    [ -f "$ver/.ok" ] || continue`,
    `    printf '%s\\t%s\\n' "$(basename "$agent")" "$(basename "$ver")"`,
    `  done`,
    `done`,
  ].join("\n");
}

/**
 * Reclaim disk: drop every version of each adapter except the ones named in
 * `keep`, and drop adapters not mentioned at all.
 *
 * Called after a successful install (to remove the version just replaced) and from
 * the maintenance path. Without this, each adapter update would leave its
 * predecessor behind forever — the failure mode the old image-baked design avoided
 * only by never updating in place.
 */
export function acpGcScript(keep: Array<{ id: string; version: string }>): string {
  const keepList = keep
    .map((k) => `${safeSegment(k.id)}/${safeSegment(k.version)}`)
    .join("\n");
  return [
    "set -eu",
    `root=${shq(ACP_PROVISION_ROOT)}`,
    `[ -d "$root" ] || exit 0`,
    `keep=${shq(keepList)}`,
    `for agent in "$root"/*; do`,
    `  [ -d "$agent" ] || continue`,
    `  a=$(basename "$agent")`,
    `  for ver in "$agent"/*; do`,
    `    [ -d "$ver" ] || continue`,
    `    v=$(basename "$ver")`,
    // Also sweep interrupted installs, which are never valid to keep.
    `    case "$v" in *.partial) rm -rf "$ver"; continue ;; esac`,
    `    if ! printf '%s\\n' "$keep" | grep -qxF "$a/$v"; then`,
    `      rm -rf "$ver"`,
    `      echo "ZAKURA_ACP_PRUNED:$a/$v" >&2`,
    `    fi`,
    `  done`,
    `  rmdir "$agent" 2>/dev/null || true`,
    `done`,
  ].join("\n");
}

/** Bytes used per adapter version, for the UI's disk breakdown. */
export function acpDiskUsageScript(): string {
  return [
    "set -eu",
    `root=${shq(ACP_PROVISION_ROOT)}`,
    `[ -d "$root" ] || exit 0`,
    `du -sk "$root"/*/* 2>/dev/null | while read -r kb path; do`,
    `  printf '%s\\t%s\\n' "$kb" "$path"`,
    `done`,
  ].join("\n");
}
