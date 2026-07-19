# Pre-baked agent workspace: lean language toolchain + optional display/browser.
# Agent host dir is bind-mounted at /workspace (shared with fs_* tools).
FROM debian:bookworm-slim

ARG APT_MIRROR=http://mirrors.cloud.tencent.com
ARG TARGETARCH
ARG NODE_VERSION=22.14.0

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    LANG=C.UTF-8 \
    PATH=/usr/local/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NPM_CONFIG_CACHE=/workspace/.cache/npm \
    PIP_CACHE_DIR=/workspace/.cache/pip \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /workspace

# --- apt: system + python + build + CLI (no recommends) ---
RUN set -eux; \
  m="${APT_MIRROR}"; \
  m="${m%/}"; \
  m="${m#https://}"; \
  m="http://${m#http://}"; \
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
    'export PATH="/usr/local/node/bin:$PATH"' \
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

COPY entrypoint.sh /usr/local/bin/zakura-workspace
COPY capabilities.txt /etc/zakura/capabilities.txt
RUN chmod +x /usr/local/bin/zakura-workspace

ENTRYPOINT ["/usr/local/bin/zakura-workspace"]
