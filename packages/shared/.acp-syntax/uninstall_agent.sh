set -eu
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
target='/workspace/.zakura/acp/pi-acp'
if [ ! -e "$target" ]; then echo "ZAKURA_ACP_NOT_INSTALLED" >&2; exit 0; fi
zk_rm "$target"
rmdir '/workspace/.zakura/acp/pi-acp' 2>/dev/null || true
echo "ZAKURA_ACP_REMOVED:pi-acp" >&2