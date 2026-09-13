import assert from "node:assert/strict";
import {
  agentBinaryDownloadUrl,
  agentBinaryFileName,
  isHttpUrl,
  normalizeAgentArch,
  normalizeAgentOs,
  resolveAgentUpdateTarget,
} from "../src/services/agent-binaries.js";

assert.equal(normalizeAgentOs("win32"), "windows");
assert.equal(normalizeAgentArch("x86_64"), "amd64");
assert.equal(agentBinaryFileName("linux", "arm64"), "zakura-agent_linux_arm64");
assert.equal(agentBinaryFileName("windows", "amd64"), "zakura-agent_windows_amd64.exe");
assert.equal(isHttpUrl("https://example/x"), true);
assert.equal(isHttpUrl("sunwuyuan/zakura-runner-dev:latest"), false);

const explicit = resolveAgentUpdateTarget({
  publicBaseUrl: "https://zakura.example",
  os: "linux",
  arch: "amd64",
  url: "https://cdn.example/zakura-agent",
  sha256: "abc",
  version: "1.2.3",
});
assert.equal(explicit.url, "https://cdn.example/zakura-agent");
assert.equal(explicit.sha256, "abc");
assert.equal(explicit.version, "1.2.3");

assert.equal(
  agentBinaryDownloadUrl("https://zakura.example/", "linux", "amd64"),
  "https://zakura.example/api/runtime-nodes/agent-binaries/linux/amd64",
);

try {
  resolveAgentUpdateTarget({
    publicBaseUrl: "https://zakura.example",
    os: "plan9",
    arch: "amd64",
  });
  assert.fail("bad os should throw");
} catch (err) {
  assert.match(String(err), /二进制|plan9|os/i);
}
