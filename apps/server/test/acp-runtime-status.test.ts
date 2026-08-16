import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { acpSnapshotState } from "../src/services/acp/session.js";

describe("ACP runtime snapshot", () => {
  it("does not treat a missing process as idle", () => {
    assert.equal(
      acpSnapshotState({ hasLive: false, runActive: false, starting: false }),
      "closed",
    );
    assert.equal(
      acpSnapshotState({ hasLive: false, runActive: false, starting: true }),
      "starting",
    );
  });

  it("keeps a booting or authenticating process as starting", () => {
    assert.equal(
      acpSnapshotState({
        hasLive: true,
        runActive: false,
        starting: false,
        sessionOpen: false,
      }),
      "starting",
    );
    assert.equal(
      acpSnapshotState({
        hasLive: true,
        runActive: false,
        starting: false,
        sessionOpen: true,
        authRequired: true,
      }),
      "starting",
    );
  });

  it("reports idle/active only after session/new", () => {
    assert.equal(
      acpSnapshotState({
        hasLive: true,
        runActive: false,
        starting: false,
        sessionOpen: true,
      }),
      "idle",
    );
    assert.equal(
      acpSnapshotState({
        hasLive: true,
        runActive: true,
        starting: false,
        sessionOpen: true,
      }),
      "active",
    );
  });
});
