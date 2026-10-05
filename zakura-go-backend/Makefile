GO ?= go
REFERENCE ?= ../zakura-rewrite/docs/ROUTE_ACCEPTANCE.md

.PHONY: fmt test race vet build stdio-images route-ledger
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

route-ledger:
	CGO_ENABLED=1 $(GO) run ./cmd/route-inventory -reference $(REFERENCE) -output docs/ROUTE_PARITY.md
