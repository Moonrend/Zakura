# Zakura Go backend

Native Go rewrite of the Zakura server, derived from Moonrend/Zakura and
licensed under AGPL-3.0. The existing Zakura frontend can use this server
without a TypeScript backend process.

The published Go module path is
`github.com/Moonrend/Zakura/go/server`.

The production backend image contains no Node.js runtime or TypeScript server
artifact. Node/pnpm appears only in the optional preserved-frontend browser CI
job; user-configured stdio MCP commands remain external component processes.

## Run locally

```sh
export ZAKURA_SECRET='replace-with-at-least-32-random-bytes'
export DATABASE_URL='file:./data/zakura.db'
export DATA_DIR='./data'
export PUBLIC_BASE_URL='http://localhost:8787'
export WEB_PUBLIC_URL='http://localhost:3000'
go run ./cmd/zakura-server
```

`DATABASE_URL` accepts a SQLite file URL or a PostgreSQL URL. Ordered,
transactional migrations run on startup unless `AUTO_MIGRATE=false`. The
server fails closed when its session secret or URLs are invalid.

For the preserved frontend, configure its API/server URL to
`PUBLIC_BASE_URL`. Public HTTP paths, bearer-session authentication, tenant
scoping, OAuth 2.1 endpoints, SSE streams and JSON response envelopes are kept
compatible with the pinned Zakura contract.

## Validate

```sh
make test
make race
make vet
make route-ledger REFERENCE=../zakura-rewrite/docs/ROUTE_ACCEPTANCE.md
make build
# Requires Docker; builds the Node, Python/uv, OCI and binary stdio sidecars.
make stdio-images
```

Run the real PostgreSQL wire/transaction workflow locally with Docker Compose:

```sh
./scripts/test-postgres.sh
```

The route ledger compares the actual Chi router with the 474-row core manifest,
46 routes dynamically loaded from the pinned SaaS package, and 18 public routes
that the original manifest missed because they live behind mounted Hono
subrouters. Registration is not treated as proof of behavioral parity; focused
HTTP test evidence is tracked independently. Non-literal WebSocket, Engine.IO,
MCP and sidecar surfaces are tracked in `docs/PROTOCOL_PARITY.md`.

`./.github/workflows/ci.yml` is the publication template. GitHub discovers
workflows only at the repository root, so an authorized integration of this
subfolder must copy it to root `.github/workflows/go-backend-ci.yml`
without changing its `go/server` working directory. The template runs
real PostgreSQL/pgvector upgrades, the expanded preserved-frontend browser
flow, race/vet/build, and all native stdio sidecar image builds.

## Production configuration

- Use PostgreSQL for multi-replica SaaS installations
- Generate a high-entropy `ZAKURA_SECRET` and deliver it through the platform's
  secret manager
- Set the canonical HTTPS `PUBLIC_BASE_URL` and `WEB_PUBLIC_URL`
- Keep migrations enabled for a single release task, or run them once before
  rolling out application replicas
- Terminate TLS at a trusted proxy and preserve the original client IP headers
- Use `/api/livez` for liveness and `/api/health` for database readiness
- Back up the database and any runtime workspace volumes together

No deployment, external provider credential use or paid provider call is part
of the local test workflow.
