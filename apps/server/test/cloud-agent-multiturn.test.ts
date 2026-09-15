import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelChatInvokeOptions, ModelChatMessage } from "@zakura/shared";
import type { Agent } from "../src/db/schema.js";
import { CloudAgentRuntime } from "../src/services/cloud-agent/runtime.js";
import { listAgentNativeTools } from "../src/services/agent-tools.js";
import { NATIVE_ALWAYS_ON_LOCAL_NAMES } from "../src/services/cloud-agent/tools.js";
import { packOpenAiChatTools } from "../src/model-router/openai-tools.js";
import { mapMessagesToResponsesInput } from "../src/model-router/openai-responses-api.js";

type Event = { type: string; runId?: string | null; payload: Record<string, unknown>; seq: number };

describe("cloud agent multi-turn tool availability", () => {
  it("rebuilds the full tool surface on second and third user runs, including after a compaction checkpoint", { timeout: 10_000 }, async () => {
    const agent = {
      id: "a1", tenantId: "t1", slug: "test", name: "Test", enableComputer: true, enableMemory: true,
      workspaceStatus: "ready", configJson: JSON.stringify({ cloud: { model: "gpt-5.4", autoMemory: false, autoTitle: false, autoCompact: false } }),
    } as Agent;
    const session = { id: "s1", tenantId: "t1", agentId: "a1", kind: "chat", title: "Test", activeRunId: null as string | null, lastSeq: 0 };
    const events: Event[] = [];
    const runs = new Map<string, { id: string; status: string }>();
    const completed = new Map<string, { promise: Promise<string>; resolve: (status: string) => void }>();
    const store = {
      getSession: async () => ({ ...session }),
      createRun: async () => {
        const run = { id: `r${runs.size + 1}`, status: "queued" };
        runs.set(run.id, run);
        session.activeRunId = run.id;
        let resolve!: (status: string) => void;
        const promise = new Promise<string>((done) => { resolve = done; });
        completed.set(run.id, { promise, resolve });
        return run;
      },
      getRun: async (id: string) => runs.get(id),
      markRunStarted: async (id: string) => { runs.get(id)!.status = "running"; },
      warmSession: async () => {},
      appendEvent: async (input: Omit<Event, "seq">) => {
        const event = { ...input, seq: ++session.lastSeq };
        events.push(event);
        return { ...event, id: `e${event.seq}`, createdAt: "" };
      },
      listEventsForChain: async (_sessionId: string, opts: { afterSeq: number }) => events.filter((e) => e.seq > opts.afterSeq),
      getLastCompaction: async () => events.findLast((e) => e.type === "context_compacted") ?? null,
      isCancelRequested: async () => false,
      onRunCancel: () => () => {},
      drainSteerQueued: async () => [],
      takeQueueNext: async () => null,
      takeNextQueued: async () => null,
      finishRun: async (_sessionId: string, id: string, status: string) => {
        runs.get(id)!.status = status;
        session.activeRunId = null;
        completed.get(id)!.resolve(status);
      },
    };
    const snapshots: Array<{ messages: ModelChatMessage[]; options: ModelChatInvokeOptions; request: any }> = [];
    let enumerations = 0;
    const runtime = new CloudAgentRuntime({
      store: store as never,
      agentService: { get: async () => ({ ...agent }), list: async () => [agent] } as never,
      gateway: {
        listToolsForAgent: async (current: Agent) => { enumerations++; return listAgentNativeTools(current); },
        callTool: async () => ({ content: [{ type: "text", text: '{"path":"/a.txt","type":"file"}' }] }),
      } as never,
      modelRouter: {
        resolveRoute: async () => ({ meta: { contextLimit: 128_000 } }),
        chatStream: async (_tenant: string, messages: ModelChatMessage[], _route: unknown, options: ModelChatInvokeOptions) => {
          const packed = packOpenAiChatTools(options.tools, "gpt-5.4", { format: "responses", messages })!;
          snapshots.push(structuredClone({ messages, options, request: { ...mapMessagesToResponsesInput(messages, packed.tools), tools: packed.tools } }));
          return snapshots.length % 2 === 1
            ? { model: "test", routeSlug: "test", openai: {}, content: null, toolCalls: [{ id: `call-${snapshots.length}`, type: "function", namespace: "workspace_files", function: { name: "re_fs_stat", arguments: '{"path":"/a.txt"}' } }] }
            : { model: "test", routeSlug: "test", openai: {}, content: "Done" };
        },
      } as never,
    });

    const turn = async (content: string) => {
      const { runId } = await runtime.startTurn({ tenantId: "t1", agentId: "a1", sessionId: "s1", content });
      assert.equal(await completed.get(runId)!.promise, "completed", JSON.stringify(events.filter((e) => e.type === "run_error")));
    };
    await turn("Inspect a.txt");
    agent.workspaceStatus = "stopped";
    await turn("Inspect it again");
    await store.appendEvent({ type: "context_compacted", payload: { summary: "The file was inspected in earlier turns." } });
    await turn("Read the file once more");

    assert.equal(enumerations, 3, "each new user run must enumerate tools");
    assert.equal(snapshots.length, 6, "each run includes a tool-result continuation");
    for (const snapshot of snapshots) {
      for (const localName of NATIVE_ALWAYS_ON_LOCAL_NAMES) {
        const name = `re_${localName}`;
        assert.ok(snapshot.options.tools?.some((tool) => tool.function.name === name && !tool.deferLoading), name);
        assert.ok(snapshot.request.tools.some((tool: any) => tool.type === "function" && tool.name === name && tool.defer_loading !== true), name);
      }
      assert.ok(snapshot.request.tools.some((tool: any) => tool.type === "tool_search"));
    }
    const secondRun = snapshots[2]!;
    const previousCall = secondRun.messages.flatMap((message) => message.toolCalls ?? []).find((call) => call.id === "call-1");
    assert.equal(previousCall?.namespace, "workspace_files", "durable tool events must preserve Responses namespaces");
    assert.equal(secondRun.request.input.find((item: any) => item.call_id === "call-1").namespace, "workspace_files");
    const files = secondRun.request.tools.find((tool: any) => tool.type === "namespace" && tool.name === "workspace_files");
    assert.ok(files.tools.every((tool: any) => tool.defer_loading !== true));
    assert.ok(snapshots[4]!.messages.some((message) => message.role === "system" && message.content?.includes("earlier turns")));
    assert.equal(snapshots[4]!.messages.some((message) => message.toolCalls?.length), false);
  });
});
