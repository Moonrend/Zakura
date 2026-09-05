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
root='/workspace/.zakura/acp'
[ -d "$root" ] || exit 0
keep='a/1'
for agent in "$root"/*; do
  [ -d "$agent" ] || continue
  a=$(basename "$agent")
  [ "$a" = '.trash' ] && { rm -rf "$agent" 2>/dev/null || true; continue; }
  for ver in "$agent"/*; do
    [ -d "$ver" ] || continue
    v=$(basename "$ver")
    [ "$v" = '.trash' ] && { rm -rf "$ver" 2>/dev/null || true; continue; }
    case "$v" in *.partial) zk_rm "$ver"; continue ;; esac
    if ! printf '%s\n' "$keep" | grep -qxF "$a/$v"; then
      zk_rm "$ver"
      echo "ZAKURA_ACP_PRUNED:$a/$v" >&2
    fi
  done
  rm -rf "$agent/.trash" 2>/dev/null || true
  rmdir "$agent" 2>/dev/null || true
done
rm -rf "$root/.trash" 2>/dev/null || true