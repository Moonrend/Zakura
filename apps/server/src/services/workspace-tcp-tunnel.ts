import { createServer, type AddressInfo, type Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type * as WebStreams from "node:stream/web";
import type { TcpTunnel } from "../runtime/docker.js";

type StdioBridge = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  kill: () => Promise<void>;
};

/** A server-local endpoint carried by the authenticated Runner stdio channel. */
export async function openWorkspaceTcpTunnel(
  start: () => Promise<StdioBridge>,
  onError: (error: unknown) => void = () => undefined,
): Promise<TcpTunnel> {
  const connections = new Map<Socket, () => void>();
  const server = createServer((socket) => {
    let bridge: StdioBridge | undefined;
    let input: Writable | undefined;
    let output: Readable | undefined;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      connections.delete(socket);
      socket.destroy();
      input?.destroy();
      output?.destroy();
      void bridge?.kill().catch(() => undefined);
    };
    connections.set(socket, cleanup);
    socket.on("error", cleanup);
    socket.once("close", cleanup);
    socket.setTimeout(60_000, cleanup);
    void (async () => {
      try {
        bridge = await start();
        if (closed || socket.destroyed) {
          await bridge.kill();
          return;
        }
        input = Writable.fromWeb(bridge.writable as WebStreams.WritableStream<Uint8Array>);
        output = Readable.fromWeb(bridge.readable as WebStreams.ReadableStream<Uint8Array>);
        // pipeline propagates backpressure, closes the streams and observes errors.
        await Promise.all([
          pipeline(socket, input).finally(cleanup),
          pipeline(output, socket).finally(cleanup),
        ]);
      } catch (error) {
        if (!closed) onError(error);
      } finally { cleanup(); }
    })();
  });
  server.on("error", onError);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  server.unref();
  const port = (server.address() as AddressInfo).port;
  return {
    host: "127.0.0.1", port, url: `http://127.0.0.1:${port}`,
    close: () => {
      for (const cleanup of connections.values()) cleanup();
      server.close();
    },
  };
}
