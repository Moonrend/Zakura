set -eu
if [ -f '/workspace/.zakura/acp/u/1.2.3/.ok' ]; then exit 0; fi
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
zk_rm '/workspace/.zakura/acp/u/1.2.3.partial'
mkdir -p '/workspace/.zakura/acp/u/1.2.3.partial' '/workspace/.zakura/cache'
command -v uv >/dev/null 2>&1 || { echo "ZAKURA_ACP_NEED_UV" >&2; exit 127; }
UV_CACHE_DIR='/workspace/.zakura/cache/uv' uv tool install --force --tool-dir '/workspace/.zakura/acp/u/1.2.3.partial/tools' --tool-bin-dir '/workspace/.zakura/acp/u/1.2.3.partial/bin' 'u==1.2.3' >&2
if [ ! -e '/workspace/.zakura/acp/u/1.2.3.partial/bin/u' ]; then
  set -- $(ls -1 '/workspace/.zakura/acp/u/1.2.3.partial/bin' 2>/dev/null || true)
  if [ $# -eq 1 ] && [ -n "$1" ]; then
    ln -s "$1" '/workspace/.zakura/acp/u/1.2.3.partial/bin/u'
  else
    echo 'ZAKURA_ACP_BIN_NOT_FOUND:/workspace/.zakura/acp/u/1.2.3/bin/u' >&2
    ls -1 '/workspace/.zakura/acp/u/1.2.3.partial/bin' 2>/dev/null >&2 || true
    zk_rm '/workspace/.zakura/acp/u/1.2.3.partial'
    exit 1
  fi
fi
printf '%s' '1.2.3' > '/workspace/.zakura/acp/u/1.2.3.partial/.version'
touch '/workspace/.zakura/acp/u/1.2.3.partial/.ok'
zk_rm '/workspace/.zakura/acp/u/1.2.3'
mv '/workspace/.zakura/acp/u/1.2.3.partial' '/workspace/.zakura/acp/u/1.2.3'
echo 'ZAKURA_ACP_INSTALLED:u:1.2.3' >&2