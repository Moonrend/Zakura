import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  acpHotModelConfigId,
  acpSnapshotState,
  overlayAcpGatewayModels,
} from "../src/services/acp/session.js";

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

describe("overlayAcpGatewayModels", () => {
  const gateway = [
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "gpt-5.2" },
    { id: "claude-sonnet-4" },
  ];
  const gatewayIds = gateway.map((m) => m.id);
  const official = {
    currentId: "gpt-5.2-codex",
    available: [
      { id: "gpt-5.2-codex", name: "gpt-5.2-codex" },
      { id: "gpt-5.1-codex", name: "gpt-5.1-codex" },
    ],
    configId: "model",
  };

  it("passes through when not Zakura-routed", () => {
    const out = overlayAcpGatewayModels({
      zakuraRouted: false,
      gatewayModels: gateway,
      incoming: official,
    });
    assert.equal(out.available.length, 2);
    assert.equal(out.currentId, "gpt-5.2-codex");
  });

  it("keeps the gateway catalog after Codex reports official models", () => {
    const out = overlayAcpGatewayModels({
      zakuraRouted: true,
      gatewayModels: gateway,
      incoming: official,
      previous: {
        currentId: "kimi-k2.5",
        available: gateway.map((m) => ({ id: m.id, name: m.name || m.id })),
        configId: "model",
      },
    });
    assert.deepEqual(
      out.available.map((m) => m.id),
      gatewayIds,
    );
    assert.equal(out.currentId, "kimi-k2.5");
    assert.equal(out.configId, "model");
  });

  it("does not switch current to an official id that happens to exist on the gateway", () => {
    const out = overlayAcpGatewayModels({
      zakuraRouted: true,
      gatewayModels: gateway,
      incoming: { ...official, currentId: "gpt-5.2" },
      previous: {
        currentId: "kimi-k2.5",
        available: gateway.map((m) => ({ id: m.id, name: m.name || m.id })),
      },
    });
    assert.equal(out.currentId, "kimi-k2.5");
  });
});

describe("acpHotModelConfigId", () => {
  it("refuses Codex/Grok gateway aliases (Invalid params)", () => {
    assert.equal(
      acpHotModelConfigId({
        zakuraRouted: true,
        profileId: "codex",
        models: { configId: "model" },
      }),
      undefined,
    );
    assert.equal(
      acpHotModelConfigId({
        zakuraRouted: true,
        profileId: "grok",
        models: { configId: "model" },
      }),
      undefined,
    );
  });

  it("keeps OpenCode and native Codex setters", () => {
    assert.equal(
      acpHotModelConfigId({
        zakuraRouted: true,
        profileId: "opencode",
        models: { configId: "model" },
      }),
      "model",
    );
    assert.equal(
      acpHotModelConfigId({
        zakuraRouted: false,
        profileId: "codex",
        models: { configId: "model" },
      }),
      "model",
    );
    assert.equal(
      acpHotModelConfigId({
        zakuraRouted: false,
        profileId: "codex",
        models: { configId: "_unstable_model" },
      }),
      undefined,
    );
  });
});
