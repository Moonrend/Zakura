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

# ACP adapters pinned into the default workspace image (no runtime npm i -g).
# Versions are whatever the registry serves at image build; do not chase latest in the agent container.
RUN set -eux; \
  mkdir -p /opt/zakura/acp /tmp/npm-cache /tmp/pip-cache; \
  NPM_CONFIG_CACHE=/tmp/npm-cache npm install -g --prefix /opt/zakura/acp \
    @agentclientprotocol/codex-acp \
    @agentclientprotocol/claude-agent-acp \
    @google/gemini-cli \
    opencode-ai \
    @github/copilot \
    @xai-official/grok \
    @moonshot-ai/kimi-code \
    @earendil-works/pi-coding-agent \
    pi-acp \
    @openai/codex; \
  PIP_CACHE_DIR=/tmp/pip-cache pip3 install --no-cache-dir 'hermes-agent[acp]'; \
  if command -v hermes >/dev/null 2>&1 && [ ! -x /opt/zakura/acp/bin/hermes-acp ]; then \
    printf '%s\n' '#!/bin/sh' 'exec hermes acp "$@"' >/opt/zakura/acp/bin/hermes-acp; \
    chmod +x /opt/zakura/acp/bin/hermes-acp; \
  elif [ ! -x /opt/zakura/acp/bin/hermes-acp ]; then \
    printf '%s\n' '#!/bin/sh' 'exec python3 -m hermes_acp "$@"' >/opt/zakura/acp/bin/hermes-acp; \
    chmod +x /opt/zakura/acp/bin/hermes-acp; \
  fi; \
  command -v codex-acp; \
  command -v claude-agent-acp; \
  command -v gemini; \
  command -v hermes-acp; \
  command -v opencode; \
  command -v copilot; \
  command -v grok; \
  command -v kimi; \
  command -v pi; \
  command -v pi-acp; \
  rm -rf /tmp/npm-cache /tmp/pip-cache /root/.cache /root/.npm

COPY entrypoint.sh /usr/local/bin/zakura-workspace
COPY capabilities.txt /etc/zakura/capabilities.txt
RUN chmod +x /usr/local/bin/zakura-workspace

ENTRYPOINT ["/usr/local/bin/zakura-workspace"]
