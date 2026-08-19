FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends tar zstd curl ca-certificates \
  && curl -fsSL -o /usr/local/bin/cloudflared \
       https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  && chmod +x /usr/local/bin/cloudflared \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Runner version is resolved at runtime from package.json (see apps/runner/src/version.ts),
# unless overridden by build arg ZAKURA_RUNNER_VERSION.
ARG ZAKURA_RUNNER_VERSION
ENV ZAKURA_RUNNER_VERSION=${ZAKURA_RUNNER_VERSION}

# Monorepo subset — build context should be repo root
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/runner ./apps/runner
COPY tsconfig.base.json ./

RUN corepack enable && pnpm install --frozen-lockfile --filter @zakura/runner... \
  && pnpm --filter @zakura/shared build \
  && pnpm --filter @zakura/core build

ENV ZAKURA_RUNNER_PORT=7443
ENV ZAKURA_RUNNER_STORAGE_ROOT=/var/lib/zakura
EXPOSE 7443

CMD ["pnpm", "--filter", "@zakura/runner", "start"]
