/** Runner Agent + workspace migration shared types */

export const LOCAL_RUNTIME_NODE_ID = "local";

export type RuntimeNodeKind = "local" | "runner";
export type RuntimeNodeStatus = "online" | "offline" | "draining";

export type WorkspaceStatus = "ready" | "locked" | "migrating";

export type MigrationJobStatus =
  | "pending"
  | "exporting"
  | "transferring"
  | "importing"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunnerNetworkInterface {
  name: string;
  mac?: string;
  ipv4: string[];
  ipv6: string[];
  /** lo / docker* / veth* / br-* */
  internal: boolean;
  operstate?: string;
}

export interface RunnerTailscaleInfo {
  connected: boolean;
  ip?: string;
  magicDnsName?: string;
  hostname?: string;
  tags?: string[];
}

export interface RunnerHostInfo {
  hostname: string;
  platform: string;
  arch: string;
  primaryIp?: string;
  interfaces: RunnerNetworkInterface[];
  publicUrl?: string;
  dockerVersion?: string;
  storageRoot: string;
  disk?: { totalBytes: number; freeBytes: number };
  /** Present when Runner has joined a Tailscale tailnet */
  tailscale?: RunnerTailscaleInfo;
}

export interface RuntimeNodeDto {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  kind: RuntimeNodeKind;
  status: RuntimeNodeStatus;
  endpoint: string | null;
  capabilities: Record<string, unknown>;
  hostInfo: RunnerHostInfo | Record<string, unknown>;
  storageRoot: string;
  agentVersion: string | null;
  lastSeenAt: string | null;
  labels: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MigrationManifestFile {
  path: string;
  size: number;
  sha256: string;
  mode?: string;
}

export interface MigrationManifest {
  version: 1;
  agentId: string;
  exportedAt: string;
  sourceNodeId: string;
  compression: "zstd" | "gzip" | "none";
  excludePatterns: string[];
  files: MigrationManifestFile[];
  totalBytes: number;
  fileCount: number;
}

export interface WorkspaceMigrationDto {
  id: string;
  tenantId: string;
  agentId: string;
  sourceNodeId: string;
  targetNodeId: string;
  status: MigrationJobStatus;
  phase: string | null;
  progressPct: number;
  message: string | null;
  archivePath: string | null;
  archiveSize: number | null;
  archiveSha256: string | null;
  excludePatterns: string[];
  sourceRetained: boolean;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Default exclude globs for workspace migration (see plan §3.5). */
export const DEFAULT_MIGRATION_EXCLUDE_PATTERNS: readonly string[] = [
  ".cache/",
  "**/.cache/",
  "**/node_modules/",
  "**/.npm/",
  "**/.pnpm-store/",
  "**/.yarn/",
  "**/.venv/",
  "**/venv/",
  "**/__pycache__/",
  "**/.pytest_cache/",
  "**/.mypy_cache/",
  "**/.tox/",
  "**/target/",
  "**/.gradle/",
  "**/.m2/",
  "**/vendor/",
  "**/.git/objects/",
  "**/.git/lfs/",
  "**/.next/",
  "**/.nuxt/",
  "**/.turbo/",
  "**/dist/",
  "**/build/",
  "**/.chrome-user-data/",
  "**/.config/chromium/",
];

/**
 * Docker Compose: official `tailscale/tailscale` sidecar + Runner sharing its netns.
 * Privileges / TUN live on the Tailscale container — Runner does NOT run tailscaled.
 */
export type RunnerComposeOpts = {
  token: string;
  serverUrl: string;
  /** Runner / Tailscale device name slug (safe for hostname + container names) */
  slug?: string;
  /** Tailscale auth key (tskey-auth-…); required when enableTailscale */
  tsAuthKey?: string;
  /** MagicDNS hostname; default zakura-{slug} */
  tsHostname?: string;
  /** Advertise tags — must exist in ACL + match OAuth client */
  tsTags?: string[];
  /**
   * Headscale (or other) login-server URL.
   * When set, sidecar uses `--login-server=` (platform-managed mesh).
   * Platform mode should omit tsTags so devices stay user-owned (autogroup:self).
   */
  tsLoginServer?: string;
  /** When true, include Tailscale sidecar (requires tsAuthKey) */
  enableTailscale?: boolean;
  port?: number;
  runnerImage?: string;
  tailscaleImage?: string;
};

function buildTsExtraArgs(opts: {
  tsTags?: string[];
  tsLoginServer?: string;
}): string {
  const parts: string[] = ["--accept-routes"];
  const login = opts.tsLoginServer?.trim().replace(/\/+$/, "");
  if (login) parts.unshift(`--login-server=${login}`);
  const tagList = (opts.tsTags ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.startsWith("tag:") ? t : `tag:${t}`));
  if (tagList.length) parts.push(`--advertise-tags=${tagList.join(",")}`);
  return parts.join(" ");
}

export type RunnerInstallPackage = {
  /** docker-compose.yml contents (secrets embedded) */
  compose: string;
  /** Always `docker-compose.yml` */
  filename: string;
  /**
   * One-shot shell: detect/install Docker if missing, write compose under
   * /var/zakura/{slug}/, then start.
   */
  script: string;
  /** Plain `docker run` (no compose file). Data bind-mounted under /var/zakura/{slug}/. */
  dockerRun: string;
  enableTailscale: boolean;
  tsHostname: string | null;
  slug: string;
};

function sanitizeSlug(raw: string | undefined): string {
  const s = (raw ?? "runner")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "runner";
}

function yamlQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:@+-]+$/.test(value) && !value.includes(" ")) return value;
  return JSON.stringify(value);
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runnerDataDirs(slug: string) {
  const root = `/var/zakura/${slug}`;
  return {
    root,
    data: `${root}/data`,
    ts: `${root}/tailscale`,
  };
}

