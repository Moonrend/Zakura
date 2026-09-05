#!/usr/bin/env bash
# Installs one ACP adapter into the image at build time.
# Driven entirely by ACP_* build args; see docker/acp-adapter/Dockerfile.
set -euo pipefail

ACP_HOME="${ACP_HOME:-/opt/zakura/acp}"
BIN_DIR="${ACP_HOME}/bin"
mkdir -p "${BIN_DIR}" "${ACP_HOME}/etc"

: "${ACP_ID:?ACP_ID is required}"
: "${ACP_KIND:?ACP_KIND is required}"

log() { echo "[install-adapter] $*" >&2; }

install_npx() {
  : "${ACP_PACKAGE:?ACP_PACKAGE is required for kind=npx}"
  log "npm install -g ${ACP_PACKAGE}"
  # Pin to the exact version from the registry; no implicit upgrade at runtime.
  npm install -g --no-audit --no-fund "${ACP_PACKAGE}"
  npm cache clean --force >/dev/null 2>&1 || true

  # The executable name lives in the package's "bin" field and is NOT derivable
  # from the package name (@agentclientprotocol/claude-agent-acp -> claude-code-acp).
  # Read it from the installed package rather than guessing.
  local spec name root pkgjson bin
  spec="${ACP_PACKAGE}"
  # Strip a trailing @version, keeping any leading @scope.
  name="$(printf '%s' "${spec}" | sed -E 's/^(@[^/]+\/)?([^@]+)(@.*)?$/\1\2/')"
  root="$(npm root -g)"
  pkgjson="${root}/${name}/package.json"
  if [ ! -f "${pkgjson}" ]; then
    log "ERROR: cannot locate installed package at ${pkgjson}"
    ls -1 "${root}" >&2 || true
    exit 1
  fi
  bin="$(node -e '
    const p = require(process.argv[1]);
    const b = p.bin;
    if (!b) { process.exit(3); }
    process.stdout.write(typeof b === "string" ? p.name.split("/").pop() : Object.keys(b)[0]);
  ' "${pkgjson}")"
  if [ -z "${bin}" ]; then
    log "ERROR: package ${name} declares no bin entry"
    exit 1
  fi
  command -v "${bin}" >/dev/null 2>&1 || { log "ERROR: ${bin} not on PATH after install"; exit 1; }
  command -v "${bin}" > "${ACP_HOME}/etc/cmdpath"
  log "resolved npx bin: ${bin} -> $(cat "${ACP_HOME}/etc/cmdpath")"
}

