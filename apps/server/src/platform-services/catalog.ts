import type {
  ContainerSpec,
  PlatformServiceKey,
  PlatformServiceMode,
} from "@zakura/shared";
import { PLATFORM_SERVICE_KEYS } from "@zakura/shared";

export type PlatformServiceProductMap =
  | { kind: "search-engine"; id: "searxng" }
  | { kind: "fetch-backend"; id: "jina-reader" | "firecrawl" | "crawl4ai" };

export type PlatformServiceConfig = {
  /** Override image(s) — for multi-role stacks use images[role] */
  image?: string;
  images?: Record<string, string>;
  /** Published host port for primary HTTP endpoint */
  hostPort?: number;
  /** Extra env for primary / all containers */
  env?: Record<string, string>;
  /** mode=external base URL */
  externalUrl?: string;
  /** Optional auth for external or managed API */
  apiKey?: string;
};

export type PlatformContainerRole = {
  role: string;
  /** Primary HTTP endpoint for product mapping */
  primary?: boolean;
  defaultImage: string;
  containerPort?: number;
  defaultHostPort?: number;
  hostIp?: string;
  env?: Record<string, string>;
  shmSize?: number;
  command?: string[];
  healthcheck?: ContainerSpec["healthcheck"];
  /**
   * After this container starts, wait before starting the next one
   * (e.g. postgres needs a few seconds before the API can connect).
   */
  readyWaitMs?: number;
};

export type PlatformServiceDef = {
  key: PlatformServiceKey;
  name: string;
  description: string;
  mapsTo: PlatformServiceProductMap;
  /** Roles started when mode=managed */
  containers: PlatformContainerRole[];
  /** HTTP probe path relative to endpoint */
  healthPath: string;
  healthMethod?: "GET" | "POST";
  defaultMode?: PlatformServiceMode;
};

export const PLATFORM_SERVICE_CATALOG: Record<PlatformServiceKey, PlatformServiceDef> = {
  searxng: {
    key: "searxng",
    name: "SearXNG",
    description: "自托管元搜索引擎；为网页搜索提供 searxng 引擎",
    mapsTo: { kind: "search-engine", id: "searxng" },
    healthPath: "/",
    containers: [
      {
        role: "main",
        primary: true,
        defaultImage: "searxng/searxng:latest",
        containerPort: 8080,
        defaultHostPort: 18080,
        hostIp: "127.0.0.1",
      },
    ],
  },
  "jina-reader": {
    key: "jina-reader",
    name: "Jina Reader",
    description: "自托管 jina-ai/reader；将 URL 转为 Markdown（网页抓取后端）",
    mapsTo: { kind: "fetch-backend", id: "jina-reader" },
    healthPath: "/",
    containers: [
      {
        role: "main",
        primary: true,
        defaultImage: "ghcr.io/jina-ai/reader:oss",
        // HTTP/1.1 port inside the oss image
        containerPort: 8081,
        defaultHostPort: 18081,
        hostIp: "127.0.0.1",
      },
    ],
  },
  crawl4ai: {
    key: "crawl4ai",
    name: "Crawl4AI",
    description:
      "自托管 Crawl4AI Docker API；需 API Token（未设置时容器只监听 127.0.0.1，健康检查会失败）",
    mapsTo: { kind: "fetch-backend", id: "crawl4ai" },
    healthPath: "/health",
    containers: [
      {
        role: "main",
        primary: true,
        defaultImage: "unclecode/crawl4ai:latest",
        containerPort: 11235,
        defaultHostPort: 11235,
        hostIp: "127.0.0.1",
        shmSize: 1 * 1024 * 1024 * 1024,
        readyWaitMs: 3000,
      },
    ],
  },
  firecrawl: {
    key: "firecrawl",
    name: "Firecrawl",
    description:
      "自托管 Firecrawl（api + redis + rabbitmq + postgres + playwright）。镜像较重，首次拉取较慢",
    mapsTo: { kind: "fetch-backend", id: "firecrawl" },
    healthPath: "/",
    containers: [
      {
        role: "redis",
        defaultImage: "redis:7-alpine",
        readyWaitMs: 1000,
      },
      {
        role: "rabbitmq",
        defaultImage: "rabbitmq:3-management",
        // harness needs AMQP ready before workers start
        readyWaitMs: 4000,
      },
      {
        role: "postgres",
        // Firecrawl NUQ queue DB (pg_cron etc.). Plain postgres is not enough.
        defaultImage: "ghcr.io/firecrawl/nuq-postgres:latest",
        env: {
          POSTGRES_USER: "postgres",
          POSTGRES_PASSWORD: "postgres",
          POSTGRES_DB: "postgres",
        },
        readyWaitMs: 6000,
      },
      {
        role: "playwright",
        defaultImage: "ghcr.io/firecrawl/playwright-service:latest",
        containerPort: 3000,
        env: {
          PORT: "3000",
        },
        readyWaitMs: 2000,
      },
      {
        role: "api",
        primary: true,
        defaultImage: "ghcr.io/firecrawl/firecrawl:latest",
        containerPort: 3002,
        defaultHostPort: 13002,
        hostIp: "127.0.0.1",
        env: {
          HOST: "0.0.0.0",
          PORT: "3002",
          INTERNAL_PORT: "3002",
          USE_DB_AUTHENTICATION: "false",
          BULL_AUTH_KEY: "zakura-local",
          ENV: "local",
          // Prevent harness from trying Docker-in-Docker for NUQ postgres/rabbitmq
          POSTGRES_USER: "postgres",
          POSTGRES_PASSWORD: "postgres",
          POSTGRES_DB: "postgres",
          POSTGRES_PORT: "5432",
          HARNESS_STARTUP_TIMEOUT_MS: "120000",
        },
      },
    ],
  },
};

