import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelChatMessage } from "@zakura/shared";
import type { Agent } from "../src/db/schema.js";
import type { ResolvedRoute } from "../src/model-router/types.js";
import { mapOpenAiCompatibleMessages, openAiAdapter } from "../src/model-router/adapters/openai-compatible.js";
import { codexAdapter } from "../src/model-router/adapters/codex.js";
import { mapMessagesToResponsesInput, parseResponsesOutput, responsesChat, responsesChatStream } from "../src/model-router/openai-responses-api.js";
import { listAgentNativeTools } from "../src/services/agent-tools.js";
import { toolsToDefinitions } from "../src/services/cloud-agent/tools.js";

const { definitions } = toolsToDefinitions(listAgentNativeTools({ enableComputer: true, enableMemory: true } as Agent));
const route: ResolvedRoute = {
  routeId: "r1", routeSlug: "test", alias: "test", capability: "chat", model: "gpt-5.4", weight: 100, options: {},
  upstream: { id: "up", protocol: "openai", config: { baseUrl: "https://models.example.test/v1", apiKey: "test" } },
};
const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "re_fs_stat", namespace: "workspace_files", arguments: '{"path":"/a.txt"}' };
const answer = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] };

function sse(events: unknown[], done = true) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""), { headers: { "Content-Type": "text/event-stream" } });
}

