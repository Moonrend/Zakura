import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSecret } from "@zakura/core";
import type { ZakuraEdition } from "@zakura/shared";
import { loadEnvFiles } from "./load-env.js";
import { resolveEdition } from "./saas-loader.js";
import { redisUrlFromEnv } from "./services/redis.js";

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
  /** Redis 连接串；null 表示 REDIS_URL=off 显式关闭 */
  redisUrl: string | null;
  secret: string;
  host: string;
  port: number;
  publicBaseUrl: string;
  /** Web console URL for OAuth authorize UI redirects */
  webPublicUrl: string;
  dockerNetwork: string;
  /** Use container DNS when the server itself runs inside Docker. */
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
   * Max simultaneous ACP runtimes (running + booting) per tenant. Caps docker
   * exec / container pressure a single tenant can create on a shared node so
   * one tenant cannot starve the rest. 0 = unlimited.
   */
  maxConcurrentAcpPerTenant: number;
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

function isRunningInContainer(): boolean {
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
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

  // Default Aliyun; empty / off / none keeps the image's Debian sources.
  const aptMirrorRaw = process.env.ZAKURA_APT_MIRROR;
  const aptMirror =
    aptMirrorRaw === "" || aptMirrorRaw === "off" || aptMirrorRaw === "none"
      ? ""
      : (aptMirrorRaw ?? "https://mirrors.aliyun.com").replace(/\/$/, "");

  const migrationDir = process.env.ZAKURA_MIGRATION_DIR
    ? resolve(process.env.ZAKURA_MIGRATION_DIR)
    : join(dataDir, "migrations");
  mkdirSync(migrationDir, { recursive: true });

  return {
    dataDir,
    databaseUrl,
    redisUrl: redisUrlFromEnv(),
    secret: loadOrCreateSecret(dataDir),
    host,
    port,
    publicBaseUrl,
    webPublicUrl: webPublicUrl.replace(/\/$/, ""),
    dockerNetwork: process.env.ZAKURA_DOCKER_NETWORK ?? "zakura",
    platformServiceEndpointMode: isRunningInContainer() ? "network" : "published",
    aptMirror,
    migrationDir,
    runnerHeartbeatTimeoutSec: Number(process.env.ZAKURA_RUNNER_HEARTBEAT_TIMEOUT_SEC ?? 60),
    migrationRetentionDays: Number(process.env.ZAKURA_MIGRATION_RETENTION_DAYS ?? 7),
    maxConcurrentAcpPerTenant: Number(process.env.ZAKURA_ACP_MAX_CONCURRENT_PER_TENANT ?? 8),
    ...(() => {
      const edition = resolveEdition();
      return { edition, multiTenant: edition === "saas" } as const;
    })(),
  };
}
