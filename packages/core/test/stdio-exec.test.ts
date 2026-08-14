import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { StdioExec } from "../src/stdio-exec.js";

function muxFrame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe("StdioExec non-TTY demux", () => {
  it("splits docker mux frames into stdout vs stderr", async () => {
    const stream = new PassThrough();
    const stderr: string[] = [];
    const exec = new StdioExec(stream as unknown as NodeJS.ReadWriteStream, {
      inspect: async () => ({ ExitCode: 0, Running: false }),
    });
    exec.onStderr((c) => stderr.push(c));
    const { readable } = exec.toWebStreams();
    const reader = readable.getReader();

    stream.write(Buffer.concat([muxFrame(1, '{"jsonrpc":"2.0"}\n'), muxFrame(2, "warn\n")]));

    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(Buffer.from(first.value!).toString("utf8"), '{"jsonrpc":"2.0"}\n');
    assert.equal(stderr.join(""), "warn\n");

    stream.end();
    const rest = await reader.read();
    assert.equal(rest.done, true);
  });

  it("writes stdin through to the hijacked stream", async () => {
    const stream = new PassThrough();
    const received: Buffer[] = [];
    stream.on("data", (b: Buffer) => received.push(Buffer.from(b)));
    const exec = new StdioExec(stream as unknown as NodeJS.ReadWriteStream, {
      inspect: async () => ({ ExitCode: null, Running: true }),
    });
    exec.write('{"id":1}\n');
    await new Promise((r) => setTimeout(r, 10));
    assert.match(Buffer.concat(received).toString("utf8"), /\{"id":1\}/);
    await exec.kill();
  });
});
