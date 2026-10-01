/**
 * E2E: create space → create agent in that space → start agent (workspace
 * provisioning through the space) → open the zakurabot channel → send a user
 * message → assert the agent reply / echo returns over the wire.
 *
 * Drives the real stack in-process:
 * - real AgentService (spaces + agent + workspace start via a stubbed runner node)
 * - real CloudAgentRuntime with a stubbed model provider (returns a chat_reply tool call)
 * - real RemoteAgentIngress + ZakurabotChannel + ZakurabotGateway over a real WS
 *
 * Docker is faked at the RuntimeNodeService boundary (same seam used by
 * workspace-ensure-started.test.ts); nothing leaves the process.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ModelChatInvokeOptions, ModelChatMessage } from "@zakura/shared";
import { eq } from "drizzle-orm";
import { agentChannelThreads, managedContainers, runtimeNodes } from "../src/db/schema.js";
import { AgentService } from "../src/services/agents.js";
import { CloudAgentRuntime } from "../src/services/cloud-agent/runtime.js";
import { RemoteAgentIngress } from "../src/services/remote-agent-ingress.js";
import { ZakurabotChannel } from "../src/services/zakurabot-channel.js";
import { ZakurabotGateway } from "../src/services/zakurabot-gateway.js";
import { ZakurabotInteractionService } from "../src/services/zakurabot-interactions.js";
import { within, zakurabotHarness } from "./helpers/zakurabot.js";

describe("e2e spaces -> agent -> start -> zakurabot message echo", () => {
  let h: Awaited<ReturnType<typeof zakurabotHarness>>;
  let extraGateway: ZakurabotGateway | undefined;

  before(async () => {
    h = await zakurabotHarness();
  });

  after(async () => {
    await extraGateway?.close();
    await h?.close();
  });

  it("creates a space + agent, starts it, and echoes a channel message through the runtime", async () => {
    const ctx = await h.access();

    // ── 1. Workspace provisioning seam: fake runner node, no Docker ──────
    const starts: string[] = [];
    const fakeClient = {
      ping: async () => ({ ok: true, docker: { ok: true, version: "test" } }),
      startWorkspace: async (args: { spaceId: string }) => {
        starts.push(args.spaceId);
        return { dockerId: "ctr-e2e", name: "ws-e2e", image: "full", status: "running", endpoints: {}, labels: {} };
      },
      getWorkspace: async () => ({ status: "running", dockerId: "ctr-e2e" }),
      execWorkspace: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      mkdir: async () => ({}),
    };
    const nodes = {
      requireRunnerClient: async () => ({
        client: fakeClient,
        node: { id: "node-1", status: "online", name: "Test node" },
      }),
    };
    const agentService = new AgentService(h.db, {} as never, h.config, nodes as never);

    // A runtime node row is required by the space.runtime_node_id FK.
    await h.db.insert(runtimeNodes).values({
      id: "node-1",
      tenantId: ctx.tenantId,
      name: "Test node",
      slug: "test-node",
      kind: "server",
      status: "online",
      storageRoot: "/tmp/e2e-node",
    });

    // ── 2. Space + agent creation through the real service ───────────────
    const space = await agentService.spaces.create(ctx.tenantId, { name: "E2E Space" });
    assert.equal(space.tenantId, ctx.tenantId);
    assert.equal(space.slug, "e2e-space");

    const created = await agentService.create(ctx.tenantId, {
      name: "E2E Echo",
      spaceId: space.id,
      createApiKey: false,
      config: {
        cloud: { model: "test-model", autoMemory: false, autoTitle: false, autoCompact: false },
      },
    });
    assert.equal(created.agent.spaceId, space.id, "agent lands in the requested space");
    assert.equal(created.agent.slug, "e2e-echo");

    // ── 3. Start (workspace provisioning resolved through the space) ─────
    const started = await agentService.startAsync(ctx.tenantId, created.agent.id, {
      runtimeNodeId: "node-1",
    });
    assert.equal(started.spaceId, space.id);
    assert.deepEqual(starts, [space.id], "workspace started once for the space");
    const container = await agentService.workspace.getWorkspaceContainer(space.id);
    assert.equal(container?.status, "running");
    const containers = await h.db
      .select()
      .from(managedContainers)
      .where(eq(managedContainers.spaceId, space.id));
    assert.equal(containers.length, 1);
    assert.equal(containers[0]!.purpose, "workspace");

    // ── 4. Real runtime with a stubbed model provider ────────────────────
    let modelCalls = 0;
    const runtime = new CloudAgentRuntime({
      store: h.sessions,
      agentService: agentService as never,
      gateway: {
        listToolsForAgent: async () => [],
        callTool: async () => ({ content: [] }),
      } as never,
      modelRouter: {
        resolveRoute: async () => ({ meta: { contextLimit: 128_000 } }),
        chatStream: async (
          _tenant: string,
          messages: ModelChatMessage[],
          _route: unknown,
          options: ModelChatInvokeOptions,
        ) => {
          assert.ok(
            options.tools?.some((tool) => tool.function.name === "chat_reply"),
            "bound remote session exposes chat_reply",
          );
          assert.ok(
            messages.some((m) => m.role === "user" && m.content?.includes("Hello from e2e")),
            "inbound text reaches the model",
          );
          modelCalls += 1;
          return modelCalls === 1
            ? {
                model: "test", routeSlug: "test", openai: {}, content: null,
                toolCalls: [{
                  id: "reply", type: "function" as const,
                  function: { name: "chat_reply", arguments: JSON.stringify({ text: "E2E reply" }) },
                }],
              }
            : { model: "test", routeSlug: "test", openai: {}, content: "private done" };
        },
      } as never,
      remoteChannels: h.registry,
    });

    // Re-point the channel at a real ingress/runtime. The harness closes its own
    // gateway first (same pattern as the offline-replay test).
    await h.gateway.close();
    const ingress = new RemoteAgentIngress(h.db, agentService as never, h.sessions, runtime, h.config);
    // h.gateway.close() stopped the harness's interaction service; build a fresh one.
    const interactions = new ZakurabotInteractionService(h.db, { sessions: h.sessions, askUser: h.askUser });
    const channel = new ZakurabotChannel({
      ...h.channel.deps,
      ingress,
      agents: agentService as never,
      interactions,
    });
    extraGateway = new ZakurabotGateway(channel, { publicBaseUrl: h.url });
    extraGateway.attach(h.server);

    // ── 5. Open the conversation and send a message ──────────────────────
    const socket = await h.connect(ctx.token);
    const ready = await socket.wait("ready");
    const rosterAgent = ready.agents.find((agent) => agent.id === created.agent.id);
    assert.ok(rosterAgent, "new agent appears in the zakurabot roster");
    assert.ok(rosterAgent!.bindingId, "roster carries the auto-provisioned binding");

    const clientMessageId = "e2e-msg-1";
    socket.send({ type: "send", agentId: created.agent.id, clientMessageId, text: "Hello from e2e" });

    const echo = await within(
      socket.wait("message", (frame) => frame.message.clientMessageId === clientMessageId),
      "no user echo",
      10_000,
    );
    assert.equal(echo.message.agentId, created.agent.id);
    assert.equal(echo.message.role, "user");

    const reply = await within(
      socket.wait("chat_reply", (frame) => frame.payload.reply_to === clientMessageId),
      "no chat_reply",
      10_000,
    );
    assert.equal(reply.payload.text, "E2E reply");
    assert.equal(reply.payload.kind, "markdown");
    assert.equal(
      JSON.stringify(socket.frames).includes("private done"),
      false,
      "assistant mirror text never leaks to the channel",
    );

    // ── 6. Session bookkeeping stays consistent ──────────────────────────
    const threads = await h.db
      .select()
      .from(agentChannelThreads)
      .where(eq(agentChannelThreads.bindingId, rosterAgent!.bindingId!));
    assert.equal(threads.length, 1);
    const sessionId = threads[0]!.sessionId;

    await within(
      (async () => {
        for (;;) {
          const session = await h.sessions.getSession(ctx.tenantId, created.agent.id, sessionId);
          if (session && session.activeRunId === null && session.lastSeq > 0) {
            const events = await h.sessions.listEvents(sessionId, { limit: 500 });
            if (events.some((event) => event.type === "run_end")) return;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      })(),
      "run did not finish",
      10_000,
    );

    const events = await h.sessions.listEvents(sessionId, { limit: 500 });
    const types = events.map((event) => event.type);
    for (const type of [
      "user_message",
      "run_start",
      "tool_call_start",
      "tool_call_result",
      "assistant_message",
      "run_end",
    ]) {
      assert.ok(types.includes(type), `missing event ${type}`);
    }
    assert.equal(events[0]!.seq, 1);
    assert.deepEqual(
      events.map((event) => event.seq),
      Array.from({ length: events.length }, (_, index) => index + 1),
      "seqs are contiguous from 1",
    );
    const end = events.find((event) => event.type === "run_end")!;
    assert.equal(end.payload.status, "completed");
    const session = await h.sessions.getSession(ctx.tenantId, created.agent.id, sessionId);
    assert.equal(session?.activeRunId, null);
    assert.equal(session?.lastSeq, events[events.length - 1]!.seq);

    await socket.close();
  });
});
