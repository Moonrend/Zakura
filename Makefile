GO_SERVER_DIR := go/server

.PHONY: fmt test build images

fmt:
	cd $(GO_SERVER_DIR) && $(MAKE) fmt

test:
	cd $(GO_SERVER_DIR) && $(MAKE) test
	pnpm test

build:
	cd $(GO_SERVER_DIR) && $(MAKE) build

images:
	docker build -f docker/server/Dockerfile -t sunwuyuan/zakura-server:local .
	docker build -f docker/web/Dockerfile -t sunwuyuan/zakura-web:local .
