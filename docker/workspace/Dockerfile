# Pre-baked agent workspace: lean language toolchain + optional display/browser.
# Agent host dir is bind-mounted at /workspace (shared with fs_* tools).
FROM debian:bookworm-slim

ARG APT_MIRROR=https://mirrors.cloud.tencent.com
ARG TARGETARCH
ARG NODE_VERSION=22.14.0

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    LANG=C.UTF-8 \
    PATH=/opt/zakura/acp/bin:/usr/local/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NPM_CONFIG_CACHE=/workspace/.cache/npm \
    PIP_CACHE_DIR=/workspace/.cache/pip \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /workspace

# --- apt: certs first (HTTPS mirrors), then toolchain ---
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates; \
  m="${APT_MIRROR}"; \
  m="${m%/}"; \
  if [ -n "$m" ]; then \
    case "$m" in \
      http://*|https://*) ;; \
      *) m="https://${m}" ;; \
    esac; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      printf '%s\n' \
        'Types: deb' \
        "URIs: ${m}/debian" \
        'Suites: bookworm bookworm-updates' \
        'Components: main contrib non-free non-free-firmware' \
        'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
        '' \
        'Types: deb' \
        "URIs: ${m}/debian-security" \
        'Suites: bookworm-security' \
        'Components: main contrib non-free non-free-firmware' \
        'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
        >/etc/apt/sources.list.d/debian.sources; \
    fi; \
    apt-get update; \
  fi; \
  apt-get install -y --no-install-recommends \
    ca-certificates curl wget socat unzip zip gnupg procps \
    git openssh-client \
    build-essential pkg-config \
    python3 python3-pip python3-venv \
    jq sqlite3 file less vim-tiny tree \
    ripgrep fd-find \
    xvfb openbox xdotool scrot imagemagick x11-apps \
    fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fontconfig \
    x11vnc novnc websockify \
    chromium; \
  ln -sf "$(command -v fdfind)" /usr/local/bin/fd; \
  ln -sf "$(command -v python3)" /usr/local/bin/python; \
  printf '%s\n' \
    'export PATH="/opt/zakura/acp/bin:/usr/local/node/bin:$PATH"' \
    'export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-/workspace/.cache/npm}"' \
    'export PIP_CACHE_DIR="${PIP_CACHE_DIR:-/workspace/.cache/pip}"' \
    'export PIP_BREAK_SYSTEM_PACKAGES=1' \
    >/etc/profile.d/zakura-path.sh; \
  fc-cache -f; \
  rm -rf /var/lib/apt/lists/*; \
  mkdir -p /workspace /tmp/.X11-unix /var/log/zakura /tmp/zakura-chrome /etc/zakura; \
  chmod 1777 /tmp/.X11-unix /workspace

# --- Node.js official binary (smaller/cleaner than apt node+npm graph) ---
RUN set -eux; \
  arch="${TARGETARCH:-amd64}"; \
  case "$arch" in \
    amd64|x86_64) node_arch=x64 ;; \
    arm64|aarch64) node_arch=arm64 ;; \
    *) echo "unsupported arch: $arch"; exit 1 ;; \
  esac; \
  curl -fsSL "https://npmmirror.com/mirrors/node/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    -o /tmp/node.tar.xz \
  || curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    -o /tmp/node.tar.xz; \
  mkdir -p /usr/local/node; \
  tar -xJf /tmp/node.tar.xz -C /usr/local/node --strip-components=1; \
  rm -f /tmp/node.tar.xz; \
  ln -sf /usr/local/node/bin/node /usr/local/bin/node; \
  ln -sf /usr/local/node/bin/npm /usr/local/bin/npm; \
  ln -sf /usr/local/node/bin/npx /usr/local/bin/npx; \
  node -v; npm -v

# --- ACP: install the *toolchain*, not the adapters ---
#
# Adapters used to be baked in here: ~10 npm packages, a pip package and a
# `curl | bash` installer, all in one layer. That made the image large for everyone
# (you carried every adapter whether you used one or none), and it coupled two
# unrelated lifecycles — bumping a single adapter meant rebuilding and re-pulling a
# multi-GB image, and because it was one layer, nothing could be reused.
#
# Adapters are now provisioned on demand into /workspace/.zakura/acp/<id>/<version>/
# (see packages/shared/src/acp-provision.ts). /workspace is the bind mount, so
# installs survive container recreation: refreshing the image no longer discards
# adapters, and updating an adapter no longer touches the image. The catalogue comes
# from the upstream ACP registry, so new agents need no image release at all.
#
# What must be present for that to work: node/npm (npx distributions), uv (uvx
# distributions), plus curl/unzip/tar and sha256sum for signed binaries — all of
# which the layers above already provide except uv.
RUN set -eux; \
  mkdir -p /opt/zakura/acp/bin; \
  curl -fsSL https://astral.sh/uv/install.sh | \
    env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh; \
  uv --version; \
  # Verified once at build time so a broken base image fails here, not on a
  # user's first ACP launch.
  command -v node; command -v npm; command -v sha256sum; command -v unzip; \
  rm -rf /root/.cache /root/.npm

COPY entrypoint.sh /usr/local/bin/zakura-workspace
COPY capabilities.txt /etc/zakura/capabilities.txt
RUN chmod +x /usr/local/bin/zakura-workspace

ENTRYPOINT ["/usr/local/bin/zakura-workspace"]
