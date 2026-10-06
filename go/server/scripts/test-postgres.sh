#!/bin/sh
set -eu

compose_file="${COMPOSE_FILE:-compose.postgres-test.yml}"
cleanup() { docker compose -f "$compose_file" down -v; }
trap cleanup EXIT INT TERM

docker compose -f "$compose_file" up -d --wait
reference_dir="${ZAKURA_REFERENCE_DRIZZLE_DIR:-}"
ZAKURA_TEST_POSTGRES_URL="${ZAKURA_TEST_POSTGRES_URL:-postgres://zakura:zakura-test-only@127.0.0.1:55432/zakura_test?sslmode=disable}" \
  ZAKURA_REFERENCE_DRIZZLE_DIR="$reference_dir" \
  CGO_ENABLED=1 go test -count=1 ./integration -run '^TestPostgres'
