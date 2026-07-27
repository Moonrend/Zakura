import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveLifecycle } from "../src/platform-services/lifecycle.js";

describe("platform service lifecycle UI", () => {
  it("disabled → off with deploy only", () => {
    const v = deriveLifecycle({
      mode: "disabled",
      status: "stopped",
      healthStatus: "unknown",
      desiredState: "stopped",
      lastError: null,
      endpointUrl: null,
    });
    assert.equal(v.state, "off");
    assert.equal(v.label, "未启用");
    assert.ok(v.actions.includes("deploy"));
    assert.ok(!v.actions.includes("connect"));
    assert.equal(v.busy, false);
  });

  it("managed + pulling progress → deploying", () => {
    const v = deriveLifecycle({
      mode: "managed",
      status: "starting",
      healthStatus: "unknown",
      desiredState: "running",
      lastError: null,
      endpointUrl: null,
      progressRunning: true,
      progressPhase: "pulling",
      progressMessage: "abc123 Downloading [==>] 12MB/40MB",
    });
    assert.equal(v.state, "deploying");
    assert.equal(v.label, "pull");
    assert.match(v.detail, /Downloading/);
    assert.equal(v.busy, true);
    assert.deepEqual(v.actions, []);
  });

  it("running healthy → available", () => {
    const v = deriveLifecycle({
      mode: "managed",
      status: "running",
      healthStatus: "healthy",
      desiredState: "running",
      lastError: null,
      endpointUrl: "http://127.0.0.1:18080",
    });
    assert.equal(v.state, "available");
    assert.equal(v.label, "running");
    assert.ok(v.actions.includes("stop"));
    assert.ok(!v.actions.includes("deploy"));
  });

  it("error → failed with retry", () => {
    const v = deriveLifecycle({
      mode: "managed",
      status: "error",
      healthStatus: "unhealthy",
      desiredState: "running",
      lastError: "Docker 不可用",
      endpointUrl: null,
    });
    assert.equal(v.state, "failed");
    assert.ok(v.actions.includes("retry"));
    assert.match(v.detail, /Docker/);
  });

  it("external healthy → external_ok", () => {
    const v = deriveLifecycle({
      mode: "external",
      status: "running",
      healthStatus: "healthy",
      desiredState: "running",
      lastError: null,
      endpointUrl: "http://127.0.0.1:8080",
    });
    assert.equal(v.state, "external_ok");
    assert.equal(v.label, "已连接");
  });
});
