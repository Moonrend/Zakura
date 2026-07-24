# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/saas/package.json packages/saas/
RUN pnpm install --frozen-lockfile=false

FROM deps AS build
COPY . .
RUN pnpm --filter @zakura/shared build \
 && pnpm --filter @zakura/core build \
 && pnpm --filter @zakura/saas build \
 && pnpm --filter @zakura/server build \
 && pnpm --filter @zakura/web build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV ZAKURA_DATA_DIR=/data
ENV HOST=0.0.0.0
ENV PORT=8787
RUN corepack enable \
 && apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates curl \
 && curl -fsSL -o /usr/local/bin/cloudflared \
      https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
 && chmod +x /usr/local/bin/cloudflared \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data

COPY --from=build /app /app

EXPOSE 8787 3000

CMD ["sh", "docker/start.sh"]