export function isPlatformServiceKey(v: string): v is PlatformServiceKey {
  return (PLATFORM_SERVICE_KEYS as readonly string[]).includes(v);
}

export function listPlatformServiceMeta() {
  return PLATFORM_SERVICE_KEYS.map((key) => {
    const d = PLATFORM_SERVICE_CATALOG[key];
    return {
      key: d.key,
      name: d.name,
      description: d.description,
      mapsTo: d.mapsTo,
      defaultHostPort: d.containers.find((c) => c.primary)?.defaultHostPort,
      defaultImage: d.containers.find((c) => c.primary)?.defaultImage,
    };
  });
}

/** Map product engine/backend id → platform service key when managed. */
export function serviceKeyForSearchEngine(engineId: string): PlatformServiceKey | null {
  if (engineId === "searxng") return "searxng";
  return null;
}

export function serviceKeyForFetchBackend(backendId: string): PlatformServiceKey | null {
  if (backendId === "jina-reader") return "jina-reader";
  if (backendId === "firecrawl") return "firecrawl";
  if (backendId === "crawl4ai") return "crawl4ai";
  return null;
}

export function containerNameFor(serviceKey: PlatformServiceKey, role: string): string {
  const base =
    role === "main" ? `zakura-ps-${serviceKey}` : `zakura-ps-${serviceKey}-${role}`;
  return base.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 63);
}

