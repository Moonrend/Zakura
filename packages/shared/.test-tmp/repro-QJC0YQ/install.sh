set -eu
if [ -f '.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2/.ok' ]; then exit 0; fi
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
zk_rm '.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial'
mkdir -p '.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial' '.test-tmp/repro-QJC0YQ/cache'
if ! mkdir -p ".test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial/node_modules/.bin" && printf '#!/bin/sh\n' > ".test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial/node_modules/.bin/codex-acp"; then
  cat '.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial.npm-err' >&2
  if grep -qE 'ETARGET|No matching version|is not in this registry' '.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial.npm-err'; then
    rm -f '.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial.npm-err'
    echo 'ZAKURA_ACP_VERSION_FALLBACK:codex-acp:1.6.2' >&2
mkdir -p ".test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial/node_modules/.bin" && printf '#!/bin/sh\n' > ".test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial/node_modules/.bin/codex-acp"
  else
    rm -f '.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial.npm-err'
    exit 1
  fi
fi
rm -f '.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial.npm-err'
if [ ! -e '.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial/node_modules/.bin/codex-acp' ]; then
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
}' '.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial/node_modules/codex-acp/package.json' 2>/dev/null || true)
  if [ -n "$real" ] && [ -e ".test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial/node_modules/.bin/$real" ]; then
    ln -s "$real" '.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial/node_modules/.bin/codex-acp'
  else
    echo 'ZAKURA_ACP_BIN_NOT_FOUND:.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2/node_modules/.bin/codex-acp' >&2
    ls -1 '.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial/node_modules/.bin' 2>/dev/null >&2 || true
    zk_rm '.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial'
    exit 1
  fi
fi
zk_real_ver=$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version||""))}catch(e){}' '.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial/node_modules/codex-acp/package.json' 2>/dev/null || true)
[ -n "$zk_real_ver" ] && printf '%s' "$zk_real_ver" > '.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial/.version' || true
touch '.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial/.ok'
zk_rm '.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2'
mv '.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2.partial' '.test-tmp/repro-QJC0YQ/acp/codex-acp/1.6.2'
echo 'ZAKURA_ACP_INSTALLED:codex-acp:1.6.2' >&2