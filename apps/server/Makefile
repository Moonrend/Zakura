GO ?= go

.PHONY: fmt test race vet build stdio-images scanlint
scanlint:
	CGO_ENABLED=1 $(GO) run -tags tools ./tools/scanlint
fmt:
	$(GO) fmt ./...

test:
	CGO_ENABLED=1 $(GO) test ./...

race:
	CGO_ENABLED=1 $(GO) test -race ./internal/platform/... ./internal/runtime/... ./internal/integrations/...

vet:
	CGO_ENABLED=1 $(GO) vet ./...

build:
	CGO_ENABLED=1 $(GO) build -buildvcs=false -trimpath -ldflags='-s -w' -o bin/zakura-server ./cmd/zakura-server
	CGO_ENABLED=1 $(GO) build -buildvcs=false -trimpath -ldflags='-s -w' -o bin/zakura-db ./cmd/zakura-db
	CGO_ENABLED=1 $(GO) build -buildvcs=false -trimpath -ldflags='-s -w' -o bin/zakura-stdio-bridge ./cmd/zakura-stdio-bridge

stdio-images:
	./scripts/build-stdio-images.sh