export function buildManagedSpecs(
  def: PlatformServiceDef,
  cfg: PlatformServiceConfig,
  network: string,
): ContainerSpec[] {
  const redisName = containerNameFor(def.key, "redis");
  const rabbitName = containerNameFor(def.key, "rabbitmq");
  const postgresName = containerNameFor(def.key, "postgres");
  const playwrightName = containerNameFor(def.key, "playwright");

  return def.containers.map((role) => {
    const name = containerNameFor(def.key, role.role);
    const image =
      cfg.images?.[role.role] ??
      (role.primary && cfg.image ? cfg.image : undefined) ??
      role.defaultImage;

    const hostPort =
      role.primary && typeof cfg.hostPort === "number" && cfg.hostPort > 0
        ? cfg.hostPort
        : role.defaultHostPort;

    const env: Record<string, string> = {
      ...(role.env ?? {}),
      ...(role.primary || role.role === "api" ? cfg.env ?? {} : {}),
    };

    // Crawl4AI 0.9+: without CRAWL4AI_API_TOKEN the entrypoint binds 127.0.0.1 only
    // (Docker port publish + health checks then fail with "fetch failed").
    if (def.key === "crawl4ai" && (role.primary || role.role === "main")) {
      const token = cfg.apiKey?.trim();
      if (token) {
        env.CRAWL4AI_API_TOKEN = env.CRAWL4AI_API_TOKEN ?? token;
        // Silence ephemeral redis password warning; keep redis internal requirepass
        env.REDIS_PASSWORD = env.REDIS_PASSWORD ?? token;
      }
    }

    // Firecrawl full stack: wire sibling containers so harness does NOT try DinD
    // (error: "Neither Docker nor Podman found... set NUQ_DATABASE_URL")
    if (def.key === "firecrawl" && role.role === "api") {
      const pgUser = env.POSTGRES_USER ?? "postgres";
      const pgPass = env.POSTGRES_PASSWORD ?? "postgres";
      const pgDb = env.POSTGRES_DB ?? "postgres";
      const pgHost = env.POSTGRES_HOST ?? postgresName;
      const pgPort = env.POSTGRES_PORT ?? "5432";
      const redisUrl = env.REDIS_URL ?? `redis://${redisName}:6379`;
      const rabbitUrl = env.NUQ_RABBITMQ_URL ?? `amqp://${rabbitName}:5672`;
      const nuqUrl =
        env.NUQ_DATABASE_URL ??
        `postgresql://${encodeURIComponent(pgUser)}:${encodeURIComponent(pgPass)}@${pgHost}:${pgPort}/${encodeURIComponent(pgDb)}`;

      env.REDIS_URL = redisUrl;
      env.REDIS_RATE_LIMIT_URL = env.REDIS_RATE_LIMIT_URL ?? redisUrl;
      env.POSTGRES_HOST = pgHost;
      env.POSTGRES_PORT = pgPort;
      env.POSTGRES_USER = pgUser;
      env.POSTGRES_PASSWORD = pgPass;
      env.POSTGRES_DB = pgDb;
      // Explicit URL is the most reliable skip for harness setupNuqPostgres
      env.NUQ_DATABASE_URL = nuqUrl;
      env.NUQ_DATABASE_URL_LISTEN = env.NUQ_DATABASE_URL_LISTEN ?? nuqUrl;
      env.NUQ_RABBITMQ_URL = rabbitUrl;
      env.PLAYWRIGHT_MICROSERVICE_URL =
        env.PLAYWRIGHT_MICROSERVICE_URL ??
        `http://${playwrightName}:3000/scrape`;
    }

    // Publish host ports only for primary / roles with defaultHostPort
    const publishedHostPort = role.primary
      ? hostPort
      : typeof role.defaultHostPort === "number"
        ? role.defaultHostPort
        : undefined;
    const ports =
      role.containerPort != null && publishedHostPort != null
        ? [
            {
              containerPort: role.containerPort,
              hostPort: publishedHostPort,
              hostIp: role.hostIp ?? "127.0.0.1",
              protocol: "tcp" as const,
            },
          ]
        : undefined;

    return {
      name,
      image,
      purpose: "component" as const,
      env,
      ports,
      network,
      shmSize: role.shmSize,
      command: role.command,
      healthcheck: role.healthcheck,
      restartPolicy: "unless-stopped" as const,
      labels: {
        "zakura.purpose": "platform-service",
        "zakura.service": def.key,
        "zakura.service_role": role.role,
        ...(role.readyWaitMs
          ? { "zakura.ready_wait_ms": String(role.readyWaitMs) }
          : {}),
      },
    };
  });
}

export function defaultServiceConfig(): PlatformServiceConfig {
  return {};
}
