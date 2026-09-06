/**
 * Containerized adapters ship as prebuilt images, so they never show up in the
 * workspace install scan. Without explicit handling they render as "not
 * installed" forever, next to an install button that cannot help.
 *
 * Note what `installed` means here: the version we *intend* to run, not proof
 * that the image exists locally. Whether the image is actually present is
 * reported separately via `imageReady`, because conflating the two made the UI
 * hide the install button while the image was missing, and the failure only
 * surfaced at launch as "没镜像".
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { acpContainerAgents } from "@zakura/shared";
import type { AcpAdapterStatus } from "../src/services/acp/registry.js";

/** Mirrors the merge step at the end of AcpRegistryService.status(). */
function mergeContainerAdapters(
  scanned: AcpAdapterStatus[],
  present: ReadonlyMap<string, boolean | undefined> = new Map(),
): AcpAdapterStatus[] {
  const byId = new Map(scanned.map((s) => [s.id, s]));
  for (const agent of acpContainerAgents()) {
    if (byId.has(agent.id)) continue;
    byId.set(agent.id, {
      id: agent.id,
      profileId: agent.profileId,
      installed: [agent.version],
      latest: agent.version,
      updateAvailable: false,
      diskKb: {},
      source: "container",
      image: agent.image,
      imageReady: present.get(agent.image),
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
    // Every entry must be addressable by the id the UI actually holds.
    assert.equal(status.profileId, agent.profileId);
  }
});

test("image presence is reported separately from the intended version", () => {
  const agent = acpContainerAgents()[0];
  assert.ok(agent, "expected a container agent");

  const missing = mergeContainerAdapters([], new Map([[agent.image, false]]));
  const status = missing.find((s) => s.id === agent.id);
  assert.ok(status);
  // Still "installed" in the sense of a pinned version...
  assert.deepEqual(status.installed, [agent.version]);
  // ...but explicitly not runnable yet. The UI keys its button off this.
  assert.equal(status.imageReady, false);

  const ready = mergeContainerAdapters([], new Map([[agent.image, true]]));
  assert.equal(ready.find((s) => s.id === agent.id)?.imageReady, true);

  // Unknown (remote runner) must stay undefined rather than collapsing to a
  // boolean — callers must not treat "unknown" as "ready".
  const unknown = mergeContainerAdapters([]);
  assert.equal(unknown.find((s) => s.id === agent.id)?.imageReady, undefined);
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
