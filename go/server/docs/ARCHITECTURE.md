# Architecture

The primary binary is a native Go HTTP service. `cmd/zakura-server` owns
configuration, migrations, process lifecycle and graceful shutdown;
`cmd/zakura-stdio-bridge` is the native, isolated stdio-MCP sidecar launched by
runtime-node component provisioning.

- `internal/platform`: database, migrations, HTTP middleware, identity,
  tenancy, OAuth, SCIM, usage and SaaS administration
- `internal/runtime`: agents, Spaces, sessions, durable event/run queues,
  automations, interactions, model gateways, MCP, skills, memory and workspace
  operations
- `internal/integrations`: connector catalogs, encrypted profiles,
  installations, OAuth state and retry-safe inbound/outbound channel delivery

Every durable aggregate is stored in SQL. Tenant IDs are included in business
queries and ownership checks. Session tokens, authorization codes, refresh
tokens, API keys and SCIM tokens are stored only as hashes. Connector, SSO and
provider secrets are encrypted before persistence. HTTP dependencies expose an
injectable clock, ID generator, SQL rebinder and external verifier so tests use
real SQL and HTTP with deterministic external fakes.

OAuth/OIDC access and ID tokens use a durable RS256 key. Existing TypeScript
`oauth-signing.json` state is imported on first start, then encrypted in SQL so
all replicas publish the same JWKS. Client Identifier Metadata Documents and
private-key JWT authentication are fetched with public-HTTPS/SSRF controls and
bounded responses.

SQLite provides a zero-service local mode with one database writer connection.
PostgreSQL provides the production multi-replica path. Migrations are ordered,
transactional and recorded in `schema_migrations`.
