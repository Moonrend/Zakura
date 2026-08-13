import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  DockerMuxParser,
  ShellJob,
  ShellJobRegistry,
  bindExecStream,
  formatShellToolResult,
} from "../src/shell-job.js";

function muxFrame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe("DockerMuxParser", () => {
  it("parses multiplexed stdout/stderr frames", () => {
    const p = new DockerMuxParser();
    const chunk = Buffer.concat([muxFrame(1, "out"), muxFrame(2, "err")]);
    const got = p.push(chunk);
    assert.equal(got.stdout, "out");
    assert.equal(got.stderr, "err");
  });

  it("holds incomplete frames until the rest arrives", () => {
    const p = new DockerMuxParser();
    const full = muxFrame(1, "hello");
    const first = p.push(full.subarray(0, 6));
    assert.equal(first.stdout, "");
    const second = p.push(full.subarray(6));
    assert.equal(second.stdout, "hello");
  });

  it("treats TTY/raw bytes as stdout", () => {
    const p = new DockerMuxParser();
    const got = p.push(Buffer.from("Password: ", "utf8"));
    assert.equal(got.stdout, "Password: ");
    assert.equal(got.stderr, "");
  });
});

describe("ShellJob", () => {
  it("wait resolves when finish is called", async () => {
    const job = new ShellJob({ agentId: "a1" });
    const pending = job.wait(5_000);
    job.append("stdout", "hi\n");
    job.finish(0);
    const snap = await pending;
    assert.equal(snap.running, false);
    assert.equal(snap.exitCode, 0);
    assert.equal(snap.stdout, "hi\n");
  });

  it("wait does not instantly yield when previous output is already idle", async () => {
    const job = new ShellJob({ agentId: "a1" });
    job.append("stdout", "Continue? ");
    await new Promise((r) => setTimeout(r, 80));
    const started = Date.now();
    const snap = await job.wait(5_000, { idleMs: 80, startupIdleMs: 5_000 });
    assert.equal(snap.running, true);
    assert.ok(Date.now() - started >= 70);
    job.finish(0);
  });

  it("wait yields on startup silence with no output", async () => {
    const job = new ShellJob({ agentId: "a1" });
    const snap = await job.wait(5_000, { idleMs: 5_000, startupIdleMs: 40 });
    assert.equal(snap.running, true);
    assert.equal(snap.stdout, "");
    job.finish(0);
  });

  it("caps output to the tail", () => {
    const job = new ShellJob({ agentId: "a1" });
    job.append("stdout", "x".repeat(300_000));
    const snap = job.snapshot();
    assert.ok(snap.stdout.length <= 256_000);
    assert.ok(snap.stdout.includes("truncated"));
    assert.ok(snap.stdout.endsWith("x".repeat(100)));
    job.finish(0);
  });

  it("formatShellToolResult tells the model how to continue a running job", () => {
    const job = new ShellJob({ agentId: "a1", id: "sh_test" });
    job.append("stdout", "n");
    const body = formatShellToolResult(job.snapshot());
    assert.equal(body.status, "running");
    assert.equal(body.job_id, "sh_test");
    assert.match(String(body.note), /job_id/);
    job.finish(0);
  });

  it("folds ora-style spinner frames into the last line", () => {
    const job = new ShellJob({ agentId: "a1" });
    const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
      .split("")
      .map((c) => `\x1b[1G\x1b[0K${c}`)
      .join("");
    job.append("stdout", `${frames}\x1b[1G\x1b[0Ka\n`);
    assert.equal(job.snapshot().stdout, "a\n");
    job.finish(0);
  });

  it("holds a CSI split across appends", () => {
    const job = new ShellJob({ agentId: "a1" });
    job.append("stdout", "\x1b[1");
    job.append("stdout", "G\x1b[0Khello");
    assert.equal(job.snapshot().stdout, "hello");
    job.finish(0);
  });

  it("strips color codes and keeps real output", () => {
    const job = new ShellJob({ agentId: "a1" });
    job.append("stdout", "\x1b[31mred\x1b[0m\n");
    assert.equal(job.snapshot().stdout, "red\n");
    job.finish(0);
  });
});

describe("ShellJobRegistry", () => {
  it("scopes lookup by agent", () => {
    const reg = new ShellJobRegistry();
    const job = new ShellJob({ agentId: "a1", id: "sh_1" });
    reg.add(job);
    assert.equal(reg.getForAgent("a1", "sh_1"), job);
    assert.equal(reg.getForAgent("a2", "sh_1"), undefined);
  });
});

describe("bindExecStream", () => {
  it("appends muxed bytes and finishes on end", async () => {
    const job = new ShellJob({ agentId: "a1" });
    const stream = new PassThrough();
    bindExecStream(job, stream, {
      inspect: async () => ({ ExitCode: 0 }),
    });
    stream.write(muxFrame(1, "hello"));
    stream.end();
    const snap = await job.wait(1_000);
    assert.equal(snap.stdout, "hello");
    assert.equal(snap.running, false);
    assert.equal(snap.exitCode, 0);
  });
});
