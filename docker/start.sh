#!/bin/sh
set -e
pnpm --filter @zakura/server db:migrate
pnpm --filter @zakura/web start &
exec node apps/server/dist/index.js