describe("OpenAI tool continuation requests", () => {
  for (const adapter of [openAiAdapter, codexAdapter]) {
    for (const transport of ["json", "completed", "done"] as const) {
      const stream = transport !== "json";
      it(`${adapter.protocol} preserves tools and namespaces across tool results and a second user turn (${transport})`, async (t) => {
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
            ] : [{ type: "response.output_text.delta", delta: "Done" }]),
            ...(transport === "completed" ? [{ type: "response.completed", response }] : []),
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

  for (const failure of ["http", "stream", "empty", "buffered tool"] as const) {
    it(`falls back with flat Chat tools when Responses reports a ${failure} error`, async (t) => {
      const requests: Array<{ url: string; body: any }> = [];
      t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        requests.push({ url, body });
        if (url.endsWith("/responses")) {
          if (failure === "empty") return sse([{ type: "response.created", response: { status: "in_progress" } }]);
          return failure === "http"
            ? Response.json({ error: { message: "Responses unsupported" } }, { status: 404 })
            : sse([
              ...(failure === "buffered tool" ? [{ type: "response.output_item.added", output_index: 2, item: call }] : []),
              { type: "response.failed", response: { status: "failed", error: { code: "invalid_request_error", message: "function namespace missing" } } },
            ]);
        }
        return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "read", type: "function", function: { name: "re_fs_read", arguments: '{"path":"/a.txt"}' } }] }, finish_reason: "tool_calls" }] }]);
      });
      const messages: ModelChatMessage[] = [
        { role: "assistant", content: null, toolCalls: [{ id: "old", type: "function", namespace: "workspace_files", function: { name: "re_fs_stat", arguments: call.arguments } }] },
        { role: "tool", toolCallId: "old", content: "File exists" },
        { role: "user", content: "Read a.txt" },
      ];
      const result = await openAiAdapter.chatStream!(route, messages, { tools: definitions }, {});
      assert.equal(requests.length, 2);
      assert.ok(requests[1]!.url.endsWith("/chat/completions"));
      const fallback = requests[1]!.body;
      assert.ok(fallback.tools.every((tool: any) => tool.type === "function" && tool.function?.name));
      assert.ok(fallback.tools.some((tool: any) => tool.function.name === "re_fs_read"));
      assert.equal(fallback.messages[0].tool_calls[0].namespace, undefined);
      assert.equal(messages[0]!.toolCalls![0]!.namespace, "workspace_files");
      assert.equal(result.toolCalls?.length, 1);
      assert.equal(result.toolCalls?.[0]?.function.name, "re_fs_read");
    });
  }

  it("rejects explicit errors and Responses streams with no text or function calls", async (t) => {
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

describe("Responses gateway compatibility", () => {
  for (const ending of ["DONE", "EOF"] as const) {
    for (const output of ["tools", "text", "text and tools"] as const) {
      it(`accepts ${output} ending with ${ending} without response.completed`, async (t) => {
        const hasText = output !== "tools";
        const hasTools = output !== "text";
        const requests: string[] = [];
        t.mock.method(globalThis, "fetch", async (url: string) => {
          requests.push(url);
          return sse([
            ...(hasText ? [{ type: "response.output_text.delta", delta: "Inspecting" }] : []),
            ...(hasTools ? [
              { type: "response.output_item.added", output_index: 2, item: { ...call, arguments: "" } },
              { type: "response.function_call_arguments.delta", output_index: 2, delta: call.arguments },
            ] : []),
          ], ending === "DONE");
        });
        const deltas: string[] = [];
        const result = await openAiAdapter.chatStream!(route, [{ role: "user", content: "Inspect" }], { tools: definitions }, { onDelta: (text) => deltas.push(text) });
        assert.equal(requests.length, 1, "usable Responses output must not cause a second request");
        assert.equal(result.content, hasText ? "Inspecting" : null);
        assert.deepEqual(deltas, hasText ? ["Inspecting"] : []);
        assert.equal(result.finishReason, hasTools ? "tool_calls" : "stop");
        assert.equal(result.toolCalls?.length ?? 0, hasTools ? 1 : 0);
        if (hasTools) {
          assert.equal(result.toolCalls?.[0]?.namespace, call.namespace);
          assert.equal(result.toolCalls?.[0]?.function.arguments, call.arguments);
        }
      });
    }
  }

  it("accepts output_item.done and function_call_arguments.done without a completed event", async (t) => {
    t.mock.method(globalThis, "fetch", async () => sse([
      { type: "response.output_item.done", output_index: 2, item: call },
      { type: "response.output_item.added", output_index: 4, item: { ...call, id: "fc_2", call_id: "call_2", arguments: "" } },
      { type: "response.function_call_arguments.done", item_id: "fc_2", output_index: 4, arguments: '{"path":"/b.txt"}' },
    ]));
    const result = await responsesChatStream(route, [{ role: "user", content: "Inspect" }], [], undefined, {});
    assert.equal(result.finishReason, "tool_calls");
    assert.equal(result.toolCalls?.length, 2);
    assert.equal(result.toolCalls?.[0]?.function.arguments, call.arguments);
    assert.equal(result.toolCalls?.[1]?.function.arguments, '{"path":"/b.txt"}');
    assert.ok(result.toolCalls?.every((tool) => tool.namespace === call.namespace));
  });

  for (const status of ["in_progress", "incomplete"] as const) {
    it(`parses usable output with ${status} status, including in response.completed`, async (t) => {
      const response = { status, output: [call] };
      assert.equal(parseResponsesOutput(response).toolCalls?.[0]?.namespace, call.namespace);
      t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => JSON.parse(String(init.body)).stream
        ? sse([{ type: "response.completed", response }])
        : Response.json(response));
      const messages: ModelChatMessage[] = [{ role: "user", content: "Inspect" }];
      for (const result of [await responsesChat(route, messages, []), await responsesChatStream(route, messages, [], undefined, {})]) {
        assert.equal(result.finishReason, "tool_calls");
        assert.equal(result.toolCalls?.[0]?.function.arguments, call.arguments);
        assert.equal(result.toolCalls?.[0]?.namespace, call.namespace);
      }
    });
  }

  it("keeps text from an incomplete response with an output-token limit", async (t) => {
    t.mock.method(globalThis, "fetch", async () => sse([
      { type: "response.output_text.delta", delta: "Partial answer" },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
    ]));
    const result = await responsesChatStream(route, [{ role: "user", content: "Continue" }], [], undefined, {});
    assert.equal(result.content, "Partial answer");
    assert.equal(result.finishReason, "length");
  });

  it("merges terminal tool arguments without discarding other calls or their namespaces", async (t) => {
    const second = { ...call, id: "fc_2", call_id: "call_2", arguments: '{"path":"/b.txt"}' };
    const { namespace: _namespace, ...terminalCall } = call;
    t.mock.method(globalThis, "fetch", async () => sse([
      { type: "response.output_item.added", output_index: 2, item: { ...call, arguments: "" } },
      { type: "response.output_item.done", output_index: 3, item: second },
      { type: "response.completed", response: { output: [terminalCall] } },
    ]));
    const result = await responsesChatStream(route, [{ role: "user", content: "Inspect" }], [], undefined, {});
    assert.equal(result.toolCalls?.length, 2);
    assert.equal(result.toolCalls?.[0]?.function.arguments, call.arguments);
    assert.equal(result.toolCalls?.[1]?.function.arguments, second.arguments);
    assert.ok(result.toolCalls?.every((tool) => tool.namespace === call.namespace));
  });

  for (const finishReason of [null, "tool_calls"] as const) {
    it(`decodes misrouted Chat SSE text, reasoning, parallel tools and usage (finish=${finishReason})`, async (t) => {
      const requests: string[] = [];
      t.mock.method(globalThis, "fetch", async (url: string) => {
        requests.push(url);
        return sse([
          { model: "gateway-model", choices: [{ delta: { reasoning_content: "Thinking", content: "Inspecting", tool_calls: [
            { index: 0, id: "first", function: { name: "re_fs_stat", arguments: '{"path":' } },
            { index: 1, id: "second", function: { name: "re_fs_read", arguments: '{"path":' } },
          ] } }] },
          { choices: [{ delta: { tool_calls: [
            { index: 1, function: { arguments: '"/b.txt"}' } },
            { index: 0, function: { arguments: '"/a.txt"}' } },
          ] }, finish_reason: finishReason }] },
          { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
        ]);
      });
      const deltas: string[] = [];
      const reasoning: string[] = [];
      const result = await openAiAdapter.chatStream!(route, [{ role: "user", content: "Inspect" }], { tools: definitions }, { onDelta: (text) => deltas.push(text), onReasoningDelta: (text) => reasoning.push(text) });
      assert.equal(requests.length, 1, "Chat-shaped SSE is compatible without a retry");
      assert.deepEqual(deltas, ["Inspecting"]);
      assert.deepEqual(reasoning, ["Thinking"]);
      assert.equal(result.content, "Inspecting");
      assert.equal(result.model, "gateway-model");
      assert.equal(result.finishReason, "tool_calls");
      assert.deepEqual(result.toolCalls?.map((tool) => [tool.id, tool.function.name, tool.function.arguments]), [
        ["first", "re_fs_stat", call.arguments],
        ["second", "re_fs_read", '{"path":"/b.txt"}'],
      ]);
      assert.equal(result.usage?.totalTokens, 18);
    });
  }

  for (const stream of [false, true]) {
    it(`falls back from an empty Responses result (stream=${stream})`, async (t) => {
      const requests: Array<{ url: string; body: any }> = [];
      t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        if (url.endsWith("/responses")) return stream ? sse([]) : Response.json({ status: "completed", output: [] });
        const message = { content: null, tool_calls: [{ index: 0, id: "read", type: "function", function: { name: "re_fs_read", arguments: call.arguments } }] };
        return stream ? sse([{ choices: [{ delta: message, finish_reason: "tool_calls" }] }]) : Response.json({ choices: [{ message, finish_reason: "tool_calls" }] });
      });
      const messages: ModelChatMessage[] = [{ role: "user", content: "Read a.txt" }];
      const result = stream ? await openAiAdapter.chatStream!(route, messages, { tools: definitions }, {}) : await openAiAdapter.chat!(route, messages, { tools: definitions });
      assert.equal(requests.length, 2);
      assert.ok(requests[1]!.url.endsWith("/chat/completions"));
      assert.ok(requests[1]!.body.tools.every((tool: any) => tool.type === "function" && tool.function?.name));
      assert.equal(result.toolCalls?.[0]?.function.name, "re_fs_read");
    });
  }

  it("keeps separate Chat calls to the same function when a gateway omits call IDs", async (t) => {
    t.mock.method(globalThis, "fetch", async () => sse([
      { choices: [{ delta: { tool_calls: [
        { index: 0, function: { name: "re_fs_stat", arguments: call.arguments } },
        { index: 1, function: { name: "re_fs_stat", arguments: '{"path":"/b.txt"}' } },
      ] }, finish_reason: "tool_calls" }] },
    ]));
    const result = await responsesChatStream(route, [{ role: "user", content: "Inspect" }], [], undefined, {});
    assert.deepEqual(result.toolCalls?.map((tool) => tool.function.arguments), [call.arguments, '{"path":"/b.txt"}']);
    assert.equal(new Set(result.toolCalls?.map((tool) => tool.id)).size, 2);
  });

  it("can fall back after unobserved text when no delta callback was invoked", async (t) => {
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string) => {
      requests.push(url);
      return url.endsWith("/responses") ? sse([
        { type: "response.output_text.delta", delta: "Unobserved" },
        { type: "response.failed", response: { error: { message: "interrupted" } } },
      ]) : sse([{ choices: [{ delta: { content: "Recovered" }, finish_reason: "stop" }] }]);
    });
    const result = await openAiAdapter.chatStream!(route, [{ role: "user", content: "Continue" }], { tools: definitions }, {});
    assert.equal(requests.length, 2);
    assert.equal(result.content, "Recovered");
  });

  it("does not start Chat fallback after the caller cancels Responses", async (t) => {
    const controller = new AbortController();
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push(url);
      controller.abort();
      throw init.signal!.reason;
    });
    await assert.rejects(openAiAdapter.chatStream!(route, [{ role: "user", content: "Continue" }], { tools: definitions }, { signal: controller.signal }), /取消/);
    assert.equal(requests.length, 1);
  });
});
