import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCloudAgentConfig, resolveFollowUpMode } from "@zakura/shared";

describe("parseCloudAgentConfig", () => {
  it("reads nested cloud bag", () => {
    const cfg = parseCloudAgentConfig({
      cloud: {
        systemPrompt: "你好",
        model: "gpt-4o",
        maxToolRounds: 8,
        enableTools: false,
      },
    });
    assert.equal(cfg.systemPrompt, "你好");
    assert.equal(cfg.model, "gpt-4o");
    assert.equal(cfg.maxToolRounds, 8);
    assert.equal(cfg.enableTools, false);
  });

  it("accepts high maxToolRounds without clamp", () => {
    const cfg = parseCloudAgentConfig({ cloud: { maxToolRounds: 999 } });
    assert.equal(cfg.maxToolRounds, 999);
  });

  it("reads autoMemory / autoTitle flags", () => {
    const cfg = parseCloudAgentConfig({
      cloud: { autoMemory: false, autoTitle: false },
    });
    assert.equal(cfg.autoMemory, false);
    assert.equal(cfg.autoTitle, false);
    const def = parseCloudAgentConfig({ cloud: {} });
    assert.equal(def.autoMemory, undefined);
    assert.equal(def.autoTitle, undefined);
  });

  it("reads compact budget flags", () => {
    const cfg = parseCloudAgentConfig({
      cloud: {
        autoCompact: false,
        compactThresholdChars: 20_000,
        compactSoftThresholdChars: 12_000,
        compactKeepRecent: 8,
        compactKeepRecentChars: 16_000,
        maxToolResultChars: 4_000,
        compactModel: "gpt-4o-mini",
        compactModelRouteId: "route_mini",
      },
    });
    assert.equal(cfg.autoCompact, false);
    assert.equal(cfg.compactThresholdChars, 20_000);
    assert.equal(cfg.compactSoftThresholdChars, 12_000);
    assert.equal(cfg.compactKeepRecent, 8);
    assert.equal(cfg.compactKeepRecentChars, 16_000);
    assert.equal(cfg.maxToolResultChars, 4_000);
    assert.equal(cfg.compactModel, "gpt-4o-mini");
    assert.equal(cfg.compactModelRouteId, "route_mini");
  });

  it("ignores invalid compact thresholds", () => {
    const cfg = parseCloudAgentConfig({
      cloud: {
        compactThresholdChars: 100,
        compactSoftThresholdChars: 10,
        compactKeepRecent: 1,
        compactKeepRecentChars: 100,
        maxToolResultChars: 10,
      },
    });
    assert.equal(cfg.compactThresholdChars, undefined);
    assert.equal(cfg.compactSoftThresholdChars, undefined);
    assert.equal(cfg.compactKeepRecent, undefined);
    assert.equal(cfg.compactKeepRecentChars, undefined);
    assert.equal(cfg.maxToolResultChars, undefined);
  });

  it("returns empty on invalid", () => {
    assert.deepEqual(parseCloudAgentConfig(null), {});
    assert.deepEqual(parseCloudAgentConfig("x"), {});
  });

  it("reads followUpMode and defaults resolve to steer", () => {
    assert.equal(parseCloudAgentConfig({ cloud: { followUpMode: "steer" } }).followUpMode, "steer");
    assert.equal(parseCloudAgentConfig({ cloud: { followUpMode: "queue" } }).followUpMode, "queue");
    assert.equal(parseCloudAgentConfig({ cloud: { followUpMode: "nope" } }).followUpMode, undefined);
    assert.equal(resolveFollowUpMode({}), "steer");
    assert.equal(resolveFollowUpMode({ followUpMode: "queue" }), "queue");
  });
});
