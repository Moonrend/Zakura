import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGoAgentInstall } from "../src/runner.js";

describe("buildGoAgentInstall", () => {
  it("Windows 安装命令不用 irm | iex", () => {
    const got = buildGoAgentInstall({
      publicBaseUrl: "https://preview.example",
      nodeId: "n1",
      token: "rnr_abc",
      kind: "computer",
    });
    assert.equal(
      got.installPs1,
      'iex (iwr -UseBasicParsing "https://preview.example/api/runtime-nodes/n1/install.ps1?token=rnr_abc&kind=computer").Content',
    );
    assert.doesNotMatch(got.installPs1, /\birm\b/);
    assert.match(got.installCurl, /curl -fsSL/);
  });
});
