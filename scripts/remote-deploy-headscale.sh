#!/usr/bin/env bash
set -euo pipefail

echo "=== patch workspace image defaults ==="
cat > /tmp/patch-workspace-image.mjs <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";

const NEW = "sunwuyuan/zakura-workspace-dev:debian";
for (const p of [
  "/app/packages/shared/dist/index.js",
  "/app/packages/shared/dist/index.d.ts",
]) {
  try {
    const t = readFileSync(p, "utf8");
    writeFileSync(p, t.replaceAll("zakura/workspace:debian", NEW));
    console.log("updated", p);
  } catch (e) {
    console.warn("skip", p, e.message);
  }
}

const p = "/app/apps/server/dist/services/agent-workspace.js";
const text = readFileSync(p, "utf8");
const old = `export function resolveWorkspaceImage(configured) {
    const preferred = WORKSPACE_IMAGE_LOCAL || DEFAULT_WORKSPACE_IMAGE;
    const raw = (configured?.trim() || preferred).trim();
    return raw || preferred;
}
export function isPrebakedWorkspaceImage(image) {
    return /^zakura\\/workspace(?::|$)/i.test(image.trim());
}`;
const neu = `export function resolveWorkspaceImage(configured) {
    const fromEnv = process.env.ZAKURA_WORKSPACE_IMAGE?.trim();
    const preferred = fromEnv || WORKSPACE_IMAGE_LOCAL || DEFAULT_WORKSPACE_IMAGE;
    const raw = (configured?.trim() || preferred).trim() || preferred;
    if (/^zakura\\/workspace(?::|$)/i.test(raw)) return preferred;
    return raw;
}
export function isPrebakedWorkspaceImage(image) {
    const t = image.trim();
    return /^zakura\\/workspace(?::|$)/i.test(t) || /(?:^|\\/)zakura-workspace(?:-dev)?(?::|$)/i.test(t);
}`;
if (!text.includes(old)) {
  if (text.includes("ZAKURA_WORKSPACE_IMAGE")) {
    console.log("resolveWorkspaceImage already patched");
  } else {
    console.error("resolveWorkspaceImage block not found");
    process.exit(1);
  }
} else {
  writeFileSync(p, text.replace(old, neu));
  console.log("patched resolveWorkspaceImage");
}
EOF

docker cp /tmp/patch-workspace-image.mjs zakura:/tmp/patch-workspace-image.mjs
docker exec zakura node /tmp/patch-workspace-image.mjs

cat > /tmp/migrate-agents.mjs <<'EOF'
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite("/data/pglite");
await db.waitReady;
const before = await db.query("select id, workspace_image from agents");
console.log("agents before", JSON.stringify(before.rows));
await db.query(`
  update agents
  set workspace_image = 'sunwuyuan/zakura-workspace-dev:debian',
      updated_at = now()
  where workspace_image is null
     or workspace_image = ''
     or workspace_image like 'zakura/workspace%'
`);
const after = await db.query("select id, workspace_image from agents");
console.log("agents after", JSON.stringify(after.rows));
await db.close();
EOF
docker cp /tmp/migrate-agents.mjs zakura:/tmp/migrate-agents.mjs
docker exec -w /app/apps/server zakura node /tmp/migrate-agents.mjs

docker rm -f priceless_elbakyan 2>/dev/null || true
docker image prune -f >/dev/null || true
docker pull sunwuyuan/zakura-workspace-dev:debian
docker restart zakura
sleep 8
docker logs zakura --tail 12

echo "=== deploy headscale ==="
mkdir -p /opt/zakura-headscale/config /opt/zakura/docker/nginx
COOKIE="$(openssl rand -hex 16)"

