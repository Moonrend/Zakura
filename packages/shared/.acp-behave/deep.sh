zk_rm() {
  [ -e "$1" ] || return 0
  trash="$(dirname "$1")/.trash"
  mkdir -p "$trash" 2>/dev/null || true
  tmp="$trash/$(basename "$1").$$.$(date +%s 2>/dev/null || echo 0)"
  if mv "$1" "$tmp" 2>/dev/null; then
    for _ in 1 2 3; do rm -rf "$tmp" 2>/dev/null && break; done
    return 0
  fi
  for _ in 1 2 3; do
    rm -rf "$1" 2>/dev/null && return 0
  done
  return 0
}
t=$(mktemp -d)
mkdir -p "$t/node_modules/@earendil-works/pi-coding-agent/dist/cli/core/extensions/modes/interactive/components"
for i in 1 2 3 4 5 6 7 8; do echo x > "$t/node_modules/@earendil-works/pi-coding-agent/dist/cli/core/extensions/modes/interactive/components/f$i.js"; done
zk_rm "$t/node_modules"
[ -e "$t/node_modules" ] && echo STILL_THERE || echo GONE