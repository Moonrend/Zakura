import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  AgentBinaryChangedError,
  agentBinaryDownloadUrl,
  agentBinaryFileName,
  findAgentBinary,
  isHttpUrl,
  normalizeAgentArch,
  normalizeAgentOs,
  openAgentBinaryStream,
  resolveAgentUpdateTarget,
} from "../src/services/agent-binaries.js";

let directory: string;
let catalog: string;
let originalDirectory: string | undefined;
let originalVersion: string | undefined;

beforeEach(async (t) => {
  directory = await mkdtemp(join(tmpdir(), "zakura-agent-binaries-"));
  catalog = join(directory, "catalog");
  await mkdir(catalog);
  originalDirectory = process.env.ZAKURA_AGENT_BINARIES_DIR;
  originalVersion = process.env.ZAKURA_AGENT_VERSION;
  process.env.ZAKURA_AGENT_BINARIES_DIR = catalog;
  delete process.env.ZAKURA_AGENT_VERSION;
  // Isolate fallback searches from any real release artifacts in the checkout.
  t.mock.method(process, "cwd", () => join(directory, "apps", "server"));
});

afterEach(async () => {
  if (originalDirectory === undefined) delete process.env.ZAKURA_AGENT_BINARIES_DIR;
  else process.env.ZAKURA_AGENT_BINARIES_DIR = originalDirectory;
  if (originalVersion === undefined) delete process.env.ZAKURA_AGENT_VERSION;
  else process.env.ZAKURA_AGENT_VERSION = originalVersion;
  await rm(directory, { recursive: true, force: true });
});

