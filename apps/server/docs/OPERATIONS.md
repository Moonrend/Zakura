# Operations

## Health and shutdown

`GET /api/livez` reports process liveness. `GET /api/health` performs a bounded
database ping. SIGTERM and SIGINT start a 20-second graceful HTTP shutdown.
`HTTP_WRITE_TIMEOUT` defaults to `0` because cloud events, migration progress,
Socket.IO polling and other streaming responses may legitimately remain open;
set a finite value only if the deployment does not use those transports.

## Migrations

Migrations are embedded in the binary, executed in version order and committed
atomically. Disable automatic migration on ordinary replicas with
`AUTO_MIGRATE=false` after a release task has applied them.

## Recovery

Back up the SQL database and workspace volumes at one recovery point. Restoring
only one side can leave file-share, workspace and run metadata inconsistent.
After restore, start one replica with migrations enabled, verify `/api/health`,
then admit other replicas.

### SQLite

Create and verify an online, WAL-safe backup:

```sh
zakura-db backup -database "$DATABASE_URL" -out /backups/zakura-$(date -u +%Y%m%dT%H%M%SZ).db
zakura-db verify -file /backups/zakura-20261003T120000Z.db
```

Stop every Zakura server process before restoring. Restore keeps the previous
database beside the target with a `.pre-restore-<timestamp>` suffix:

```sh
zakura-db restore -database "$DATABASE_URL" -from /backups/zakura-20261003T120000Z.db
```

Restart one server, wait for migrations, verify `/api/health`, then verify a
known tenant, agent, session and workspace before resuming traffic.

### PostgreSQL

Use the PostgreSQL client version matching the server. Include large objects
and use a custom-format archive:

```sh
pg_dump --format=custom --no-owner --file=zakura.dump "$DATABASE_URL"
pg_restore --list zakura.dump >/dev/null
```

Restore into a new empty database first rather than overwriting the live one:

```sh
pg_restore --no-owner --exit-on-error --dbname="$RESTORE_DATABASE_URL" zakura.dump
ZAKURA_SECRET="$ZAKURA_SECRET" DATABASE_URL="$RESTORE_DATABASE_URL" AUTO_MIGRATE=true zakura-server
```

After health and application checks, switch traffic using the database
platform's normal promotion procedure. The CI workflow runs the complete
native migration and HTTP identity/onboarding workflow through `lib/pq`
against PostgreSQL 16, including an additive upgrade fixture for the pinned
TypeScript schema.

### Existing TypeScript installations

The native migrator recognizes the pinned Drizzle/PostgreSQL tables and adds
the compatibility columns before applying native migrations. It preserves the
original columns so rollback remains possible. Always take a SQL and workspace
snapshot first and rehearse the upgrade on a restored database.

Set `DATA_DIR` to the existing TypeScript data directory for the first Go
startup. If `oauth-signing.json` is present, the server imports that RS256 key
and stores it encrypted in SQL under the existing `ZAKURA_SECRET`; this keeps
the published JWKS identity and already-issued OAuth/OIDC tokens valid. Verify
that the `kid` returned by `/.well-known/jwks.json` is unchanged before routing
traffic. After a verified database backup, the file is no longer needed by the
Go service, though keeping it in the rollback snapshot is required.

Legacy stdio/MCP component rows are adopted lazily on startup: the runtime
decrypts `component_instances.config_enc` with the pinned TypeScript
scrypt/AES-GCM format, separates credentials into encrypted `secret_json`, and
writes a redacted `config_json`. Rows that cannot be decrypted are left intact
rather than discarded. The additive migration keeps the old columns for
rollback while making them nullable for canonical Go writes.

PGlite stores an embedded PostgreSQL data directory rather than exposing the
PostgreSQL wire protocol. Export a PGlite installation with the TypeScript
server's database export workflow, import that SQL into PostgreSQL, and then
start the Go server against the PostgreSQL URL. The Go server intentionally
rejects `pglite:` URLs instead of silently starting an empty database.

## Secret rotation

Changing `ZAKURA_SECRET` invalidates existing signed sessions and access tokens
and prevents decrypting secrets written with the old key. Perform key rotation
through an application migration that decrypts with the previous key and
rewrites with the new key; do not replace it in place without that migration.

## Stdio MCP bridge

The image includes the native `zakura-stdio-bridge` sidecar used by stdio MCP
component provisioning. It accepts the pinned environment contract:
`MCP_COMMAND` (required), `MCP_ARGS` (JSON string array), `MCP_CWD`, `MCP_PORT`
(default `3100`) and `MCP_PATH` (default `/mcp`). The bridge exposes `/health`
and `/`, plus Streamable HTTP POST/GET/DELETE on `MCP_PATH`, and terminates its
child on SIGTERM. Do not expose the bridge port publicly; the runtime node owns
its lifecycle and network boundary.

Build the command-runtime images locally with `make stdio-images`. Configure
the resulting (or equivalently published, immutable) tags with
`ZAKURA_STDIO_NODE_IMAGE`, `ZAKURA_STDIO_PYTHON_IMAGE`,
`ZAKURA_STDIO_OCI_IMAGE`, and optionally `ZAKURA_STDIO_BINARY_IMAGE`.
`ZAKURA_STDIO_BRIDGE_IMAGE` is a deployment-wide override. No legacy
TypeScript/backend image fallback is used: if the applicable image is absent,
stdio import fails explicitly. A request-level custom image is platform-admin
only and must already contain `/usr/local/bin/zakura-stdio-bridge` plus the
requested child command. Runtime provisioning verifies that the container
remains running and removes a failed container.