cat > /opt/zakura-headscale/.env <<EOF
HEADSCALE_SERVER_URL=https://zakura-network.moonrend.com
HEADPLANE_BASE_URL=https://zakura-network.moonrend.com
HEADSCALE_HTTP_PORT=127.0.0.1:8080
HEADSCALE_METRICS_PORT=127.0.0.1:9090
HEADSCALE_GRPC_PORT=50443
HEADSCALE_STUN_PORT=3478
HEADPLANE_HTTP_PORT=127.0.0.1:3045
HEADSCALE_IMAGE=headscale/headscale:0.29.2
HEADPLANE_IMAGE=ghcr.io/tale/headplane:latest
TZ=UTC
HEADPLANE_COOKIE_SECRET=${COOKIE}
EOF

cp /tmp/zakura-deploy/headscale-docker-compose.yml /opt/zakura-headscale/docker-compose.yml
cp /tmp/zakura-deploy/headscale.yaml /opt/zakura-headscale/config/headscale.yaml
cp /tmp/zakura-deploy/policy.hujson /opt/zakura-headscale/config/policy.hujson
cp /tmp/zakura-deploy/headplane.yaml /opt/zakura-headscale/config/headplane.yaml
sed -i "s/CHANGE_ME_32_CHARS_COOKIE_SECRET!!/${COOKIE}/" /opt/zakura-headscale/config/headplane.yaml

cd /opt/zakura-headscale
docker compose pull
docker compose up -d headscale
for i in $(seq 1 40); do
  if docker compose exec -T headscale headscale health >/dev/null 2>&1; then
    echo healthy
    break
  fi
  sleep 2
done
docker compose exec -T headscale headscale users create platform@ || true
API_KEY="$(docker compose exec -T headscale headscale apikeys create --expiration 999d | tr -d '\r' | tail -n1)"
echo "API_KEY_PREFIX=${API_KEY:0:16}..."
sed -i "s|REPLACE_WITH_HEADSCALE_API_KEY|${API_KEY}|" /opt/zakura-headscale/config/headplane.yaml
echo "HEADSCALE_API_KEY=${API_KEY}" >> /opt/zakura-headscale/.env
docker compose up -d
sleep 5
docker compose ps
curl -sS http://127.0.0.1:8080/version; echo

cp /tmp/zakura-deploy/docker-compose.yml /opt/zakura/docker-compose.yml
cp /tmp/zakura-deploy/preview.conf /opt/zakura/docker/nginx/preview.conf
cp /tmp/zakura-deploy/zakura-network.conf /opt/zakura/docker/nginx/zakura-network.conf
cp /tmp/zakura-deploy/proxy_locations.conf /opt/zakura/docker/nginx/proxy_locations.conf
cat > /opt/zakura/.env <<'EOF'
ZAKURA_IMAGE=sunwuyuan/zakura-dev:latest
ZAKURA_EDITION=saas
ZAKURA_PUBLIC_URL=https://preview.moonrend.com
ZAKURA_WEB_URL=https://preview.moonrend.com
ZAKURA_WORKSPACE_IMAGE=sunwuyuan/zakura-workspace-dev:debian
ZAKURA_RUNNER_IMAGE=sunwuyuan/zakura-runner-dev:latest
EOF

cd /opt/zakura
docker network inspect zakura-headscale >/dev/null
docker compose up -d --force-recreate nginx
sleep 3
docker exec zakura-nginx nginx -t
echo "--- probe headscale via nginx ---"
curl -sk -o /dev/null -w 'hs_https=%{http_code}\n' -H 'Host: zakura-network.moonrend.com' https://127.0.0.1/
curl -sk -H 'Host: zakura-network.moonrend.com' https://127.0.0.1/version; echo
curl -sk -o /dev/null -w 'admin=%{http_code}\n' -H 'Host: zakura-network.moonrend.com' https://127.0.0.1/admin/
echo "--- verify shared image constants ---"
docker exec zakura grep -n 'WORKSPACE_IMAGE' /app/packages/shared/dist/index.js | head -5
docker exec zakura sed -n '26,42p' /app/apps/server/dist/services/agent-workspace.js
echo DONE
