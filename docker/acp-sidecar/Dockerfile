# Minimal ACP sidecar: runs adapter binaries (claude-code, codex, opencode …)
# via docker exec. No display / browser / fonts — pure CLI.
# Target compressed size: <150 MB.
FROM node:22-alpine

ARG APK_MIRROR
ARG TARGETARCH

ENV PATH=/opt/zakura/acp/bin:/usr/local/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NPM_CONFIG_CACHE=/workspace/.cache/npm \
    PIP_CACHE_DIR=/workspace/.cache/pip \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /workspace

# --- apk: optional mirror, then toolchain ---
RUN set -eux; \
  if [ -n "${APK_MIRROR:-}" ]; then \
    m="${APK_MIRROR%/}"; \
    case "$m" in \
      http://*|https://*) ;; \
      *) m="https://${m}" ;; \
    esac; \
    sed -i "s|https://dl-cdn.alpinelinux.org|${m}|g" /etc/apk/repositories; \
  fi; \
  apk add --no-cache \
    bash \
    curl \
    unzip \
    tar \
    git \
    python3 \
    py3-pip \
    coreutils; \
  ln -sf "$(command -v python3)" /usr/local/bin/python; \
  rm -rf /var/cache/apk/*

# --- uv (for uvx-distributed adapters like aider, goose) ---
RUN set -eux; \
  curl -fsSL https://astral.sh/uv/install.sh | \
    env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh; \
  uv --version

# --- ACP directory + verification ---
#
# Adapters are provisioned on demand into /workspace/.zakura/acp/<id>/<version>/
# (see packages/shared/src/acp-provision.ts). The bind-mounted /workspace
# survives container recreation so installs persist across image updates.
#
# Build-time verification ensures every required tool exists before the image
# ships — a broken base fails here, not on a user's first ACP launch.
RUN set -eux; \
  mkdir -p /opt/zakura/acp/bin; \
  command -v node; command -v npm; command -v sha256sum; \
  command -v unzip; command -v curl; command -v git; \
  command -v python3; command -v uv; \
  rm -rf /root/.cache /root/.npm /tmp/*

# --- profile: make PATH available to docker exec shells ---
RUN printf '%s\n' \
    'export PATH="/opt/zakura/acp/bin:/usr/local/node/bin:$PATH"' \
    'export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-/workspace/.cache/npm}"' \
    'export PIP_CACHE_DIR="${PIP_CACHE_DIR:-/workspace/.cache/pip}"' \
    'export PIP_BREAK_SYSTEM_PACKAGES=1' \
    >/etc/profile.d/zakura-path.sh

COPY entrypoint.sh /usr/local/bin/zakura-acp-sidecar
RUN chmod +x /usr/local/bin/zakura-acp-sidecar

ENTRYPOINT ["/usr/local/bin/zakura-acp-sidecar"]
