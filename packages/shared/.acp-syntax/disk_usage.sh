set -eu
root='/workspace/.zakura/acp'
[ -d "$root" ] || exit 0
du -sk "$root"/*/* 2>/dev/null | while read -r kb path; do
  case "$path" in */.trash|*/.trash/*) continue ;; esac
  printf '%s\t%s\n' "$kb" "$path"
done