install_uvx() {
  : "${ACP_PACKAGE:?ACP_PACKAGE is required for kind=uvx}"
  log "installing uv"
  curl -fsSL https://astral.sh/uv/install.sh | sh
  export PATH="/root/.local/bin:${PATH}"
  log "uv tool install ${ACP_PACKAGE}"
  uv tool install --python 3.12 "${ACP_PACKAGE}"
  # uv puts shims in ~/.local/bin; expose them on the image PATH.
  for f in /root/.local/bin/*; do
    [ -x "$f" ] || continue
    ln -sf "$f" "${BIN_DIR}/$(basename "$f")"
  done

  # uv tool install prints nothing machine-readable, so derive the entrypoint
  # from the tool's recorded receipt when possible, else fall back to the
  # package name with the version spec stripped.
  local name
  name="$(printf '%s' "${ACP_PACKAGE}" | sed -E 's/[@>=<~!].*$//')"
  if command -v "${name}" >/dev/null 2>&1; then
    command -v "${name}" > "${ACP_HOME}/etc/cmdpath"
  else
    log "ERROR: '${name}' not on PATH after uv tool install; available shims:"
    ls -1 /root/.local/bin >&2 || true
    exit 1
  fi
  log "resolved uvx bin: $(cat "${ACP_HOME}/etc/cmdpath")"
}

install_binary() {
  : "${ACP_ARCHIVE:?ACP_ARCHIVE is required for kind=binary}"
  : "${ACP_CMD:?ACP_CMD is required for kind=binary}"

  # The registry's `cmd` is a path relative to the archive root, not a bare
  # name: "./goose", but also "./bin/devin" and "./dist-package/cursor-agent".
  # Keep both forms - the relative path is the authoritative location, the
  # basename is only a fallback when the archive nests under a version dir.
  local rel base
  rel="${ACP_CMD#./}"
  base="$(basename "${rel}")"

  local tmp
  tmp="$(mktemp -d)"
  local file="${tmp}/download"

  log "downloading ${ACP_ARCHIVE}"
  curl -fsSL --retry 3 --retry-delay 2 -o "${file}" "${ACP_ARCHIVE}"

  if [ -n "${ACP_SHA256:-}" ]; then
    log "verifying sha256"
    echo "${ACP_SHA256}  ${file}" | sha256sum -c -
  else
    # Loud, because an unverified binary is a supply-chain risk we accept only
    # when upstream genuinely publishes no digest.
    log "WARNING: no sha256 published upstream for ${ACP_ID}; skipping verification"
  fi

  local extract="${tmp}/x"
  mkdir -p "${extract}"

  # The registry ships .tar.gz, .tar.bz2, .zip and bare binaries. Dispatch on
  # actual content rather than the URL, since some assets have no extension.
  local mime
  mime="$(file -b --mime-type "${file}" 2>/dev/null || echo unknown)"
  case "${mime}" in
    application/gzip | application/x-gzip)
      tar -xzf "${file}" -C "${extract}" ;;
    application/x-bzip2)
      tar -xjf "${file}" -C "${extract}" ;;
    application/x-xz)
      tar -xJf "${file}" -C "${extract}" ;;
    application/zip)
      unzip -q "${file}" -d "${extract}" ;;
    *)
      log "treating download as a bare executable (mime=${mime})"
      mkdir -p "${extract}/$(dirname "${rel}")"
      cp "${file}" "${extract}/${rel}" ;;
  esac

  # Archives vary in layout: some are flat, some nest everything under a
  # versioned top-level directory. Try the declared path first, then search by
  # basename at any depth.
  local found
  if [ -f "${extract}/${rel}" ]; then
    found="${extract}/${rel}"
  else
    found="$(find "${extract}" -type f -path "*/${rel}" -print -quit)"
  fi
  if [ -z "${found}" ]; then
    found="$(find "${extract}" -type f -name "${base}" -print -quit)"
  fi
  if [ -z "${found}" ]; then
    log "ERROR: '${ACP_CMD}' (rel=${rel}, base=${base}) not found in archive; contents were:"
    find "${extract}" -maxdepth 3 -type f -printf '  %P\n' >&2 || true
    exit 1
  fi

  install -m 0755 "${found}" "${BIN_DIR}/${base}"

  # Some archives ship sidecar files (shared libs, resources) next to the
  # binary; copy the whole directory so those keep resolving.
  local srcdir
  srcdir="$(dirname "${found}")"
  if [ "$(find "${srcdir}" -mindepth 1 -maxdepth 1 | wc -l)" -gt 1 ]; then
    mkdir -p "${ACP_HOME}/lib/${ACP_ID}"
    cp -a "${srcdir}/." "${ACP_HOME}/lib/${ACP_ID}/"
    chmod 0755 "${ACP_HOME}/lib/${ACP_ID}/${base}"
    ln -sf "${ACP_HOME}/lib/${ACP_ID}/${base}" "${BIN_DIR}/${base}"
  fi

  # The entrypoint execs an absolute path, so the resolved location must be
  # recorded for the argv baking step rather than guessed later.
  echo "${BIN_DIR}/${base}" > "${ACP_HOME}/etc/cmdpath"

  rm -rf "${tmp}"
}

case "${ACP_KIND}" in
  npx)    install_npx ;;
  uvx)    install_uvx ;;
  binary) install_binary ;;
  *)      log "ERROR: unknown ACP_KIND '${ACP_KIND}'"; exit 1 ;;
esac

# ---------------------------------------------------------------------------
# Bake argv + env for the entrypoint.
#
# argv is newline-separated (see acp-entrypoint.sh) so arguments containing
# spaces survive without quoting games. ACP_ARGS arrives as a JSON array
# because the registry's args are already JSON and re-quoting them through a
# shell string is where this kind of plumbing usually breaks.
# ---------------------------------------------------------------------------
CMDPATH_FILE="${ACP_HOME}/etc/cmdpath"
if [ ! -s "${CMDPATH_FILE}" ]; then
  log "ERROR: install step did not record ${CMDPATH_FILE}"
  exit 1
fi
CMDPATH="$(cat "${CMDPATH_FILE}")"
if [ ! -x "${CMDPATH}" ]; then
  log "ERROR: recorded command '${CMDPATH}' is not executable"
  exit 1
fi

{
  printf '%s\n' "${CMDPATH}"
  if [ -n "${ACP_ARGS:-}" ] && [ "${ACP_ARGS}" != "[]" ]; then
    printf '%s' "${ACP_ARGS}" | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d));
      process.stdin.on("end", () => {
        const a = JSON.parse(s);
        if (!Array.isArray(a)) { process.exit(4); }
        for (const x of a) process.stdout.write(String(x) + "\n");
      });
    '
  fi
} > "${ACP_HOME}/etc/argv"

if [ -n "${ACP_ENV:-}" ] && [ "${ACP_ENV}" != "{}" ]; then
  printf '%s' "${ACP_ENV}" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      const o = JSON.parse(s);
      for (const [k, v] of Object.entries(o)) process.stdout.write(`${k}=${v}\n`);
    });
  ' > "${ACP_HOME}/etc/env"
else
  : > "${ACP_HOME}/etc/env"
fi

log "argv:"
sed 's/^/  /' "${ACP_HOME}/etc/argv" >&2

log "installed ${ACP_ID} (${ACP_KIND})"
