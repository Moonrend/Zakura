set -eu
if [ -f '/workspace/.zakura/acp/cur/1.0.0/.ok' ]; then exit 0; fi
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
zk_rm '/workspace/.zakura/acp/cur/1.0.0.partial'
mkdir -p '/workspace/.zakura/acp/cur/1.0.0.partial' '/workspace/.zakura/cache'
mkdir -p '/workspace/.zakura/acp/cur/1.0.0.partial/root'
curl -fsSL --max-time 300 -o '/workspace/.zakura/acp/cur/1.0.0.partial/archive' 'https://example.com/x.tar.gz'
echo 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  /workspace/.zakura/acp/cur/1.0.0.partial/archive' | sha256sum -c - >&2
case 'https://example.com/x.tar.gz' in
  *.tar.gz|*.tgz) tar -xzf '/workspace/.zakura/acp/cur/1.0.0.partial/archive' -C '/workspace/.zakura/acp/cur/1.0.0.partial/root' ;;
  *.tar.bz2|*.tbz2) tar -xjf '/workspace/.zakura/acp/cur/1.0.0.partial/archive' -C '/workspace/.zakura/acp/cur/1.0.0.partial/root' ;;
  *.zip) unzip -q '/workspace/.zakura/acp/cur/1.0.0.partial/archive' -d '/workspace/.zakura/acp/cur/1.0.0.partial/root' ;;
  *) cp '/workspace/.zakura/acp/cur/1.0.0.partial/archive' '/workspace/.zakura/acp/cur/1.0.0.partial/root/cur' ;;
esac
rm -f '/workspace/.zakura/acp/cur/1.0.0.partial/archive'
find '/workspace/.zakura/acp/cur/1.0.0.partial/root' -type f -name 'cur' -exec chmod +x {} + 2>/dev/null || true
if [ ! -e '/workspace/.zakura/acp/cur/1.0.0.partial/root/cur' ]; then
  set -- $(ls -1 '/workspace/.zakura/acp/cur/1.0.0.partial/bin' 2>/dev/null || true)
  if [ $# -eq 1 ] && [ -n "$1" ]; then
    ln -s "$1" '/workspace/.zakura/acp/cur/1.0.0.partial/root/cur'
  else
    echo 'ZAKURA_ACP_BIN_NOT_FOUND:/workspace/.zakura/acp/cur/1.0.0/root/cur' >&2
    ls -1 '/workspace/.zakura/acp/cur/1.0.0.partial/bin' 2>/dev/null >&2 || true
    zk_rm '/workspace/.zakura/acp/cur/1.0.0.partial'
    exit 1
  fi
fi
printf '%s' '1.0.0' > '/workspace/.zakura/acp/cur/1.0.0.partial/.version'
touch '/workspace/.zakura/acp/cur/1.0.0.partial/.ok'
zk_rm '/workspace/.zakura/acp/cur/1.0.0'
mv '/workspace/.zakura/acp/cur/1.0.0.partial' '/workspace/.zakura/acp/cur/1.0.0'
echo 'ZAKURA_ACP_INSTALLED:cur:1.0.0' >&2