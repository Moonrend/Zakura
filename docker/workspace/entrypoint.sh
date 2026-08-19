#!/usr/bin/env bash
# Zakura workspace PID1 — prebaked image (languages + optional display/browser).
# Host workspace is bind-mounted at /workspace (shared with agent fs_* tools).
set -u

export DEBIAN_FRONTEND=noninteractive
export DISPLAY="${DISPLAY:-:99}"
export PATH="/usr/local/node/bin:${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

cd /workspace 2>/dev/null || { mkdir -p /workspace; cd /workspace; }
mkdir -p /workspace/.cache/npm /workspace/.cache/pip

W="${ZAKURA_DESKTOP_WIDTH:-1280}"
H="${ZAKURA_DESKTOP_HEIGHT:-720}"
BROWSER="${ZAKURA_ENABLE_BROWSER:-0}"
COMPUTER="${ZAKURA_ENABLE_COMPUTER:-0}"

# Seeing the browser in the console requires noVNC (desktop stack).
if [ "$BROWSER" = "1" ] || [ "$BROWSER" = "true" ]; then
  COMPUTER=1
fi

mkdir -p /tmp/zakura-display /var/log/zakura /tmp/zakura-chrome /tmp/.X11-unix /var/lib/zakura-features
chmod 1777 /tmp/.X11-unix 2>/dev/null || true

log() { echo "[$(date -Iseconds)] $*" >>/var/log/zakura/workspace.log; }

find_browser() {
  for b in chromium chromium-browser google-chrome-stable google-chrome; do
    bin=$(command -v "$b" 2>/dev/null || true)
    [ -n "$bin" ] || continue
    if head -c 200 "$bin" 2>/dev/null | grep -qi snap; then continue; fi
    [ -x "$bin" ] && { echo "$bin"; return 0; }
  done
  for candidate in /usr/lib/chromium/chromium /usr/bin/chromium; do
    [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

start_chrome() {
  local bin
  bin=$(find_browser) || {
    log "ERROR: no chromium binary"
    echo "ERROR: no usable Chromium binary" >/var/log/zakura/chrome.log
    return 1
  }
  pkill -f "remote-debugging-port=9222" >/dev/null 2>&1 || true
  sleep 0.3
  rm -rf /tmp/zakura-chrome/Singleton* /tmp/zakura-chrome/Lock 2>/dev/null || true
  log "starting browser: $bin"
  "$bin" --no-sandbox --disable-dev-shm-usage --disable-gpu \
    --no-first-run --no-default-browser-check --force-renderer-accessibility \
    --disable-features=TranslateUI \
    --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
    --remote-allow-origins=* \
    --user-data-dir=/tmp/zakura-chrome \
    --window-size="${W},${H}" --window-position=0,0 \
    "about:blank" >>/var/log/zakura/chrome.log 2>&1 &
  local i
  for i in $(seq 1 40); do
    if curl -sf -m 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
      log "CDP ready"
      return 0
    fi
    sleep 0.5
  done
  log "WARN: CDP not ready after start"
  return 1
}

log "workspace ready cwd=$(pwd) python=$(command -v python3) node=$(command -v node)"

# Shell readiness: /workspace is mounted and the toolchain is usable. ACP / exec
# / shell jobs only need this — they never touch the browser — so signal it
# immediately instead of blocking on Chrome for the whole display stack.
touch /var/lib/zakura-features/.shell-ready
log "shell-ready"

needs_display=0
if [ "$BROWSER" = "1" ] || [ "$BROWSER" = "true" ] || [ "$COMPUTER" = "1" ] || [ "$COMPUTER" = "true" ]; then
  needs_display=1
fi

if [ "$needs_display" != "1" ]; then
  log "shell-only mode (languages available, no display)"
  touch /var/lib/zakura-features/.ready
  trap 'exit 0' TERM INT
  exec sleep infinity
fi

log "display mode browser=$BROWSER computer=$COMPUTER ${W}x${H}"

rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
Xvfb :99 -screen 0 "${W}x${H}x24" -ac -nolisten tcp >>/var/log/zakura/xvfb.log 2>&1 &
for i in $(seq 1 80); do
  [ -e /tmp/.X11-unix/X99 ] && break
  sleep 0.1
done
if [ ! -e /tmp/.X11-unix/X99 ]; then
  log "ERROR: Xvfb failed"
fi

openbox >>/var/log/zakura/openbox.log 2>&1 &
sleep 0.5

if [ "$COMPUTER" = "1" ] || [ "$COMPUTER" = "true" ]; then
  x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -listen 0.0.0.0 -xkb \
    >>/var/log/zakura/x11vnc.log 2>&1 &
  if [ -d /usr/share/novnc ]; then
    websockify --web /usr/share/novnc 6080 localhost:5900 >>/var/log/zakura/novnc.log 2>&1 &
  fi
  log "noVNC on :6080"
fi

if [ "$BROWSER" = "1" ] || [ "$BROWSER" = "true" ]; then
  start_chrome || true
fi

# Display readiness: the full browser/desktop stack is up (or best-effort).
# Touched *after* the Chrome CDP loop so ACP computer-use paths can wait for it
# without blocking pure coding agents on .shell-ready.
touch /var/lib/zakura-features/.display-ready
touch /var/lib/zakura-features/.ready
log "ready"

(
  while true; do
    sleep 5
    if [ "$BROWSER" = "1" ] || [ "$BROWSER" = "true" ]; then
      if ! curl -sf -m 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
        log "CDP down — restarting chrome"
        start_chrome || true
      fi
    fi
  done
) &

trap 'exit 0' TERM INT
sleep infinity &
wait $!
