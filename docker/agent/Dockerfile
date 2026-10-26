# syntax=docker/dockerfile:1.7
FROM --platform=$BUILDPLATFORM golang:1.26.4-bookworm AS build
WORKDIR /src
COPY apps/agent/go.mod apps/agent/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY apps/agent/ ./
ARG TARGETOS
ARG TARGETARCH
ARG ZAKURA_AGENT_VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -buildvcs=false -trimpath -ldflags="-s -w -X github.com/Moonrend/Zakura/apps/agent/internal/sys.Version=$ZAKURA_AGENT_VERSION" \
    -o /out/zakura-agent ./cmd/zakura-agent

FROM docker:29-cli
RUN apk add --no-cache bash ca-certificates curl git nodejs npm python3 tini
COPY --from=build /out/zakura-agent /usr/local/bin/zakura-agent
RUN mkdir -p /state /workspace-data
ENV ZAKURA_AGENT_KIND=server \
    ZAKURA_AGENT_STATE_DIR=/state \
    ZAKURA_AGENT_DATA_DIR=/workspace-data
WORKDIR /state
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/zakura-agent"]
