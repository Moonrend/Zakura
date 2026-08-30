# Multi-stage workspace: "base" (shell + toolchain) and "full" (+ display/browser).
#
# Build targets:
#   docker build --target base -t zakura-workspace-lite .
#   docker build --target full -t zakura-workspace       .     (default)
#
# Agent workspace containers use the lite image when only shell/ACP is needed
# (coding agents), and the full image when display/browser/computer-use is on.

# ═══════════════════════════════════════════════════════════════════════════════
# Stage 1 — base: lean language toolchain for shell / ACP / MCP workloads
# ═══════════════════════════════════════════════════════════════════════════════
FROM debian:bookworm-slim AS base

ARG APT_MIRROR=https://mirrors.cloud.tencent.com
ARG TARGETARCH
ARG NODE_VERSION=22.14.0

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PATH=/opt/zakura/acp/bin:/usr/local/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NPM_CONFIG_CACHE=/workspace/.cache/npm \
    PIP_CACHE_DIR=/workspace/.cache/pip \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /workspace

# --- apt: certs first (HTTPS mirrors), then base toolchain ---
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
    python3 python3-pip python3-venv \
    jq sqlite3 file less vim-tiny tree \
    ripgrep fd-find; \
  ln -sf "$(command -v fdfind)" /usr/local/bin/fd; \
  ln -sf "$(command -v python3)" /usr/local/bin/python; \
  printf '%s\n' \
    'export PATH="/opt/zakura/acp/bin:/usr/local/node/bin:$PATH"' \
    'export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-/workspace/.cache/npm}"' \
    'export PIP_CACHE_DIR="${PIP_CACHE_DIR:-/workspace/.cache/pip}"' \
    'export PIP_BREAK_SYSTEM_PACKAGES=1' \
    >/etc/profile.d/zakura-path.sh; \
  rm -rf /var/lib/apt/lists/*; \
  mkdir -p /workspace /var/log/zakura /etc/zakura; \
  chmod 1777 /workspace

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

# --- ACP toolchain (adapters provisioned on demand, not baked in) ---
RUN set -eux; \
  mkdir -p /opt/zakura/acp/bin; \
  curl -fsSL https://astral.sh/uv/install.sh | \
    env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh; \
  uv --version; \
  command -v node; command -v npm; command -v sha256sum; command -v unzip; \
  rm -rf /root/.cache /root/.npm

COPY entrypoint-base.sh /usr/local/bin/zakura-workspace-base
COPY capabilities.txt /etc/zakura/capabilities.txt
RUN chmod +x /usr/local/bin/zakura-workspace-base

ENTRYPOINT ["/usr/local/bin/zakura-workspace-base"]

# ═══════════════════════════════════════════════════════════════════════════════
# Stage 2 — full: display / browser / computer-use (inherits everything above)
# ═══════════════════════════════════════════════════════════════════════════════
FROM base AS full

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    build-essential pkg-config \
    xvfb openbox xdotool scrot imagemagick x11-apps \
    fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fontconfig \
    x11vnc novnc websockify \
    chromium; \
  fc-cache -f; \
  rm -rf /var/lib/apt/lists/*; \
  mkdir -p /tmp/.X11-unix /tmp/zakura-chrome; \
  chmod 1777 /tmp/.X11-unix

ENV DISPLAY=:99

COPY entrypoint.sh /usr/local/bin/zakura-workspace
RUN chmod +x /usr/local/bin/zakura-workspace

ENTRYPOINT ["/usr/local/bin/zakura-workspace"]
