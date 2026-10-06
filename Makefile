SERVER_DIR := apps/server
AGENT_DIR := apps/agent

.PHONY: dev fmt test build agent images stdio-images

dev:
	pnpm dev

fmt:
	cd $(SERVER_DIR) && $(MAKE) fmt
	cd $(AGENT_DIR) && go fmt ./...

test:
	cd $(SERVER_DIR) && $(MAKE) test
	cd $(AGENT_DIR) && CGO_ENABLED=0 go test ./...
	pnpm test

build:
	cd $(SERVER_DIR) && $(MAKE) build
	pnpm -r build

agent:
	cd $(AGENT_DIR) && bash scripts/pack.sh

images:
	docker build -f docker/server/Dockerfile -t sunwuyuan/zakura-server:local .
	docker build -f docker/web/Dockerfile -t sunwuyuan/zakura-web:local .

stdio-images:
	./$(SERVER_DIR)/scripts/build-stdio-images.sh
