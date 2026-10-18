#!/bin/sh
# Run from any directory. Default: an owned, ephemeral compose fixture. An
# existing disposable service is accepted only with --external (URL or DSN).
set -eu

server_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$server_dir"
external=0
case "${1:-}" in
  "") ;;
  --external) external=1; shift ;;
  *) printf '%s\n' 'usage: test-postgres.sh [--external]' >&2; exit 2 ;;
esac
[ "$#" -eq 0 ] || { printf '%s\n' 'unexpected arguments' >&2; exit 2; }

command -v go >/dev/null 2>&1 || { printf '%s\n' 'Go is required' >&2; exit 1; }

project=""
fixture_started=0
results_dir=$(mktemp -d)
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$fixture_started" -eq 1 ]; then
    docker compose -p "$project" -f "$server_dir/compose.postgres-test.yml" down --volumes || status=1
  fi
  rm -rf "$results_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$external" -eq 0 ]; then
  if [ -n "${ZAKURA_TEST_POSTGRES_URL:-}${ZAKURA_TEST_POSTGRES_DSN:-}" ]; then
    printf '%s\n' 'Refusing inherited PostgreSQL URL/DSN. Unset them for an owned compose fixture, or use --external for an explicitly disposable service.' >&2
    exit 2
  fi
  command -v docker >/dev/null 2>&1 || { printf '%s\n' 'Docker compose is required for the owned fixture' >&2; exit 1; }
  project="zakura-pgtest-$(basename "$results_dir" | tr '[:upper:].' '[:lower:]-')"
  fixture_started=1
  docker compose -p "$project" -f "$server_dir/compose.postgres-test.yml" up -d --wait --pull never
  address=$(docker compose -p "$project" -f "$server_dir/compose.postgres-test.yml" port postgres 5432)
  port=${address##*:}
  case "$port" in ''|*[!0-9]*) printf '%s\n' 'Invalid disposable PostgreSQL port' >&2; exit 1 ;; esac
  # Extension setup belongs to fixture provisioning, never shared test cleanup.
  docker compose -p "$project" -f "$server_dir/compose.postgres-test.yml" exec -T postgres psql -v ON_ERROR_STOP=1 -U pgtest -d zakura_pgtest -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm'
  export ZAKURA_TEST_POSTGRES_URL="postgres://pgtest:pgtest@127.0.0.1:$port/zakura_pgtest?sslmode=disable"
else
  [ -n "${ZAKURA_TEST_POSTGRES_URL:-}${ZAKURA_TEST_POSTGRES_DSN:-}" ] || { printf '%s\n' '--external requires ZAKURA_TEST_POSTGRES_URL or ZAKURA_TEST_POSTGRES_DSN' >&2; exit 2; }
fi
export ZAKURA_REQUIRE_POSTGRES=1
export CGO_ENABLED=1

run_required() {
  pattern=$1
  shift
  results="$results_dir/results.json"
  status=0
  go test -json -count=1 -timeout=5m "$@" -run "$pattern" >"$results" || status=$?
  check_status=0
  go run ./internal/platform/pgtest/cmd/check-results "$results" || check_status=$?
  [ "$status" -eq 0 ] || return "$status"
  return "$check_status"
}

# Exact selection keeps the archival snapshot gate separate and intentional.
run_required '^TestPostgresComputersSchema$' ./internal/platform/migrations
run_required '^TestPostgres' ./internal/computers ./internal/platform/agentconfig ./internal/platform/pgtest
run_required '^(TestPostgres|TestMemorySearchTrigram(Postgres|ProbeFailureCached)$)' ./internal/runtime
run_required '^TestPostgres(CoreWorkflow|LegacyCompatibility|GormConnection)$' ./integration
run_required '^TestPostgresEmailPackages' ./internal/integrations
if [ -n "${ZAKURA_REFERENCE_DRIZZLE_DIR:-}" ]; then
  run_required '^TestPostgresPinnedDrizzleUpgrade$' ./integration
else
  printf '%s\n' 'ARCHIVAL UPGRADE UNVERIFIED: set ZAKURA_REFERENCE_DRIZZLE_DIR to an immutable Drizzle snapshot to test the complete historical upgrade.'
fi
