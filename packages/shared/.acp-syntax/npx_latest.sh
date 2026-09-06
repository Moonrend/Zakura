set -eu
if [ -f '/workspace/.zakura/acp/foo/latest/.ok' ]; then exit 0; fi
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
zk_rm '/workspace/.zakura/acp/foo/latest.partial'
mkdir -p '/workspace/.zakura/acp/foo/latest.partial' '/workspace/.zakura/cache'
npm_config_cache='/workspace/.zakura/cache/npm' npm install --prefix '/workspace/.zakura/acp/foo/latest.partial' --no-fund --no-audit --loglevel=error 'foo' >&2
if [ ! -e '/workspace/.zakura/acp/foo/latest.partial/node_modules/.bin/foo' ]; then
  real=$(node -e 'const fs = require("fs");
const p = process.argv[1];
try {
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const b = j.bin;
  const n = (j.name || "").includes("@") ? (j.name.split("/")[1] || "") : (j.name || "");
  let out = "";
  if (typeof b === "string") out = n;
  else if (b && typeof b === "object") {
    const k = Object.keys(b);
    out = k.find((x) => x === n) || k[0] || "";
  }
  process.stdout.write(out);
} catch (e) {
  process.stdout.write("");
}' '/workspace/.zakura/acp/foo/latest.partial/node_modules/foo/package.json' 2>/dev/null || true)
  if [ -n "$real" ] && [ -e "/workspace/.zakura/acp/foo/latest.partial/node_modules/.bin/$real" ]; then
    ln -s "$real" '/workspace/.zakura/acp/foo/latest.partial/node_modules/.bin/foo'
  else
    echo 'ZAKURA_ACP_BIN_NOT_FOUND:/workspace/.zakura/acp/foo/latest/node_modules/.bin/foo' >&2
    ls -1 '/workspace/.zakura/acp/foo/latest.partial/node_modules/.bin' 2>/dev/null >&2 || true
    zk_rm '/workspace/.zakura/acp/foo/latest.partial'
    exit 1
  fi
fi
zk_real_ver=$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version||""))}catch(e){}' '/workspace/.zakura/acp/foo/latest.partial/node_modules/foo/package.json' 2>/dev/null || true)
[ -n "$zk_real_ver" ] && printf '%s' "$zk_real_ver" > '/workspace/.zakura/acp/foo/latest.partial/.version' || true
touch '/workspace/.zakura/acp/foo/latest.partial/.ok'
zk_rm '/workspace/.zakura/acp/foo/latest'
mv '/workspace/.zakura/acp/foo/latest.partial' '/workspace/.zakura/acp/foo/latest'
echo 'ZAKURA_ACP_INSTALLED:foo:latest' >&2