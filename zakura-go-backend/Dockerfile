# syntax=docker/dockerfile:1.7
FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=1 go build -buildvcs=false -trimpath -ldflags='-s -w' -o /out/zakura-server ./cmd/zakura-server && \
    CGO_ENABLED=1 go build -buildvcs=false -trimpath -ldflags='-s -w' -o /out/zakura-db ./cmd/zakura-db && \
    CGO_ENABLED=1 go build -buildvcs=false -trimpath -ldflags='-s -w' -o /out/zakura-stdio-bridge ./cmd/zakura-stdio-bridge

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 tzdata && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --create-home zakura && mkdir -p /var/lib/zakura && chown zakura:zakura /var/lib/zakura
COPY --from=build /out/zakura-server /usr/local/bin/zakura-server
COPY --from=build /out/zakura-db /usr/local/bin/zakura-db
COPY --from=build /out/zakura-stdio-bridge /usr/local/bin/zakura-stdio-bridge
USER zakura
WORKDIR /var/lib/zakura
ENV LISTEN_ADDR=:8787 DATABASE_URL=file:/var/lib/zakura/zakura.db DATA_DIR=/var/lib/zakura AUTO_MIGRATE=true
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/zakura-server"]
