# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM golang:1.23-bookworm AS agent
WORKDIR /src
ARG ZAKURA_AGENT_VERSION=dev
ENV ZAKURA_AGENT_VERSION=$ZAKURA_AGENT_VERSION
COPY go/agent/ ./
RUN bash scripts/pack.sh

FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go/server/go.mod go/server/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY go/server/ ./
RUN --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=1 go build -buildvcs=false -trimpath -ldflags='-s -w' -o /out/zakura-server ./cmd/zakura-server && \
    CGO_ENABLED=1 go build -buildvcs=false -trimpath -ldflags='-s -w' -o /out/zakura-db ./cmd/zakura-db && \
    CGO_ENABLED=1 go build -buildvcs=false -trimpath -ldflags='-s -w' -o /out/zakura-stdio-bridge ./cmd/zakura-stdio-bridge

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libsqlite3-0 tzdata && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --create-home zakura && mkdir -p /data /app && chown zakura:zakura /data /app
COPY --from=build /out/zakura-server /usr/local/bin/zakura-server
COPY --from=build /out/zakura-db /usr/local/bin/zakura-db
COPY --from=build /out/zakura-stdio-bridge /usr/local/bin/zakura-stdio-bridge
COPY --from=agent /src/dist /app/go/agent/dist
USER zakura
WORKDIR /data
ENV LISTEN_ADDR=:8787 \
    DATABASE_URL=file:/data/zakura.db \
    DATA_DIR=/data \
    ZAKURA_AGENT_BINARIES_DIR=/app/go/agent/dist
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/zakura-server"]
