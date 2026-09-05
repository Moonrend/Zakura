# ACP adapter image.
#
# One image per adapter. The adapter itself is PID 1 and speaks ACP JSON-RPC
# over stdin/stdout, which is what ContainerRuntime.attachStdio connects to.
# There is no supervisor and no shell wrapper in the hot path: anything written
# to stdout that is not JSON-RPC will corrupt the protocol stream.
#
# Base is bookworm-slim (glibc), NOT alpine. Upstream registry binaries are
# built for x86_64-unknown-linux-gnu and segfault or fail to link on musl.
FROM node:22-bookworm-slim

# ACP_KIND is one of: npx | uvx | binary
ARG ACP_ID
ARG ACP_KIND
ARG ACP_PACKAGE=""
ARG ACP_ARCHIVE=""
ARG ACP_SHA256=""
ARG ACP_CMD=""
ARG ACP_VERSION=""
# args/env come straight from the registry as JSON. They are parsed inside the
# installer (with node, which is already present) rather than re-quoted through
# a shell string, which is where this kind of plumbing usually corrupts values.
ARG ACP_ARGS="[]"
ARG ACP_ENV="{}"

ENV ACP_ID=${ACP_ID} \
    ACP_KIND=${ACP_KIND} \
    ACP_VERSION=${ACP_VERSION} \
    ACP_HOME=/opt/zakura/acp \
    PATH=/opt/zakura/acp/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_NO_WARNINGS=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# ca-certificates: TLS to model APIs. git: agents that inspect repo state.
# ripgrep: several agents shell out to `rg` for search.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        file \
        git \
        ripgrep \
        tar \
        gzip \
        bzip2 \
        unzip \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/zakura/acp/bin /workspace

COPY install-adapter.sh /usr/local/bin/install-adapter
COPY acp-entrypoint.sh /usr/local/bin/acp-entrypoint
RUN chmod +x /usr/local/bin/install-adapter /usr/local/bin/acp-entrypoint

# Installs the adapter AND bakes ${ACP_HOME}/etc/{argv,env}. Only this step can
# resolve the real executable path: npm bin names are not derivable from the
# package name, and archive layouts vary per release.
RUN ACP_ARGS="${ACP_ARGS}" ACP_ENV="${ACP_ENV}" /usr/local/bin/install-adapter \
    && test -s "${ACP_HOME}/etc/argv" \
    && test -x "$(head -n1 "${ACP_HOME}/etc/argv")"

# Credentials live on a per-adapter volume mounted here, so they survive
# container replacement and stay isolated between adapters.
ENV HOME=/home/acp
RUN mkdir -p /home/acp && chmod 700 /home/acp
VOLUME ["/home/acp"]

WORKDIR /workspace

# The adapter is the container command; entrypoint only execs into it.
ENTRYPOINT ["/usr/local/bin/acp-entrypoint"]
