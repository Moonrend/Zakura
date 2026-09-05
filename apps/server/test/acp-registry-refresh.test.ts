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

const fakeAgent = { id: "agent-1" } as Parameters<AcpRegistryService["collectGarbage"]>[0];

/**
 * Stubs the workspace so `collectGarbage` sees a fixed set of installed
 * versions, and captures the GC script it generates.
 */
function gcHarness(installed: string, indexVersion = "2.0.0") {
  let gcScript = "";
  const workspace = {
    execInWorkspace: async (_agent: unknown, argv: string[]) => {
      const script = argv[2] ?? "";
      // The GC script is the one built from the keep-list.
      if (script.includes("ZAKURA_ACP_PRUNED")) {
        gcScript = script;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: installed, stderr: "", exitCode: 0 };
    },
  } as unknown as Workspace;

  const impl = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => indexPayload(indexVersion),
    }) as unknown as Response) as unknown as typeof fetch;

  return { registry: new AcpRegistryService(workspace, impl), gc: () => gcScript };
}

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

describe("ACP registry GC", () => {
  it("prunes an old version once nothing is running on it", async () => {
    // 1.0.0 installed but superseded by the pinned 2.0.0, and no live session.
    const { registry, gc } = gcHarness("demo\t1.0.0\ndemo\t2.0.0");

    await registry.collectGarbage(fakeAgent);

    assert.match(gc(), /demo\/2\.0\.0/, "pinned version must be kept");
    assert.doesNotMatch(gc(), /demo\/1\.0\.0/, "superseded version should be prunable");
  });

  it("keeps a superseded version that a live session is still running", async () => {
    const { registry, gc } = gcHarness("demo\t1.0.0\ndemo\t2.0.0");
    // A session started before the update is still executing from 1.0.0.
    registry.setInUseVersionsProvider(() => [{ id: "demo", version: "1.0.0" }]);

    await registry.collectGarbage(fakeAgent);

    // Pruning it would kill that session with MODULE_NOT_FOUND, since the
    // adapter CLIs resolve modules from their install directory at runtime.
    assert.match(gc(), /demo\/1\.0\.0/, "in-use version must survive GC");
    assert.match(gc(), /demo\/2\.0\.0/, "pinned version must still be kept");
  });

  it("ignores in-use versions that are not actually installed", async () => {
    const { registry, gc } = gcHarness("demo\t2.0.0");
    registry.setInUseVersionsProvider(() => [{ id: "demo", version: "9.9.9" }]);

    await registry.collectGarbage(fakeAgent);

    assert.doesNotMatch(gc(), /demo\/9\.9\.9/, "stale entries must not enter the keep list");
  });
});
