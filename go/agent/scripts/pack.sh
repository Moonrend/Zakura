#!/bin/sh
# 打出控制面 / 安装脚本认的文件名：zakura-agent_{os}_{arch}[.exe]
set -eu
cd "$(dirname "$0")/.."
ver="${ZAKURA_AGENT_VERSION:-}"
if [ -z "$ver" ]; then
  ver="${GITHUB_REF_NAME:-}"
fi
ver="${ver#v}"
if [ -z "$ver" ] || [ "$ver" = "main" ] || [ "$ver" = "master" ]; then
  ver="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
fi
# workflow_dispatch / 分支构建传入的是完整 SHA
if echo "$ver" | grep -Eq '^[0-9a-f]{40}$'; then
  ver="$(echo "$ver" | cut -c1-7)"
fi
mkdir -p dist
for os in linux darwin windows; do
  for arch in amd64 arm64; do
    ext=""
    [ "$os" = windows ] && ext=".exe"
    out="dist/zakura-agent_${os}_${arch}${ext}"
    echo "$os/$arch -> $out"
    CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build \
      -ldflags "-s -w -X zakura.dev/agent/internal/sys.Version=${ver}" \
      -o "$out" ./cmd/zakura-agent
  done
done
printf '%s\n' "$ver" > dist/VERSION
(
  cd dist
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum zakura-agent_* > checksums.txt
  else
    python3 - <<'PY'
import hashlib, pathlib
lines = []
for p in sorted(pathlib.Path('.').glob('zakura-agent_*')):
    h = hashlib.sha256(p.read_bytes()).hexdigest()
    lines.append(f"{h}  {p.name}")
pathlib.Path('checksums.txt').write_text('\n'.join(lines) + '\n')
PY
  fi
)
echo "packed version=$ver"
ls -l dist
