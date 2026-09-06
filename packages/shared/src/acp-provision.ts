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
/** Name of the sibling staging dir `zk_rm` renames into; swept by `acpGcScript`. */
export const ACP_TRASH_DIRNAME = ".trash";

const shq = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;

/**
 * Shell helper `zk_rm` - a `rm -rf` that actually finishes on a bind mount.
 *
 * Plain `rm -rf` fails with "Directory not empty" on the workspace bind mount:
 * rm walks a directory, unlinks what it saw, then rmdir's it — but on overlay/
 * fuse-backed mounts entries can still be materialising (npm writes thousands of
 * files across nested dep trees, and deletion is not atomic with the walk), so
 * the rmdir races and aborts the whole install. That is exactly the pi-acp
 * failure: dozens of "cannot remove .../dist/... Directory not empty" lines.
 *
 * Two defences, in order:
 *  1. Rename the tree out of the way first. Rename is atomic and cheap, so the
 *     caller's path is free immediately even if the bytes linger. If the rename
 *     succeeds we can delete lazily and a residual failure is harmless.
 *  2. Retry the recursive delete a few times; races are transient by nature.
 *
 * Deliberately never fails the script: a leftover trash dir costs disk, while a
 * failed delete would cost the user their install. `acpGcScript` sweeps trash.
 *
 * The staging dir is a sibling of the target rather than one fixed absolute path:
 * rename is only atomic within a filesystem, so a cross-device trash would silently
 * degrade into a full copy. A sibling is always on the same mount.
 */
