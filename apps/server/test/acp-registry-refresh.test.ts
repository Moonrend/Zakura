import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AcpRegistryService } from "../src/services/acp/registry.js";

/**
 * The update badge is derived from the cached registry index. These tests pin
 * the cache-bypass contract: without it, a version published minutes ago stays
 * invisible for up to 6h and the "更新" button never appears.
 */

type Workspace = ConstructorParameters<typeof AcpRegistryService>[0];

function indexPayload(version: string) {
  return {
    version: 1,
    agents: [
      {
        id: "demo",
        name: "Demo",
        description: "demo agent",
        dist: { version, platforms: {} },
      },
    ],
  };
}

/** Counts calls so we can tell a cache hit from a real network read. */
function countingFetch(version = "1.0.0") {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => indexPayload(version),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

const noWorkspace = {} as Workspace;

describe("ACP registry index cache", () => {
  it("serves a warm index from cache without refetching", async () => {
    const { impl, calls } = countingFetch();
    const registry = new AcpRegistryService(noWorkspace, impl);

    await registry.getIndex();
    await registry.getIndex();

    assert.equal(calls(), 1, "second read should hit the cache");
  });

  it("refetches when force is set, bypassing the TTL", async () => {
    const { impl, calls } = countingFetch();
    const registry = new AcpRegistryService(noWorkspace, impl);

    await registry.getIndex();
    await registry.getIndex({ force: true });

    assert.equal(calls(), 2, "force must bypass the 6h TTL");
  });

  it("keeps serving the previous snapshot when a refresh fails", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => indexPayload("1.0.0"),
        } as unknown as Response;
      }
      throw new Error("registry unreachable");
    }) as unknown as typeof fetch;

    const registry = new AcpRegistryService(noWorkspace, impl);
    const first = await registry.getIndex();
    assert.ok(first, "first read should populate the cache");

    const second = await registry.getIndex({ force: true });

    // A brief outage must not empty the catalogue, which would read as
    // "no agents exist" / "no updates available" in the UI.
    assert.ok(second, "a failed refresh must not drop the cached index");
    assert.equal(second?.agents.length, 1);
  });
});