/**
 * Single-file Compose with secrets embedded — no .env required.
 * Data lives under /var/zakura/{slug}/ (bind mounts, not named volumes).
 */
export function buildRunnerComposeSnippet(opts: RunnerComposeOpts): string {
  const port = opts.port ?? 7443;
  const slug = sanitizeSlug(opts.slug);
  const runnerImage = opts.runnerImage ?? "zakura/runner:latest";
  const dirs = runnerDataDirs(slug);
  const enableTs = Boolean(opts.enableTailscale && opts.tsAuthKey?.trim());

  if (!enableTs) {
    return `services:
  zakura-runner:
    image: ${runnerImage}
    container_name: zakura-runner-${slug}
    restart: always
    privileged: true
    ports:
      - "${port}:${port}"
    environment:
      ZAKURA_RUNNER_SERVER_URL: ${yamlQuote(opts.serverUrl)}
      ZAKURA_RUNNER_TOKEN: ${yamlQuote(opts.token)}
      ZAKURA_RUNNER_PORT: "${port}"
      DOCKER_HOST: unix:///var/run/docker.sock
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${dirs.data}:/var/lib/zakura
      - /tmp/.X11-unix:/tmp/.X11-unix
`;
  }

  const tsImage = opts.tailscaleImage ?? "tailscale/tailscale:latest";
  const hostname =
    opts.tsHostname?.trim() || `zakura-${slug}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const authKey = opts.tsAuthKey!.trim();
  const extraArgs = buildTsExtraArgs({
    tsTags: opts.tsTags,
    tsLoginServer: opts.tsLoginServer,
  });

  return `services:
  zakura-ts:
    image: ${tsImage}
    container_name: zakura-ts-${slug}
    hostname: ${hostname}
    restart: always
    environment:
      TS_AUTHKEY: ${yamlQuote(authKey)}
      TS_HOSTNAME: ${yamlQuote(hostname)}
      TS_STATE_DIR: /var/lib/tailscale
      TS_USERSPACE: "false"
      TS_EXTRA_ARGS: ${yamlQuote(extraArgs)}
    volumes:
      - ${dirs.ts}:/var/lib/tailscale
    devices:
      - /dev/net/tun:/dev/net/tun
    cap_add:
      - NET_ADMIN
      - NET_RAW
    ports:
      - "${port}:${port}"

  zakura-runner:
    image: ${runnerImage}
    container_name: zakura-runner-${slug}
    restart: always
    network_mode: service:zakura-ts
    depends_on:
      - zakura-ts
    privileged: true
    environment:
      ZAKURA_RUNNER_SERVER_URL: ${yamlQuote(opts.serverUrl)}
      ZAKURA_RUNNER_TOKEN: ${yamlQuote(opts.token)}
      ZAKURA_RUNNER_PORT: "${port}"
      DOCKER_HOST: unix:///var/run/docker.sock
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${dirs.data}:/var/lib/zakura
      - /tmp/.X11-unix:/tmp/.X11-unix
`;
}

/** Plain `docker run` — no compose file. Data under /var/zakura/{slug}/. */
function buildDockerRunCommand(opts: RunnerComposeOpts & { slug: string }): string {
  const port = opts.port ?? 7443;
  const slug = opts.slug;
  const runnerImage = opts.runnerImage ?? "zakura/runner:latest";
  const dirs = runnerDataDirs(slug);
  const enableTs = Boolean(opts.enableTailscale && opts.tsAuthKey?.trim());

  if (!enableTs) {
    return [
      `mkdir -p ${dirs.data}`,
      `docker rm -f zakura-runner-${slug} 2>/dev/null || true`,
      "docker run -d \\",
      `  --name zakura-runner-${slug} \\`,
      "  --restart always \\",
      "  --privileged \\",
      `  -p ${port}:${port} \\`,
      `  -e ZAKURA_RUNNER_SERVER_URL=${shQuote(opts.serverUrl)} \\`,
      `  -e ZAKURA_RUNNER_TOKEN=${shQuote(opts.token)} \\`,
      `  -e ZAKURA_RUNNER_PORT=${shQuote(String(port))} \\`,
      "  -e DOCKER_HOST=unix:///var/run/docker.sock \\",
      "  -v /var/run/docker.sock:/var/run/docker.sock \\",
      `  -v ${dirs.data}:/var/lib/zakura \\`,
      "  -v /tmp/.X11-unix:/tmp/.X11-unix \\",
      `  ${runnerImage}`,
    ].join("\n");
  }

  const tsImage = opts.tailscaleImage ?? "tailscale/tailscale:latest";
  const hostname =
    opts.tsHostname?.trim() || `zakura-${slug}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const authKey = opts.tsAuthKey!.trim();
  const extraArgs = buildTsExtraArgs({
    tsTags: opts.tsTags,
    tsLoginServer: opts.tsLoginServer,
  });

  return [
    `mkdir -p ${dirs.data} ${dirs.ts}`,
    `docker rm -f zakura-runner-${slug} zakura-ts-${slug} 2>/dev/null || true`,
    "",
    "docker run -d \\",
    `  --name zakura-ts-${slug} \\`,
    `  --hostname ${shQuote(hostname)} \\`,
    "  --restart always \\",
    `  -e TS_AUTHKEY=${shQuote(authKey)} \\`,
    `  -e TS_HOSTNAME=${shQuote(hostname)} \\`,
    "  -e TS_STATE_DIR=/var/lib/tailscale \\",
    '  -e TS_USERSPACE=false \\',
    `  -e TS_EXTRA_ARGS=${shQuote(extraArgs)} \\`,
    `  -v ${dirs.ts}:/var/lib/tailscale \\`,
    "  --device /dev/net/tun:/dev/net/tun \\",
    "  --cap-add NET_ADMIN --cap-add NET_RAW \\",
    `  -p ${port}:${port} \\`,
    `  ${tsImage}`,
    "",
    "docker run -d \\",
    `  --name zakura-runner-${slug} \\`,
    "  --restart always \\",
    "  --privileged \\",
    `  --network container:zakura-ts-${slug} \\`,
    `  -e ZAKURA_RUNNER_SERVER_URL=${shQuote(opts.serverUrl)} \\`,
    `  -e ZAKURA_RUNNER_TOKEN=${shQuote(opts.token)} \\`,
    `  -e ZAKURA_RUNNER_PORT=${shQuote(String(port))} \\`,
    "  -e DOCKER_HOST=unix:///var/run/docker.sock \\",
    "  -v /var/run/docker.sock:/var/run/docker.sock \\",
    `  -v ${dirs.data}:/var/lib/zakura \\`,
    "  -v /tmp/.X11-unix:/tmp/.X11-unix \\",
    `  ${runnerImage}`,
  ].join("\n");
}

