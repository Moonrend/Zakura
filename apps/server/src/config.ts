import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSecret } from "@zakura/core";
import type { ZakuraEdition } from "@zakura/shared";
import { loadEnvFiles } from "./load-env.js";
import { resolveEdition } from "./saas-loader.js";

// Load .env before reading process.env (tsx does not do this by itself)
loadEnvFiles();

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");

function resolveDataDir(): string {
  const fromEnv = process.env.ZAKURA_DATA_DIR;
  if (fromEnv) return resolve(fromEnv);
  return resolve(repoRoot, "data");
}

export interface AppConfig {
  dataDir: string;
  databaseUrl: string;
  secret: string;
  host: string;
  port: number;
  publicBaseUrl: string;
  /** Web console URL for OAuth authorize UI redirects */
  webPublicUrl: string;
  dockerNetwork: string;
  /** Use container DNS for in-network servers, or published loopback ports. */
  platformServiceEndpointMode: "published" | "network";
  /**
   * APT mirror base for workspace containers (no trailing slash).
   * Prefer http:// — debian/ubuntu slim images often lack ca-certificates until
   * the first apt install; HTTPS mirrors fail TLS verify and block bootstrap.
   * Example: http://mirrors.aliyun.com or http://mirrors.tuna.tsinghua.edu.cn
   * Empty string disables rewriting.
   */
  aptMirror: string;
  /** Migration package directory (tar.zst archives) */
  migrationDir: string;
  /** Seconds without heartbeat before a runner is offline */
  runnerHeartbeatTimeoutSec: number;
  /** Days to retain migration archives */
  migrationRetentionDays: number;
  /**
   * Deployment edition.
   * - `oss` — single account, no public registration / members / multi-tenant UI
   * - `saas` — requires `@zakura/saas` (multi-tenant, register, invites, platform admin)
   */
  edition: ZakuraEdition;
  /** True when edition === "saas". */
  multiTenant: boolean;
  /**
   * 上游 MCP 无 DCR 时使用的预注册 OAuth App（如 GitHub Remote MCP）。
   * 见 ZAKURA_GITHUB_OAUTH_CLIENT_ID / SECRET。
   */
  mcpOauthClients: {
    githubClientId: string;
    githubClientSecret: string;
    githubScopes: string;
    slackClientId: string;
    slackClientSecret: string;
    slackScopes: string;
  };
}

function loadOrCreateSecret(dataDir: string): string {
  if (process.env.ZAKURA_SECRET && process.env.ZAKURA_SECRET.length > 0) {
    return process.env.ZAKURA_SECRET;
  }
  const secretPath = join(dataDir, "secret.key");
  if (existsSync(secretPath)) {
    return readFileSync(secretPath, "utf8").trim();
  }
  const secret = generateSecret();
  writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig(): AppConfig {
  const dataDir = resolveDataDir();
  mkdirSync(dataDir, { recursive: true });

  const databaseUrl =
    process.env.DATABASE_URL ?? `pglite:${join(dataDir, "pglite")}`;

  process.env.DATABASE_URL = databaseUrl;

  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "0.0.0.0";
  const publicBaseUrl = process.env.ZAKURA_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
  const webPublicUrl =
    process.env.ZAKURA_WEB_URL ?? process.env.WEB_PUBLIC_URL ?? "http://127.0.0.1:3001";

  // Default Aliyun HTTP; containers fall back across tuna/ustc/huawei/tencent/debian.
  // Prefer HTTP: slim images lack ca-certificates until the first apt install.
  const aptMirrorRaw = process.env.ZAKURA_APT_MIRROR;
  const aptMirror =
    aptMirrorRaw === "" || aptMirrorRaw === "off" || aptMirrorRaw === "none"
      ? ""
      : (aptMirrorRaw ?? "http://mirrors.aliyun.com")
          .replace(/\/$/, "")
          .replace(/^https:\/\//i, "http://");

  const migrationDir = process.env.ZAKURA_MIGRATION_DIR
    ? resolve(process.env.ZAKURA_MIGRATION_DIR)
    : join(dataDir, "migrations");
  mkdirSync(migrationDir, { recursive: true });

  return {
    dataDir,
    databaseUrl,
    secret: loadOrCreateSecret(dataDir),
    host,
    port,
    publicBaseUrl,
    webPublicUrl: webPublicUrl.replace(/\/$/, ""),
    dockerNetwork: process.env.ZAKURA_DOCKER_NETWORK ?? "zakura",
    platformServiceEndpointMode:
      process.env.ZAKURA_PLATFORM_SERVICE_ENDPOINT_MODE === "network"
        ? "network"
        : "published",
    aptMirror,
    migrationDir,
    runnerHeartbeatTimeoutSec: Number(process.env.ZAKURA_RUNNER_HEARTBEAT_TIMEOUT_SEC ?? 60),
    migrationRetentionDays: Number(process.env.ZAKURA_MIGRATION_RETENTION_DAYS ?? 7),
    ...(() => {
      const edition = resolveEdition();
      return { edition, multiTenant: edition === "saas" } as const;
    })(),
    mcpOauthClients: {
      githubClientId: process.env.ZAKURA_GITHUB_OAUTH_CLIENT_ID ?? "",
      githubClientSecret: process.env.ZAKURA_GITHUB_OAUTH_CLIENT_SECRET ?? "",
      // 空则使用上游 PRM scopes_supported
      githubScopes: process.env.ZAKURA_GITHUB_OAUTH_SCOPES ?? "",
      slackClientId: process.env.ZAKURA_SLACK_OAUTH_CLIENT_ID ?? "",
      slackClientSecret: process.env.ZAKURA_SLACK_OAUTH_CLIENT_SECRET ?? "",
      slackScopes: process.env.ZAKURA_SLACK_OAUTH_SCOPES ?? "",
    },
  };
}
