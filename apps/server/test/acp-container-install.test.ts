/**
 * Regression: containerized installs must PULL, never host-install.
 *
 * The bug this pins: every one of the shipped registry agents carries a
 * container `image`, but its `dist.kind` is still the legacy host-install
 * method (npx / binary / uvx) — `dist.kind === "image"` matches *nothing*.
 *
 * `AcpRegistryService.ensureInstalled` used to gate its container branch on
 * `entry.dist?.kind === "image"`, so that branch was dead and every
 * containerized install fell through to the host provisioner. Clicking
 * "拉取镜像" for Dirac ran `npm install` into /workspace/.zakura/acp/dirac/…
 * and died with `spawn sh ENOENT` while building `sharp`.
 *
 * The previous test suite missed this because it mocked catalog entries with
 * `dist: { kind: "image" }` — a shape the real registry never produces. These
 * assertions therefore run against the REAL registry snapshot on purpose.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acpContainerAgents,
  acpImageAtVersion,
  acpSnapshotVersion,
} from "@zakura/shared";

test("no shipped agent uses dist.kind 'image' — the old guard was dead code", () => {
  const agents = acpContainerAgents();
  assert.ok(agents.length > 0, "registry snapshot must not be empty");

  const withImageKind = agents.filter((a) => a.dist?.kind === "image");
  assert.deepEqual(
    withImageKind.map((a) => a.id),
    [],
    "if this ever becomes non-empty, the install guard may key on dist.kind again",
  );
});

test("every shipped agent is containerized via `image`", () => {
  const missing = acpContainerAgents()
    .filter((a) => !a.image)
    .map((a) => a.id);
  assert.deepEqual(missing, [], "agents without an image would host-install");
});

test("dirac specifically resolves to an image, not an npx host install", () => {
  const dirac = acpContainerAgents().find((a) => a.id === "dirac");
  assert.ok(dirac, "dirac must exist in the registry");
  // The exact combination that broke: npx dist + real image.
  assert.equal(dirac.dist?.kind, "npx");
  assert.ok(
    dirac.image?.startsWith("ghcr.io/moonrend/acp-registry/dirac:"),
    `dirac must resolve to a registry image, got ${dirac.image}`,
  );
});

/**
 * Mirrors AcpRegistryService.containerImageFor(). Kept in sync deliberately:
 * install and launch must resolve the SAME image or a pulled image would not
 * be the one that runs.
 */
function containerImageFor(agent: {
  id: string;
  image?: string;
  version: string;
}): { image: string; version: string } | null {
  if (!agent.image) return null;
  const version = acpSnapshotVersion(agent.id) ?? agent.version;
  const image = acpImageAtVersion(agent.id, version) ?? agent.image;
  return image ? { image, version } : null;
}

test("install resolves a concrete tagged image for every agent", () => {
  const bad: string[] = [];
  for (const agent of acpContainerAgents()) {
    const resolved = containerImageFor(agent);
    if (!resolved) {
      bad.push(`${agent.id}: no image resolved`);
      continue;
    }
    // A ref without a tag would pull :latest and silently drift.
    const tag = resolved.image.split(":").pop() ?? "";
    if (!resolved.image.includes(":") || tag.includes("/") || tag === "") {
      bad.push(`${agent.id}: untagged ref ${resolved.image}`);
    }
    if (resolved.image.split(":").length > 2) {
      bad.push(`${agent.id}: double-tagged ref ${resolved.image}`);
    }
  }
  assert.deepEqual(bad, []);
});