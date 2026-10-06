# Validation status

Last local validation: 2026-10-03 UTC.

## Passed locally

- `go test ./... -count=1`
- `go test -race ./... -count=1`
- `go vet ./...`
- Native builds of `zakura-server`, `zakura-db`, and the statically linked
  `zakura-stdio-bridge`
- Router inventory: 538 required rows, 538 registered rows, and 190 rows with
  direct focused HTTP URL evidence
- SQLite HTTP workflows for setup, authentication, tenant isolation, OAuth,
  OIDC SSO, social OAuth, MFA, SCIM, admin lifecycle, transactional email,
  avatars, usage rollups, runtime sessions/runs, ACP, MCP, Socket.IO, runner
  control, remote filesystem operations, stdio bridge lifecycle, channels,
  memory, skills, models, and integrations
- Full pinned Drizzle schema plus native migration parsed in PGlite: 541
  upstream statements and 88 native statements, producing 84 tables and 998
  columns; 769 complete production SQL literals prepared successfully
- Legacy SQLite migration test proves canonical Go writes after relaxing the
  old `component_instances` columns; runtime tests prove encrypted
  `config_enc` migration without plaintext disclosure

## External gates not run in this workspace

These remain required before calling a particular release artifact deployable:

- Real PostgreSQL 16/libpq migration and HTTP workflow. The repository-local
  `scripts/test-postgres.sh` and CI PostgreSQL service run this, but this
  workspace has neither a PostgreSQL server nor Docker
- Docker builds and health checks for all four `Dockerfile.stdio` targets. The
  CI workflow builds every target; this workspace has no Docker engine
- The expanded preserved-frontend Chromium workflow against the final tree.
  A smaller live frontend/Go browser pass succeeded earlier, while the final
  expanded workflow is prepared in `scripts/frontend-browser.mjs` and CI

The CI workflow template is stored at `.github/workflows/ci.yml`. When this
directory is integrated into an authorized repository, copy that workflow to
the repository root as documented in `README.md` so GitHub can discover it.
