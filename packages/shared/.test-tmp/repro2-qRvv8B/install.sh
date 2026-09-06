set -eu
if [ -f '.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3/.ok' ]; then exit 0; fi
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
zk_rm '.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial'
mkdir -p '.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial' '.test-tmp/repro2-qRvv8B/cache'
if ! { mkdir -p ".test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/@qwen-code/qwen-code" && printf '%s' '{"name":"@qwen-code/qwen-code","version":"0.22.3","bin":{"qwen":"cli-entry.js"}}' > ".test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/@qwen-code/qwen-code/package.json" && mkdir -p ".test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/.bin" && printf '#!/bin/sh\n' > ".test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/.bin/qwen" && chmod +x ".test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/.bin/qwen" && printf '#!/bin/sh\n' > ".test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/.bin/node-gyp-build" && printf '#!/bin/sh\n' > ".test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/.bin/semver"; }; then
  cat '.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial.npm-err' >&2
  if grep -qE 'ETARGET|No matching version|is not in this registry' '.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial.npm-err'; then
    rm -f '.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial.npm-err'
    echo 'ZAKURA_ACP_VERSION_FALLBACK:qwen-code:0.22.3' >&2
mkdir -p ".test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/@qwen-code/qwen-code" && printf '%s' '{"name":"@qwen-code/qwen-code","version":"0.22.3","bin":{"qwen":"cli-entry.js"}}' > ".test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/@qwen-code/qwen-code/package.json" && mkdir -p ".test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/.bin" && printf '#!/bin/sh\n' > ".test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/.bin/qwen" && chmod +x ".test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/.bin/qwen" && printf '#!/bin/sh\n' > ".test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/.bin/node-gyp-build" && printf '#!/bin/sh\n' > ".test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/.bin/semver"
  else
    rm -f '.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial.npm-err'
    exit 1
  fi
fi
rm -f '.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial.npm-err'
if [ ! -e '.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/.bin/qwen-code' ]; then
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
}' '.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/@qwen-code/qwen-code/package.json' 2>/dev/null || true)
  if [ -n "$real" ] && [ -e ".test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/.bin/$real" ]; then
    ln -s "$real" '.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/.bin/qwen-code'
  else
    echo 'ZAKURA_ACP_BIN_NOT_FOUND:.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3/node_modules/.bin/qwen-code' >&2
    ls -1 '.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/.bin' 2>/dev/null >&2 || true
    zk_rm '.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial'
    exit 1
  fi
fi
zk_real_ver=$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version||""))}catch(e){}' '.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/node_modules/@qwen-code/qwen-code/package.json' 2>/dev/null || true)
[ -n "$zk_real_ver" ] && printf '%s' "$zk_real_ver" > '.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/.version' || true
touch '.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial/.ok'
zk_rm '.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3'
mv '.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3.partial' '.test-tmp/repro2-qRvv8B/acp/qwen-code/0.22.3'
echo 'ZAKURA_ACP_INSTALLED:qwen-code:0.22.3' >&2