export function acpRmHelper(): string[] {
  return [
    `zk_rm() {`,
    `  [ -e "$1" ] || return 0`,
    `  trash="$(dirname "$1")/${ACP_TRASH_DIRNAME}"`,
    `  mkdir -p "$trash" 2>/dev/null || true`,
    `  tmp="$trash/$(basename "$1").$$.$(date +%s 2>/dev/null || echo 0)"`,
    `  if mv "$1" "$tmp" 2>/dev/null; then`,
    `    for _ in 1 2 3; do rm -rf "$tmp" 2>/dev/null && break; done`,
    `    return 0`,
    `  fi`,
    `  for _ in 1 2 3; do`,
    `    rm -rf "$1" 2>/dev/null && return 0`,
    `  done`,
    `  return 0`,
    `}`,
  ];
}

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
  | { kind: "npx"; pkg: string; version: string; extraPackages?: string[] }
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
    ...acpRmHelper(),
    `zk_rm ${shq(partial)}`,
    `mkdir -p ${shq(partial)} ${shq(ACP_PROVISION_CACHE)}`,
  ];

  if (plan.kind === "npx") {
    const spec = plan.version === "latest" ? plan.pkg : `${plan.pkg}@${plan.version}`;
    // Companion packages (e.g. pi-acp shells out to the separate `pi` CLI that is
    // not a dependency of the adapter) must be installed in the SAME invocation:
    // a second `npm install --prefix` without a package.json would prune the first.
    const specs = [spec, ...(plan.extraPackages ?? [])].map((p) => shq(p)).join(" ");
    const npmEnv = `npm_config_cache=${shq(`${ACP_PROVISION_CACHE}/npm`)}`;
    // --prefix keeps the dependency tree inside this version dir, so deleting
    // the dir reclaims everything. --no-fund/--no-audit keep output clean.
    const npmInstall = (s: string) =>
      `${npmEnv} npm install --prefix ${shq(partial)} --no-fund --no-audit --loglevel=error ${s} >&2`;
    if (plan.version === "latest") {
      lines.push(npmInstall(specs));
    } else {
      // The upstream registry pins a version that npm may not actually serve:
      // grok-cli is published as @xai-official/grok but the index still points at
      // 1.0.18, which was never on the registry, so npm exits ETARGET and the
      // agent is simply uninstallable. The pin is a hint about what upstream
      // tested, not a security control (integrity for npm comes from the
      // lockfile-free registry itself; binaries are the sha256-gated path), so a
      // missing pin should degrade to the latest published version rather than
      // dead-end the user. Anything other than a version-resolution failure still
      // aborts, and the substitution is announced so the UI can show what it got.
      const fallbackSpecs = [plan.pkg, ...(plan.extraPackages ?? [])]
        .map((p) => shq(p))
        .join(" ");
      lines.push(
        `if ! ${npmInstall(specs)} 2>${shq(`${partial}.npm-err`)}; then`,
        `  cat ${shq(`${partial}.npm-err`)} >&2`,
        `  if grep -qE 'ETARGET|No matching version|is not in this registry' ${shq(`${partial}.npm-err`)}; then`,
        `    rm -f ${shq(`${partial}.npm-err`)}`,
        `    echo ${shq(`ZAKURA_ACP_VERSION_FALLBACK:${agentId}:${plan.version}`)} >&2`,
        `    ${npmInstall(fallbackSpecs)}`,
        `  else`,
        `    rm -f ${shq(`${partial}.npm-err`)}`,
        `    exit 1`,
        `  fi`,
        `fi`,
        `rm -f ${shq(`${partial}.npm-err`)}`,
      );
    }
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
    // sometimes renames the executable (e.g. qwen-code -> qwen), so the file we
    // look for may not exist even though the install succeeded. For npm installs
    // we read the package's own `bin` field to find the real name; globbing
    // node_modules/.bin is unreliable because transitive deps (e.g. node-gyp-build
    // or semver pulled in by @qwen-code/qwen-code) land in the same dir. For uvx
    // we keep the single-executable alias scan, since --tool-bin-dir holds only the
    // one tool. Either way we fail here rather than at first launch.
    `if [ ! -e ${shq(partialBin)} ]; then`,
  );
  if (plan.kind === "npx") {
    const pkgJson = `${partial}/node_modules/${plan.pkg}/package.json`;
    const resolver = [
      `const fs = require("fs");`,
      `const p = process.argv[1];`,
      `try {`,
      `  const j = JSON.parse(fs.readFileSync(p, "utf8"));`,
      `  const b = j.bin;`,
      `  const n = (j.name || "").includes("@") ? (j.name.split("/")[1] || "") : (j.name || "");`,
      `  let out = "";`,
      `  if (typeof b === "string") out = n;`,
      `  else if (b && typeof b === "object") {`,
      `    const k = Object.keys(b);`,
      `    out = k.find((x) => x === n) || k[0] || "";`,
      `  }`,
      `  process.stdout.write(out);`,
      `} catch (e) {`,
      `  process.stdout.write("");`,
      `}`,
    ].join("\n");
    lines.push(
      `  real=$(node -e ${shq(resolver)} ${shq(pkgJson)} 2>/dev/null || true)`,
      `  if [ -n "$real" ] && [ -e "${partialBinDir}/$real" ]; then`,
      `    ln -s "$real" ${shq(partialBin)}`,
      `  else`,
      `    echo ${shq(`ZAKURA_ACP_BIN_NOT_FOUND:${expectedBin}`)} >&2`,
      `    ls -1 ${shq(partialBinDir)} 2>/dev/null >&2 || true`,
      `    zk_rm ${shq(partial)}`,
      `    exit 1`,
      `  fi`,
    );
  } else {
    lines.push(
      `  set -- $(ls -1 ${shq(partialBinDir)} 2>/dev/null || true)`,
      `  if [ $# -eq 1 ] && [ -n "$1" ]; then`,
      `    ln -s "$1" ${shq(partialBin)}`,
      `  else`,
      `    echo ${shq(`ZAKURA_ACP_BIN_NOT_FOUND:${expectedBin}`)} >&2`,
      `    ls -1 ${shq(partialBinDir)} 2>/dev/null >&2 || true`,
      `    zk_rm ${shq(partial)}`,
      `    exit 1`,
      `  fi`,
    );
  }
  lines.push(
    `fi`,
    // Record what actually landed on disk. With a version fallback the directory
    // is still named after the pinned version, so without this the UI would keep
    // reporting a version that was never installed.
    ...(plan.kind === "npx"
      ? [
          `zk_real_ver=$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version||""))}catch(e){}' ${shq(`${partial}/node_modules/${plan.pkg}/package.json`)} 2>/dev/null || true)`,
          `[ -n "$zk_real_ver" ] && printf '%s' "$zk_real_ver" > ${shq(`${partial}/.version`)} || true`,
        ]
      : [`printf '%s' ${shq(plan.version)} > ${shq(`${partial}/.version`)}`]),
    `touch ${shq(`${partial}/.ok`)}`,
    `zk_rm ${shq(dir)}`,
    `mv ${shq(partial)} ${shq(dir)}`,
    `echo ${shq(`ZAKURA_ACP_INSTALLED:${agentId}:${plan.version}`)} >&2`,
  );
  return lines.join("\n");
}

/**
 * Report installed versions per adapter, one `id<TAB>version<TAB>actual` line each.
 *
 * `version` is the directory name (what was requested); `actual` is what npm really
 * resolved, which differs whenever a bad upstream pin triggered the fallback.
 */
