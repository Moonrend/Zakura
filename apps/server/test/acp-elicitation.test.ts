import assert from "node:assert/strict";
import { it } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { buildAcpClient } from "../src/services/acp/client-handlers.js";
import type { LiveRuntime } from "../src/services/acp/session.js";
import { within } from "./helpers/zakurabot.js";

it("resolves URL elicitations with their original request ID and removes both aliases", async () => {
  const events: Array<{ type: string; payload: unknown }> = [];
  let sawRequest!: () => void;
  const requested = new Promise<void>((resolve) => { sawRequest = resolve; });
  let sawResponse!: (value: unknown) => void;
  const response = new Promise<unknown>((resolve) => { sawResponse = resolve; });
  const live = { chatSessionId: "child", acpSessionId: "acp-child", runId: "run", elicitations: new Map() } as LiveRuntime;
  const app = buildAcpClient({ live, agent: {} as never, chatSessionId: "child", config: {} as never, hooks: {} as never,
    deps: { workspace: {} as never, store: { async appendEvent(input) {
      events.push(input);
      if (input.type === "elicitation_request") sawRequest();
      return {} as never;
    } } },
  });
  const incoming = new TransformStream<acp.AnyMessage>();
  const connection = app.connect({ readable: incoming.readable, writable: new WritableStream({
    write(message) { if ("id" in message && message.id === 17) sawResponse(message); },
  }) });
  const writer = incoming.writable.getWriter();
  try {
    await writer.write({ jsonrpc: "2.0", id: 17, method: "elicitation/create", params: {
      sessionId: "acp-child", mode: "url", message: "Sign in", url: "https://example.test/login", elicitationId: "visit-1",
    } });
    await within(requested);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(live.elicitations.size, 2);
    assert.equal(live.elicitations.get("17"), live.elicitations.get("visit-1"));
    await writer.write({ jsonrpc: "2.0", method: "elicitation/complete", params: { elicitationId: "visit-1" } });
    assert.deepEqual(await within(response), { jsonrpc: "2.0", id: 17, result: { action: "accept" } });
    assert.deepEqual(events.find((event) => event.type === "elicitation_resolved")?.payload,
      { requestId: "17", cancelled: false });
    assert.equal(live.elicitations.size, 0);
  } finally { connection.close(); writer.releaseLock(); }
});
