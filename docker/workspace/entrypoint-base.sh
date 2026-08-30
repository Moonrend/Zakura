#!/usr/bin/env bash
# Zakura workspace PID1 — base (shell-only) image.
# Host workspace is bind-mounted at /workspace (shared with agent fs_* tools).
# Full display/browser stack lives in the "full" image entrypoint.
set -u

export DEBIAN_FRONTEND=noninteractive
export PATH="/opt/zakura/acp/bin:/usr/local/node/bin:${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

cd /workspace 2>/dev/null || { mkdir -p /workspace; cd /workspace; }
mkdir -p /workspace/.cache/npm /workspace/.cache/pip

log() { echo "[$(date -Iseconds)] $*" >>/var/log/zakura/workspace.log; }
mkdir -p /var/log/zakura /var/lib/zakura-features

log "workspace ready cwd=$(pwd) python=$(command -v python3) node=$(command -v node)"

touch /var/lib/zakura-features/.shell-ready
touch /var/lib/zakura-features/.ready
log "shell-ready (base image, no display stack)"

trap 'exit 0' TERM INT
sleep infinity &
wait $!
