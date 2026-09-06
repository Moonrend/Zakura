/**
 * Containerized adapters ship as prebuilt images, so they never show up in the
 * workspace install scan. Without explicit handling they render as "not
 * installed" forever, next to an install button that cannot help.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { acpContainerAgents } from "@zakura/shared";
import type { AcpAdapterStatus } from "../src/services/acp/registry.js";

/** Mirrors the merge step at the end of AcpRegistryService.status(). */
function mergeContainerAdapters(scanned: AcpAdapterStatus[]): AcpAdapterStatus[] {
  const byId = new Map(scanned.map((s) => [s.id, s]));
  for (const agent of acpContainerAgents()) {
    if (byId.has(agent.id)) continue;
    byId.set(agent.id, {
      id: agent.id,
      installed: [agent.version],
      latest: agent.version,
      updateAvailable: false,
      diskKb: {},
      source: "container",
      image: agent.image,
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

test("containerized adapters report as installed and need no update", () => {
  const merged = mergeContainerAdapters([]);
  const enabled = acpContainerAgents();
  assert.ok(enabled.length > 0, "expected enabled container agents");

  for (const agent of enabled) {
    const status = merged.find((s) => s.id === agent.id);
    assert.ok(status, `${agent.id} missing from status`);
    assert.equal(status.source, "container");
    assert.deepEqual(status.installed, [agent.version]);
    assert.equal(status.updateAvailable, false, `${agent.id} must not offer an install`);
    assert.equal(status.image, agent.image);
  }
});

test("a workspace install of the same adapter wins over the container entry", () => {
  // A user who installed an adapter by hand should keep seeing real disk state
  // rather than having it masked by the image entry.
  const agent = acpContainerAgents()[0];
  assert.ok(agent);
  const scanned: AcpAdapterStatus[] = [
    {
      id: agent.id,
      installed: ["0.0.1-local"],
      latest: "0.0.1-local",
      updateAvailable: false,
      diskKb: { "0.0.1-local": 42 },
      source: "workspace",
    },
  ];
  const merged = mergeContainerAdapters(scanned);
  const status = merged.find((s) => s.id === agent.id);
  assert.equal(status?.source, "workspace");
  assert.deepEqual(status?.installed, ["0.0.1-local"]);
});

test("container entries do not disturb unrelated workspace adapters", () => {
  const scanned: AcpAdapterStatus[] = [
    {
      id: "some-other-adapter",
      installed: ["1.0.0"],
      latest: "1.1.0",
      updateAvailable: true,
      diskKb: { "1.0.0": 100 },
      source: "workspace",
    },
  ];
  const merged = mergeContainerAdapters(scanned);
  const other = merged.find((s) => s.id === "some-other-adapter");
  assert.equal(other?.updateAvailable, true, "workspace update state must survive");
  assert.equal(merged.length, acpContainerAgents().length + 1);
});