set -eu
root='/workspace/.zakura/acp'
[ -d "$root" ] || exit 0
for agent in "$root"/*; do
  [ -d "$agent" ] || continue
  [ "$(basename "$agent")" = '.trash' ] && continue
  for ver in "$agent"/*; do
    [ -f "$ver/.ok" ] || continue
    actual=""
    [ -f "$ver/.version" ] && actual=$(cat "$ver/.version" 2>/dev/null || true)
    [ -n "$actual" ] || actual=$(basename "$ver")
    printf '%s\t%s\t%s\n' "$(basename "$agent")" "$(basename "$ver")" "$actual"
  done
done