function executable(os = "linux", arch = "amd64", revision = 1): Buffer {
  const data = Buffer.alloc(256);
  if (os === "linux") {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(data);
    data.writeUInt16LE(arch === "amd64" ? 62 : 183, 18);
  } else if (os === "darwin") {
    data.writeUInt32LE(0xfeedfacf, 0);
    data.writeUInt32LE(arch === "amd64" ? 0x01000007 : 0x0100000c, 4);
  } else {
    data.write("MZ");
    data.writeUInt32LE(128, 60);
    data.write("PE\0\0", 128);
    data.writeUInt16LE(arch === "amd64" ? 0x8664 : 0xaa64, 132);
  }
  data[255] = revision;
  return data;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

const baseTarget = { publicBaseUrl: "https://zakura.example/", os: "linux", arch: "amd64" };

test("normalizes supported platforms and rejects malformed download URLs", () => {
  assert.equal(normalizeAgentOs(" Win32 "), "windows");
  assert.equal(normalizeAgentOs("macOS"), "darwin");
  assert.equal(normalizeAgentOs("plan9"), null);
  assert.equal(normalizeAgentArch(" X86_64 "), "amd64");
  assert.equal(normalizeAgentArch("aarch64"), "arm64");
  assert.equal(normalizeAgentArch("386"), null);
  assert.equal(agentBinaryFileName("linux", "arm64"), "zakura-agent_linux_arm64");
  assert.equal(agentBinaryFileName("windows", "amd64"), "zakura-agent_windows_amd64.exe");
  assert.equal(isHttpUrl("https://example/x"), true);
  for (const value of [undefined, "https://", "file:///tmp/agent", "sunwuyuan/zakura-runner-dev:latest"]) {
    assert.equal(isHttpUrl(value), false);
  }
  assert.equal(
    agentBinaryDownloadUrl("https://zakura.example///", "linux", "amd64"),
    "https://zakura.example/api/runtime-nodes/agent-binaries/linux/amd64",
  );
});

test("custom downloads require their own valid digest and never inherit catalog metadata", async () => {
  await writeFile(join(catalog, "zakura-agent_linux_amd64"), executable());
  await writeFile(join(catalog, "VERSION"), "catalog-version\n");
  const digest = "ab".repeat(32);
  const explicit = await resolveAgentUpdateTarget({
    ...baseTarget, url: " https://cdn.example/zakura-agent ",
    sha256: ` ${digest.toUpperCase()} `, version: " 1.2.3 ",
  });
  assert.deepEqual(explicit, {
    url: "https://cdn.example/zakura-agent", sha256: digest,
    version: "1.2.3", filename: "zakura-agent_linux_amd64",
  });
  const legacy = await resolveAgentUpdateTarget({
    ...baseTarget, image: explicit.url, sha256: digest,
  });
  assert.equal(legacy.version, "custom");
  for (const invalid of [undefined, "", "abc", "zz".repeat(32)]) {
    await assert.rejects(
      resolveAgentUpdateTarget({ ...baseTarget, url: explicit.url, sha256: invalid }), /sha256/,
    );
  }
  await assert.rejects(
    resolveAgentUpdateTarget({ ...baseTarget, image: "registry/runner:latest", sha256: digest }), /HTTP/,
  );
});

test("recognizes executable headers for all six release targets", async () => {
  await writeFile(join(catalog, "VERSION"), "1.2.3\n");
  for (const os of ["linux", "darwin", "windows"]) {
    for (const arch of ["amd64", "arm64"]) {
      const data = executable(os, arch);
      const path = join(catalog, agentBinaryFileName(os, arch));
      await writeFile(path, data);
      const binary = await findAgentBinary(os, arch);
      assert.ok(binary);
      assert.equal(binary.path, path);
      assert.equal(binary.sha256, sha256(data));
      assert.equal(binary.size, data.length);
      assert.equal(binary.version, "1.2.3");
    }
  }
});

test("bare and incorrectly named executables cannot be served for another platform", async () => {
  await writeFile(join(catalog, "zakura-agent"), executable());
  await writeFile(join(catalog, "zakura-agent_linux_arm64"), executable());
  await writeFile(join(catalog, "zakura-agent_windows_amd64.exe"), "<html>download failed</html>");
  assert.ok(await findAgentBinary("linux", "amd64"));
  for (const [os, arch] of [["linux", "arm64"], ["darwin", "amd64"], ["windows", "amd64"], ["plan9", "amd64"]]) {
    assert.equal(await findAgentBinary(os, arch), null);
  }
  const invalidPE = executable("windows");
  invalidPE.writeUInt32LE(0xffffffff, 60);
  await writeFile(join(catalog, "zakura-agent.exe"), invalidPE);
  assert.equal(await findAgentBinary("windows", "amd64"), null);
});

test("version metadata comes from the directory containing the selected binary", async () => {
  await writeFile(join(catalog, "VERSION"), "unrelated-release\n");
  const fallback = join(directory, "go", "agent", "dist");
  await mkdir(fallback, { recursive: true });
  await writeFile(join(fallback, "VERSION"), "selected-release\n");
  await writeFile(join(fallback, "zakura-agent_linux_amd64"), executable());
  assert.equal((await findAgentBinary("linux", "amd64"))?.version, "selected-release");
  process.env.ZAKURA_AGENT_VERSION = " explicit-release ";
  assert.equal((await findAgentBinary("linux", "amd64"))?.version, "explicit-release");
});

test("catalog targets pin the SHA in their URL and unavailable targets reject asynchronously", async () => {
  const data = executable();
  await writeFile(join(catalog, "zakura-agent_linux_amd64"), data);
  const target = await resolveAgentUpdateTarget(baseTarget);
  assert.equal(target.sha256, sha256(data));
  assert.equal(target.url, `https://zakura.example/api/runtime-nodes/agent-binaries/linux/amd64?sha256=${sha256(data)}`);
  assert.equal(target.version, "dev");
  await assert.rejects(resolveAgentUpdateTarget({ ...baseTarget, os: "plan9" }), /二进制|plan9/);
  await assert.rejects(resolveAgentUpdateTarget({ ...baseTarget, arch: "arm64" }), /arm64/);
});

test("concurrent readers agree, and republishing invalidates same-size, same-mtime metadata", async () => {
  const path = join(catalog, "zakura-agent_linux_amd64");
  const old = executable();
  const updated = executable("linux", "amd64", 2);
  await writeFile(path, old);
  const before = await stat(path);
  const readers = await Promise.all(Array.from({ length: 16 }, () => findAgentBinary("linux", "amd64")));
  assert.ok(readers.every((binary) => binary?.sha256 === sha256(old)));
  const replacement = join(catalog, "replacement");
  await writeFile(replacement, updated);
  await utimes(replacement, before.atime, before.mtime);
  await rename(replacement, path);
  assert.equal((await findAgentBinary("linux", "amd64"))?.sha256, sha256(updated));
  await assert.rejects(openAgentBinaryStream(readers[0]!), AgentBinaryChangedError);
});

test("an opened download stays on the verified inode while a new release is published", async () => {
  const path = join(catalog, "zakura-agent_linux_amd64");
  const old = executable();
  await writeFile(path, old);
  const binary = await findAgentBinary("linux", "amd64");
  assert.ok(binary);
  const stream = await openAgentBinaryStream(binary);
  try {
    const replacement = join(catalog, "replacement");
    await writeFile(replacement, executable("linux", "amd64", 2));
    await rename(replacement, path);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), old);
  } finally {
    stream.destroy();
  }
  await rm(path);
  await assert.rejects(openAgentBinaryStream(binary), AgentBinaryChangedError);
});