function buildInstallScript(opts: {
  slug: string;
  installDir: string;
  dataDir: string;
  tsDir: string;
  enableTailscale: boolean;
  compose: string;
  tsHostname: string | null;
}): string {
  const { slug, installDir, dataDir, tsDir, enableTailscale, compose, tsHostname } = opts;
  const mkdirs = enableTailscale
    ? `need_sudo mkdir -p ${installDir} ${dataDir} ${tsDir}`
    : `need_sudo mkdir -p ${installDir} ${dataDir}`;
  return `#!/usr/bin/env bash
set -euo pipefail
# Zakura Runner · ${slug}${enableTailscale && tsHostname ? ` · Tailscale ${tsHostname}` : ""}

need_sudo() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else echo "Need root" >&2; exit 1; fi
}

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Installing Docker…"
  curl -fsSL https://get.docker.com | need_sudo sh
  command -v systemctl >/dev/null 2>&1 && need_sudo systemctl enable --now docker || true
fi

${mkdirs}
need_sudo tee ${installDir}/docker-compose.yml >/dev/null <<'ZAKURA_EOF'
${compose}ZAKURA_EOF

if docker compose version >/dev/null 2>&1; then
  need_sudo docker compose -f ${installDir}/docker-compose.yml up -d
elif command -v docker-compose >/dev/null 2>&1; then
  need_sudo docker-compose -f ${installDir}/docker-compose.yml up -d
else
  echo "docker compose missing" >&2; exit 1
fi
echo "OK · ${installDir}/docker-compose.yml"
`;
}

/** Install package: one-shot script + compose + plain docker run. */
export function buildRunnerInstallPackage(opts: RunnerComposeOpts): RunnerInstallPackage {
  const slug = sanitizeSlug(opts.slug);
  const enableTailscale = Boolean(opts.enableTailscale && opts.tsAuthKey?.trim());
  const tsHostname = enableTailscale
    ? opts.tsHostname?.trim() || `zakura-${slug}`.toLowerCase()
    : null;
  const filename = "docker-compose.yml";
  const dirs = runnerDataDirs(slug);
  const composeOpts = {
    ...opts,
    slug,
    enableTailscale,
    tsHostname: tsHostname ?? undefined,
  };
  const compose = buildRunnerComposeSnippet(composeOpts);
  const script = buildInstallScript({
    slug,
    installDir: dirs.root,
    dataDir: dirs.data,
    tsDir: dirs.ts,
    enableTailscale,
    compose,
    tsHostname,
  });
  const dockerRun = buildDockerRunCommand(composeOpts);

  return {
    compose,
    filename,
    script,
    dockerRun,
    enableTailscale,
    tsHostname,
    slug,
  };
}

