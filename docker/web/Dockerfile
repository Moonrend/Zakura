# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/oauth-bridge/package.json apps/oauth-bridge/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY . .
ARG ZAKURA_API_URL=http://server:8787
ENV ZAKURA_API_URL=$ZAKURA_API_URL
RUN pnpm --filter @zakura/shared build \
 && pnpm --filter @zakura/web build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    HOSTNAME=0.0.0.0
RUN useradd --system --uid 10001 --create-home nextjs
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
USER nextjs
EXPOSE 3001
CMD ["node", "apps/web/server.js"]
