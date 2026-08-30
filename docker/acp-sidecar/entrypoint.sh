#!/usr/bin/env bash
# Zakura ACP sidecar PID1 — minimal container for adapter processes.
# Adapters (claude-code, codex, opencode …) are launched via docker exec;
# this script just keeps the container alive and signals readiness.
set -u

export PATH="/opt/zakura/acp/bin:/usr/local/node/bin:${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

cd /workspace 2>/dev/null || { mkdir -p /workspace; cd /workspace; }
mkdir -p /workspace/.cache/npm /workspace/.cache/pip /var/lib/zakura-features

touch /var/lib/zakura-features/.shell-ready
touch /var/lib/zakura-features/.ready

trap 'exit 0' TERM INT
exec sleep infinity