export function acpInstalledVersionsScript(): string {
  return [
    "set -eu",
    `root=${shq(ACP_PROVISION_ROOT)}`,
    `[ -d "$root" ] || exit 0`,
    `for agent in "$root"/*; do`,
    `  [ -d "$agent" ] || continue`,
    `  [ "$(basename "$agent")" = ${shq(ACP_TRASH_DIRNAME)} ] && continue`,
    `  for ver in "$agent"/*; do`,
    `    [ -f "$ver/.ok" ] || continue`,
    `    actual=""`,
    `    [ -f "$ver/.version" ] && actual=$(cat "$ver/.version" 2>/dev/null || true)`,
    `    [ -n "$actual" ] || actual=$(basename "$ver")`,
    `    printf '%s\\t%s\\t%s\\n' "$(basename "$agent")" "$(basename "$ver")" "$actual"`,
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
    ...acpRmHelper(),
    `root=${shq(ACP_PROVISION_ROOT)}`,
    `[ -d "$root" ] || exit 0`,
    `keep=${shq(keepList)}`,
    `for agent in "$root"/*; do`,
    `  [ -d "$agent" ] || continue`,
    `  a=$(basename "$agent")`,
    // Trash dirs are siblings of what zk_rm removed, so they can appear at both
    // levels. They are bookkeeping, never an adapter, and must not be treated as one.
    `  [ "$a" = ${shq(ACP_TRASH_DIRNAME)} ] && { rm -rf "$agent" 2>/dev/null || true; continue; }`,
    `  for ver in "$agent"/*; do`,
    `    [ -d "$ver" ] || continue`,
    `    v=$(basename "$ver")`,
    `    [ "$v" = ${shq(ACP_TRASH_DIRNAME)} ] && { rm -rf "$ver" 2>/dev/null || true; continue; }`,
    // Also sweep interrupted installs, which are never valid to keep.
    `    case "$v" in *.partial) zk_rm "$ver"; continue ;; esac`,
    `    if ! printf '%s\\n' "$keep" | grep -qxF "$a/$v"; then`,
    `      zk_rm "$ver"`,
    `      echo "ZAKURA_ACP_PRUNED:$a/$v" >&2`,
    `    fi`,
    `  done`,
    // zk_rm may have just created a trash dir inside this agent; clear it so the
    // rmdir below can succeed for a fully-pruned adapter.
    `  rm -rf "$agent/${ACP_TRASH_DIRNAME}" 2>/dev/null || true`,
    `  rmdir "$agent" 2>/dev/null || true`,
    `done`,
    // Finally clear the root-level trash, including leftovers from earlier runs.
    `rm -rf "$root/${ACP_TRASH_DIRNAME}" 2>/dev/null || true`,
  ].join("\n");
}

/** Bytes used per adapter version, for the UI's disk breakdown. */
export function acpDiskUsageScript(): string {
  return [
    "set -eu",
    `root=${shq(ACP_PROVISION_ROOT)}`,
    `[ -d "$root" ] || exit 0`,
    `du -sk "$root"/*/* 2>/dev/null | while read -r kb path; do`,
    `  case "$path" in */${ACP_TRASH_DIRNAME}|*/${ACP_TRASH_DIRNAME}/*) continue ;; esac`,
    `  printf '%s\\t%s\\n' "$kb" "$path"`,
    `done`,
  ].join("\n");
}

/**
 * Remove one adapter entirely, or a single version of it.
 *
 * Uninstall is deliberately not expressed through {@link acpGcScript}: GC keeps a
 * survivor per adapter on purpose, so it can never express "the user wants this
 * adapter gone". Removing the whole agent directory is the only way to get the
 * disk back and to make the adapter disappear from the installed list.
 */
export function acpUninstallScript(agentId: string, version?: string): string {
  const target = version
    ? `${ACP_PROVISION_ROOT}/${safeSegment(agentId)}/${safeSegment(version)}`
    : `${ACP_PROVISION_ROOT}/${safeSegment(agentId)}`;
  return [
    "set -eu",
    ...acpRmHelper(),
    `target=${shq(target)}`,
    `if [ ! -e "$target" ]; then echo "ZAKURA_ACP_NOT_INSTALLED" >&2; exit 0; fi`,
    `zk_rm "$target"`,
    // Drop the now-empty agent dir so status/GC stop reporting a ghost entry.
    `rmdir ${shq(`${ACP_PROVISION_ROOT}/${safeSegment(agentId)}`)} 2>/dev/null || true`,
    `echo "ZAKURA_ACP_REMOVED:${safeSegment(agentId)}${version ? `/${safeSegment(version)}` : ""}" >&2`,
  ].join("\n");
}
