import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PLATFORM_SERVICE_CATALOG,
  buildManagedSpecs,
  containerNameFor,
  managedEndpointUrl,
  serviceKeyForFetchBackend,
  serviceKeyForSearchEngine,
} from "../src/platform-services/catalog.js";
import { PLATFORM_SERVICE_KEYS } from "@zakura/shared";

describe("platform services catalog", () => {
  it("covers all platform service keys", () => {
    for (const key of PLATFORM_SERVICE_KEYS) {
      assert.ok(PLATFORM_SERVICE_CATALOG[key], key);
      assert.ok(PLATFORM_SERVICE_CATALOG[key].containers.length >= 1);
    }
  });

  it("maps product engines/backends", () => {
    assert.equal(serviceKeyForSearchEngine("searxng"), "searxng");
    assert.equal(serviceKeyForSearchEngine("tavily"), null);
    assert.equal(serviceKeyForFetchBackend("jina-reader"), "jina-reader");
    assert.equal(serviceKeyForFetchBackend("firecrawl"), "firecrawl");
    assert.equal(serviceKeyForFetchBackend("crawl4ai"), "crawl4ai");
    assert.equal(serviceKeyForFetchBackend("native"), null);
  });

  it("builds container names and specs", () => {
    assert.equal(containerNameFor("searxng", "main"), "zakura-ps-searxng");
    assert.equal(containerNameFor("firecrawl", "redis"), "zakura-ps-firecrawl-redis");

    const def = PLATFORM_SERVICE_CATALOG.searxng;
    const specs = buildManagedSpecs(def, { hostPort: 19080 }, "zakura");
    assert.equal(specs.length, 1);
    assert.equal(specs[0]!.name, "zakura-ps-searxng");
    assert.equal(specs[0]!.network, "zakura");
    assert.equal(specs[0]!.ports?.[0]?.hostPort, 19080);
    assert.equal(specs[0]!.ports?.[0]?.hostIp, "127.0.0.1");
    assert.equal(specs[0]!.labels?.["zakura.service"], "searxng");
  });

  it("uses container DNS when the server runs in Docker", () => {
    assert.equal(
      managedEndpointUrl("network", "zakura-ps-crawl4ai", 11235, 11235),
      "http://zakura-ps-crawl4ai:11235",
    );
    assert.equal(
      managedEndpointUrl("published", "zakura-ps-crawl4ai", 11235, 11235),
      "http://127.0.0.1:11235",
    );
    assert.equal(managedEndpointUrl("published", "service", 80), null);
  });

  it("wires firecrawl full-stack env so harness skips Docker-in-Docker", () => {
    const specs = buildManagedSpecs(PLATFORM_SERVICE_CATALOG.firecrawl, {}, "zakura");
    const roles = specs.map((s) => s.labels?.["zakura.service_role"]);
    assert.deepEqual(roles, ["redis", "rabbitmq", "postgres", "playwright", "api"]);

    const api = specs.find((s) => s.labels?.["zakura.service_role"] === "api");
    assert.ok(api);
    assert.match(api!.env?.REDIS_URL ?? "", /zakura-ps-firecrawl-redis/);
    assert.match(api!.env?.NUQ_DATABASE_URL ?? "", /zakura-ps-firecrawl-postgres/);
    assert.match(api!.env?.NUQ_RABBITMQ_URL ?? "", /zakura-ps-firecrawl-rabbitmq/);
    assert.match(
      api!.env?.PLAYWRIGHT_MICROSERVICE_URL ?? "",
      /zakura-ps-firecrawl-playwright/,
    );
    // POSTGRES_HOST != localhost → harness docker-compose path
    assert.equal(api!.env?.POSTGRES_HOST, "zakura-ps-firecrawl-postgres");
    // Explicit URL is the hard skip for setupNuqPostgres
    assert.ok(api!.env?.NUQ_DATABASE_URL?.startsWith("postgresql://"));
  });

  it("sets shm for crawl4ai", () => {
    const specs = buildManagedSpecs(PLATFORM_SERVICE_CATALOG.crawl4ai, {}, "zakura");
    assert.ok((specs[0]!.shmSize ?? 0) >= 1024 * 1024 * 1024);
  });

  it("injects CRAWL4AI_API_TOKEN so container binds all interfaces", () => {
    const specs = buildManagedSpecs(
      PLATFORM_SERVICE_CATALOG.crawl4ai,
      { apiKey: "test-token-xyz" },
      "zakura",
    );
    assert.equal(specs[0]!.env?.CRAWL4AI_API_TOKEN, "test-token-xyz");
    assert.equal(specs[0]!.env?.REDIS_PASSWORD, "test-token-xyz");
  });

  it("omits crawl4ai token env when no apiKey (deploy path must generate one)", () => {
    const specs = buildManagedSpecs(PLATFORM_SERVICE_CATALOG.crawl4ai, {}, "zakura");
    assert.equal(specs[0]!.env?.CRAWL4AI_API_TOKEN, undefined);
  });
});

describe("fetch backends include managed options", () => {
  it("lists firecrawl and crawl4ai", async () => {
    const { listFetchBackendMeta } = await import("../src/capabilities/web-fetch/index.js");
    const ids = listFetchBackendMeta().map((b) => b.id);
    assert.ok(ids.includes("firecrawl"));
    assert.ok(ids.includes("crawl4ai"));
    assert.ok(ids.includes("jina-reader"));
  });
});
