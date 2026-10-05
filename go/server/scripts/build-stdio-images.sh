#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
docker build --file "$root/Dockerfile.stdio" --target npm --tag zakura/stdio-bridge-node:local "$root"
docker build --file "$root/Dockerfile.stdio" --target pypi --tag zakura/stdio-bridge-python:local "$root"
docker build --file "$root/Dockerfile.stdio" --target oci --tag zakura/stdio-bridge-oci:local "$root"
docker build --file "$root/Dockerfile.stdio" --target binary --tag zakura/stdio-bridge-binary:local "$root"

cat <<'EOF'
Built native stdio bridge images. Configure the backend with:
  ZAKURA_STDIO_NODE_IMAGE=zakura/stdio-bridge-node:local
  ZAKURA_STDIO_PYTHON_IMAGE=zakura/stdio-bridge-python:local
  ZAKURA_STDIO_OCI_IMAGE=zakura/stdio-bridge-oci:local
  ZAKURA_STDIO_BINARY_IMAGE=zakura/stdio-bridge-binary:local
EOF
