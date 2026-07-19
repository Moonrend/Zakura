FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends tar zstd curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

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
