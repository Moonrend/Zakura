import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelChatMessage } from "@zakura/shared";
import type { Agent } from "../src/db/schema.js";
import type { ResolvedRoute } from "../src/model-router/types.js";
import { mapOpenAiCompatibleMessages, openAiAdapter } from "../src/model-router/adapters/openai-compatible.js";
import { codexAdapter } from "../src/model-router/adapters/codex.js";
import { mapMessagesToResponsesInput, responsesChat, responsesChatStream } from "../src/model-router/openai-responses-api.js";
import { listAgentNativeTools } from "../src/services/agent-tools.js";
import { toolsToDefinitions } from "../src/services/cloud-agent/tools.js";

const { definitions } = toolsToDefinitions(listAgentNativeTools({ enableComputer: true, enableMemory: true } as Agent));
const route: ResolvedRoute = {
  routeId: "r1", routeSlug: "test", alias: "test", capability: "chat", model: "gpt-5.4", weight: 100, options: {},
  upstream: { id: "up", protocol: "openai", config: { baseUrl: "https://models.example.test/v1", apiKey: "test" } },
};
const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "re_fs_stat", namespace: "workspace_files", arguments: '{"path":"/a.txt"}' };
const answer = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] };

function sse(events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}

describe("OpenAI tool continuation requests", () => {
  for (const adapter of [openAiAdapter, codexAdapter]) {
    for (const stream of [false, true]) {
      it(`${adapter.protocol} preserves tools and namespaces across tool results and a second user turn (stream=${stream})`, async (t) => {
        const requests: any[] = [];
        t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
          const body = JSON.parse(String(init.body));
          requests.push(body);
          const output = requests.length === 1 ? [call] : [answer];
          const response = { id: "resp_test", model: route.model, status: "completed", output };
          if (!stream) return Response.json(response);
          return sse([
            ...(requests.length === 1 ? [
              { type: "response.output_item.added", output_index: 2, item: { ...call, arguments: "" } },
              { type: "response.function_call_arguments.delta", output_index: 2, item_id: call.id, delta: call.arguments },
            ] : []),
            { type: "response.completed", response },
          ]);
        });
        const currentRoute = { ...route, upstream: { ...route.upstream, protocol: adapter.protocol } };
        const messages: ModelChatMessage[] = [{ role: "user", content: "Inspect the file" }];
        const invoke = () => stream
          ? adapter.chatStream!(currentRoute, messages, { tools: definitions }, {})
          : adapter.chat!(currentRoute, messages, { tools: definitions });
        const first = await invoke();
        messages.push({ role: "assistant", content: first.content, toolCalls: first.toolCalls });
        messages.push({ role: "tool", toolCallId: "call_1", content: '{"path":"/a.txt","type":"file"}' });
        const second = await invoke();
        messages.push({ role: "assistant", content: second.content }, { role: "user", content: "Move the file" });
        await invoke();

        assert.equal(requests.length, 3);
        for (const request of requests) {
          for (const name of ["re_fs_read", "re_shell_exec", "re_browser_observe", "re_memory_context"]) {
            assert.ok(request.tools.some((tool: any) => tool.type === "function" && tool.name === name && tool.defer_loading !== true), name);
          }
          assert.ok(request.tools.some((tool: any) => tool.type === "tool_search"));
        }
        for (const request of requests.slice(1)) {
          assert.equal(request.input.find((item: any) => item.type === "function_call").namespace, "workspace_files");
          const files = request.tools.find((tool: any) => tool.type === "namespace" && tool.name === "workspace_files");
          assert.ok(files.tools.every((tool: any) => tool.defer_loading !== true), "used namespace must be callable on stateless continuation");
        }
      });
    }
  }

  for (const failure of ["http", "stream"] as const) {
    it(`falls back with flat Chat tools when Responses reports a ${failure} error`, async (t) => {
      const requests: Array<{ url: string; body: any }> = [];
      t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        requests.push({ url, body });
        if (url.endsWith("/responses")) {
          return failure === "http"
            ? Response.json({ error: { message: "Responses unsupported" } }, { status: 404 })
            : sse([{ type: "response.failed", response: { status: "failed", error: { code: "invalid_request_error", message: "function namespace missing" } } }]);
        }
        return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "read", type: "function", function: { name: "re_fs_read", arguments: '{"path":"/a.txt"}' } }] }, finish_reason: "tool_calls" }] }]);
      });
      const result = await openAiAdapter.chatStream!(route, [{ role: "user", content: "Read a.txt" }], { tools: definitions }, {});
      assert.equal(requests.length, 2);
      const fallback = requests[1]!.body;
      assert.ok(fallback.tools.every((tool: any) => tool.type === "function" && tool.function?.name));
      assert.ok(fallback.tools.some((tool: any) => tool.function.name === "re_fs_read"));
      assert.equal(result.toolCalls?.[0]?.function.name, "re_fs_read");
    });
  }

  it("does not silently finish failed, incomplete or unterminated Responses streams", async (t) => {
    const failures = [
      { type: "response.failed", response: { status: "failed", error: { message: "namespace missing" } } },
      { type: "error", message: "tool schema rejected" },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
      { type: "response.created", response: { status: "in_progress" } },
    ];
    for (const failure of failures) {
      const mock = t.mock.method(globalThis, "fetch", async () => sse([failure]));
      await assert.rejects(responsesChatStream(route, [{ role: "user", content: "Continue" }], [], undefined, {}), /responses/i);
      mock.mock.restore();
    }
  });

  it("rejects a failed non-stream response even when its HTTP status is 200", async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json({ status: "failed", error: { message: "namespace missing" } }));
    await assert.rejects(responsesChat(route, [{ role: "user", content: "Continue" }], []), /namespace missing/);
  });

  it("keeps interleaved argument deltas attached to their actual Responses output indices", async (t) => {
    const second = { ...call, id: "fc_2", call_id: "call_2", name: "re_computer_screenshot", namespace: "desktop" };
    t.mock.method(globalThis, "fetch", async () => sse([
      { type: "response.output_item.added", output_index: 3, item: { ...call, arguments: "" } },
      { type: "response.output_item.added", output_index: 4, item: { ...second, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 3, delta: call.arguments },
      { type: "response.function_call_arguments.delta", output_index: 4, delta: '{"output":"image"}' },
      { type: "response.completed", response: { status: "completed" } },
    ]));
    const result = await responsesChatStream(route, [{ role: "user", content: "Inspect" }], [], undefined, {});
    assert.equal(result.toolCalls?.[0]?.function.arguments, call.arguments);
    assert.equal(result.toolCalls?.[0]?.namespace, "workspace_files");
    assert.equal(result.toolCalls?.[1]?.function.arguments, '{"output":"image"}');
    assert.equal(result.toolCalls?.[1]?.namespace, "desktop");
  });

  it("uses complete function arguments from the terminal response when deltas are absent", async (t) => {
    t.mock.method(globalThis, "fetch", async () => sse([
      { type: "response.output_item.added", output_index: 2, item: { ...call, arguments: "" } },
      { type: "response.completed", response: { status: "completed", output: [call] } },
    ]));
    const result = await responsesChatStream(route, [{ role: "user", content: "Inspect" }], [], undefined, {});
    assert.equal(result.toolCalls?.[0]?.function.arguments, call.arguments);
  });

  it("omits Responses namespaces when replaying calls as flat functions or Chat messages", () => {
    const messages: ModelChatMessage[] = [{ role: "assistant", content: null, toolCalls: [{ id: "old", type: "function", namespace: "workspace_files", function: { name: "re_fs_stat", arguments: "{}" } }] }];
    const chat = mapOpenAiCompatibleMessages(route, messages);
    assert.equal((chat[0]!.tool_calls as any[])[0]!.namespace, undefined);
    const responses = mapMessagesToResponsesInput(messages, [{ type: "function", name: "re_fs_stat" }]);
    assert.equal((responses.input[0] as any).namespace, undefined);
    assert.equal(messages[0]!.toolCalls![0]!.namespace, "workspace_files");
  });

  it("propagates a Responses failure after visible deltas so the loop can roll back", async (t) => {
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string) => {
      requests.push(url);
      return sse([
        { type: "response.output_text.delta", delta: "Partial answer" },
        { type: "response.failed", response: { status: "failed", error: { message: "interrupted" } } },
      ]);
    });
    const deltas: string[] = [];
    await assert.rejects(openAiAdapter.chatStream!(route, [{ role: "user", content: "Continue" }], { tools: definitions }, { onDelta: (text) => deltas.push(text) }), /interrupted/);
    assert.equal(requests.length, 1);
    assert.deepEqual(deltas, ["Partial answer"]);
  });
});
