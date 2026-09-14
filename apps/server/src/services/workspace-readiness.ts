/** Bound inside the container as older Runner docker.exec versions ignore timeoutMs. */
export function workspaceReadyCommand(level: "shell" | "display"): string[] {
  return ["timeout", "--signal=TERM", "--kill-after=2s", "35s", "bash", "-c", `
set -u
level="$1"
computer_enabled=$(printenv ZAKURA_ENABLE_COMPUTER || true)
if [ "$level" = display ] && [ "$computer_enabled" != 1 ] && [ "$computer_enabled" != true ]; then
  echo 'Desktop was not enabled when this container started. Restart the workspace to apply computer/browser flags (DISPLAY=:99).' >&2
  exit 1
fi
for attempt in $(seq 1 60); do
  if [ "$level" = shell ]; then
    if [ -f /var/lib/zakura-features/.shell-ready ] || [ -f /var/lib/zakura-features/.ready ]; then exit 0; fi
  elif command -v xdotool >/dev/null 2>&1 && DISPLAY=:99 xdotool getdisplaygeometry >/dev/null 2>&1; then
    if timeout 1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/5900; IFS= read -r -n 12 banner <&3; [[ "$banner" == RFB* ]]' 2>/dev/null &&
       curl -fsS --max-time 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then exit 0; fi
  fi
  sleep 0.5
done
echo "Workspace $level is not ready. Check DISPLAY=:99, Xvfb/xdotool, x11vnc :5900 and Chromium :9222." >&2
for file in /var/log/zakura/xvfb.log /var/log/zakura/x11vnc.log /var/log/zakura/chrome.log; do
  if [ -f "$file" ]; then tail -c 600 "$file" >&2; fi
done
exit 1`, "zakura-workspace-ready", level];
}
