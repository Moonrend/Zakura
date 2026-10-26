import assert from "node:assert/strict";
import test from "node:test";
import { invalidateApiCache } from "./api";
import { listModelsByCapability } from "./cloud-agent";

function mockRoutes(t: test.TestContext, routes: unknown[]) {
  invalidateApiCache();
  t.after(() => invalidateApiCache());
  t.mock.method(globalThis, "fetch", async () => Response.json({ routes }));
}

test("optional malformed metadata does not erase available models", async (t) => {
  mockRoutes(t, [
    { alias: "healthy", id: "route-a", meta: { contextLimit: 200000 } },
    {
      alias: "partial",
      id: "route-b",
      meta: {
        reasoning: true,
        reasoningLevels: [null, { toString: null }, " low ", 3, "high"],
        defaultReasonLevel: { unexpected: true },
        contextLimit: "unknown",
      },
    },
    { alias: "no-metadata", id: "route-c" },
  ]);
  const models = await listModelsByCapability();
  assert.deepEqual(models.map((model) => model.alias), ["healthy", "partial", "no-metadata"]);
  assert.equal(models[0]?.contextLimit, 200000);
  assert.deepEqual(models[1]?.reasoningLevels, ["low", "high"]);
  assert.equal(models[1]?.defaultReasonLevel, undefined);
  assert.equal(models[1]?.contextLimit, undefined);
});

test("malformed route rows are isolated and routes without aliases use model IDs", async (t) => {
  mockRoutes(t, [
    null,
    { alias: 42 },
    { alias: "" },
    { alias: null, model: "native-model", id: "route-a" },
    { alias: "valid", id: "route-b", name: { unexpected: true }, upstream: { name: 7 } },
  ]);
  const models = await listModelsByCapability();
  assert.deepEqual(models.map((model) => model.alias), ["native-model", "valid"]);
  assert.equal(models[1]?.name, "valid");
  assert.deepEqual(models[1]?.providers, [{ id: "route-b", name: "valid" }]);
});

test("large duplicate inventories aggregate limits without argument spreading", async (t) => {
  const routes = Array.from({ length: 150000 }, (_, index) => ({
    alias: "shared-model",
    meta: { contextLimit: index === 149999 ? 64000 : 200000 },
  }));
  mockRoutes(t, routes);
  const models = await listModelsByCapability();
  assert.equal(models.length, 1);
  assert.equal(models[0]?.contextLimit, 64000);
});
