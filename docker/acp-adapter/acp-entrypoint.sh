#!/usr/bin/env bash
# PID 1 of an ACP adapter container.
#
# Contract: stdout carries ACP JSON-RPC and nothing else. Every diagnostic here
# goes to stderr. Anything this script prints to stdout would be parsed as a
# protocol frame by the server and desync the session.
set -euo pipefail

ACP_HOME="${ACP_HOME:-/opt/zakura/acp}"
ARGV_FILE="${ACP_HOME}/etc/argv"
ENV_FILE="${ACP_HOME}/etc/env"

log() { echo "[acp-entrypoint] $*" >&2; }

if [ ! -s "${ARGV_FILE}" ]; then
  log "FATAL: ${ARGV_FILE} is missing or empty; image was built incorrectly"
  exit 78 # EX_CONFIG
fi

# Baked-in env (from the registry's distribution.env) is applied first so the
# caller's `docker run -e` always wins.
if [ -s "${ENV_FILE}" ]; then
  while IFS= read -r line; do
    [ -n "${line}" ] || continue
    case "${line}" in \#*) continue ;; esac
    key="${line%%=*}"
    # Only set if the caller did not already provide it.
    if [ -z "${!key:-}" ]; then
      export "${line?}"
    fi
  done < "${ENV_FILE}"
fi

# One-shot migration of pre-container credentials.
#
# Before containerization, adapters ran via `docker exec` in the shared sidecar
# and persisted logins under the agent workspace. That workspace is still
# bind-mounted here, but HOME now points at a dedicated volume, so without this
# every existing user would be silently logged out.
#
# Runs here rather than from the server because this is the only point that is
# provably ordered before the adapter's first read of HOME. `cp -an` never
# clobbers, so a real login already in the volume always wins. The legacy tree
# is intentionally left in place so rollback to the sidecar path stays possible.
if [ -n "${ACP_LEGACY_HOME:-}" ] && [ -z "${ACP_SKIP_CRED_SEED:-}" ]; then
  seed_sentinel="${HOME:-/root}/.zakura-migrated"
  if [ ! -e "${seed_sentinel}" ]; then
    if [ -d "${ACP_LEGACY_HOME}" ]; then
      cp -an "${ACP_LEGACY_HOME}/." "${HOME:-/root}/" 2>/dev/null || true
      log "seeded credentials from ${ACP_LEGACY_HOME}"
    fi
    touch "${seed_sentinel}" 2>/dev/null || true
  fi
fi

# argv is newline-separated so arguments may contain spaces safely.
argv=()
while IFS= read -r arg; do
  [ -n "${arg}" ] || continue
  argv+=("${arg}")
done < "${ARGV_FILE}"

if [ "${#argv[@]}" -eq 0 ]; then
  log "FATAL: no launch command recorded"
  exit 78
fi

# Allow callers to append arguments (e.g. --model) without rebuilding.
if [ "$#" -gt 0 ]; then
  argv+=("$@")
fi

# exec so the adapter becomes PID 1 and receives SIGTERM directly from
# `docker stop`; no wrapper process to swallow signals or buffer the stream.
exec "${argv[@]}"