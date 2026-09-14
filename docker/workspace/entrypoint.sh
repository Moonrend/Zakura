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
rm -f /var/lib/zakura-features/.shell-ready /var/lib/zakura-features/.display-ready /var/lib/zakura-features/.display-error /var/lib/zakura-features/.ready

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

start_display() {
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
  Xvfb :99 -screen 0 "${W}x${H}x24" -ac -nolisten tcp >>/var/log/zakura/xvfb.log 2>&1 &
  for i in $(seq 1 80); do
    if DISPLAY=:99 xdotool getdisplaygeometry >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  log "ERROR: Xvfb not ready on DISPLAY=:99"
  return 1
}

start_vnc() {
  x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -listen 127.0.0.1 -xkb \
    >>/var/log/zakura/x11vnc.log 2>&1 &
}

update_display_readiness() {
  local ready=1
  DISPLAY=:99 xdotool getdisplaygeometry >/dev/null 2>&1 || ready=0
  if [ "$COMPUTER" = "1" ] || [ "$COMPUTER" = "true" ]; then
    timeout 1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/5900; IFS= read -r -n 12 banner <&3; [[ "$banner" == RFB* ]]' 2>/dev/null || ready=0
  fi
  if [ "$BROWSER" = "1" ] || [ "$BROWSER" = "true" ]; then
    curl -sf -m 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1 || ready=0
  fi
  if [ "$ready" = 1 ]; then
    [ -f /var/lib/zakura-features/.display-ready ] || log "display-ready"
    touch /var/lib/zakura-features/.display-ready /var/lib/zakura-features/.ready
    rm -f /var/lib/zakura-features/.display-error
  else
    rm -f /var/lib/zakura-features/.display-ready /var/lib/zakura-features/.ready
    echo 'Display not ready: check Xvfb :99, VNC :5900 and Chrome :9222 logs in /var/log/zakura.' >/var/lib/zakura-features/.display-error
  fi
}

start_display || true

openbox >>/var/log/zakura/openbox.log 2>&1 &
sleep 0.5

if [ "$COMPUTER" = "1" ] || [ "$COMPUTER" = "true" ]; then
  start_vnc
  if [ -d /usr/share/novnc ]; then
    websockify --web /usr/share/novnc 127.0.0.1:6080 localhost:5900 >>/var/log/zakura/novnc.log 2>&1 &
  fi
  log "noVNC on :6080"
fi

if [ "$BROWSER" = "1" ] || [ "$BROWSER" = "true" ]; then
  start_chrome || true
fi

# Shell remains available for diagnosis if display startup failed. Do not claim
# the computer is ready solely because PID1 or the X11 socket exists.
update_display_readiness

(
  while true; do
    sleep 5
    if ! pgrep -x Xvfb >/dev/null; then
      log "Xvfb down — restarting display"
      start_display || true
    fi
    if ! DISPLAY=:99 xdotool getdisplaygeometry >/dev/null 2>&1; then
      update_display_readiness
      continue
    fi
    if ! pgrep -x openbox >/dev/null; then
      openbox >>/var/log/zakura/openbox.log 2>&1 &
    fi
    if [ "$COMPUTER" = "1" ] || [ "$COMPUTER" = "true" ]; then
      if ! pgrep -x x11vnc >/dev/null; then
        log "VNC down — restarting x11vnc"
        start_vnc
      fi
    fi
    if [ "$BROWSER" = "1" ] || [ "$BROWSER" = "true" ]; then
      if ! curl -sf -m 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
        log "CDP down — restarting chrome"
        start_chrome || true
      fi
    fi
    update_display_readiness
  done
) &

trap 'exit 0' TERM INT
sleep infinity &
wait $!
