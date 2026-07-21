import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pickPreferredInstallPreview,
  rankInstallPreview,
  type StoreInstallPreview,
} from "@zakura/shared";
import type { AppConfig } from "../src/config.js";
import { previewFromPackagesAndRemotes } from "../src/lib/mcp-install-parse.js";
import { McpStoreService } from "../src/services/mcp-store.js";

function mockConfig(): AppConfig {
  return {
    dataDir: "/tmp/zakura-mcp-store-test",
    databaseUrl: "pglite:/tmp/zakura-mcp-store-test/db",
    secret: "test",
    host: "127.0.0.1",
    port: 3000,
    publicBaseUrl: "http://127.0.0.1:3000",
    webPublicUrl: "http://127.0.0.1:3001",
    dockerNetwork: "zakura",
    aptMirror: "",
    migrationDir: "/tmp/migrations",
    runnerHeartbeatTimeoutSec: 60,
    migrationRetentionDays: 7,
    edition: "oss",
  };
}

describe("MCP 统一安装偏好", () => {
  it("preview 将 stdio 排在 HTTP 之前", () => {
    const options = previewFromPackagesAndRemotes({
      remotes: [{ type: "sse", url: "https://example.com/sse" }],
      packages: [
        { registryType: "pypi", identifier: "markitdown-mcp" },
        { registryType: "npm", identifier: "@example/mcp" },
      ],
    });
    assert.match(options[0]!.kind, /^stdio-/);
    assert.ok(options.some((o) => o.kind === "http"));
    assert.ok(
      options.findIndex((o) => o.kind === "http") >
        options.findIndex((o) => o.kind.startsWith("stdio")),
    );
  });

  it("pickPreferredInstallPreview 优先 npm/pypi 而非 HTTP", () => {
    const options: StoreInstallPreview[] = [
      {
        id: "http-0",
        kind: "http",
        label: "HTTP",
        summary: "https://example.com/mcp",
        prefer: "http",
      },
      {
        id: "pypi-0",
        kind: "stdio-pypi",
        label: "PyPI",
        summary: "uvx markitdown-mcp",
        prefer: "stdio",
        packageIndex: 0,
      },
    ].sort(rankInstallPreview);
    const preferred = pickPreferredInstallPreview(options);
    assert.equal(preferred?.kind, "stdio-pypi");
    assert.equal(preferred?.prefer, "stdio");
  });

  it("buildInstallPlan 默认 prefer stdio（Markitdown 类双声明）", () => {
    const store = new McpStoreService(mockConfig());
    const plan = store.buildInstallPlan({
      name: "io.github.microsoft/markitdown",
      title: "Markitdown",
      description: "Convert documents",
      version: "0.1.0",
      storeId: "official-registry",
      remotes: [{ type: "sse", url: "https://example.invalid/sse" }],
      packages: [
        {
          registryType: "pypi",
          identifier: "markitdown-mcp",
        },
      ],
      installKinds: ["http", "stdio-pypi"],
    });
    assert.equal(plan.kind, "stdio");
    assert.equal(plan.providerId, "stdio-mcp");
    assert.equal(plan.config.packageManager, "pypi");
    assert.match(String(plan.config.image), /uv/);
  });

  it("显式 prefer=http 仍可走 HTTP", () => {
    const store = new McpStoreService(mockConfig());
    const plan = store.buildInstallPlan(
      {
        name: "io.github.microsoft/markitdown",
        description: "Convert documents",
        version: "0.1.0",
        storeId: "official-registry",
        remotes: [{ type: "http", url: "https://example.com/mcp" }],
        packages: [{ registryType: "pypi", identifier: "markitdown-mcp" }],
        installKinds: ["http", "stdio-pypi"],
      },
      { prefer: "http" },
    );
    assert.equal(plan.kind, "http");
    assert.equal(plan.providerId, "generic-mcp");
  });
});
