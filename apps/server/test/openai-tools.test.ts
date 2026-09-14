import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelToolDefinition } from "@zakura/shared";
import {
  OPENAI_TOOLS_ARRAY_MAX,
  TOOL_SEARCH_MIN_DEFERRED_TOOLS,
  TOOL_SEARCH_NAMESPACE_MAX_TOOLS,
  TOOL_SEARCH_OVERFLOW_NAMESPACE,
  describeNamespaceTools,
  fitNamespacesToRoom,
  packOpenAiChatTools,
  sanitizeOpenAiToolSchema,
  semanticBucketForToolName,
  shardNamespaceGroups,
  shortToolLabel,
  shouldUseToolSearchPack,
  supportsToolSearch,
} from "../src/model-router/openai-tools.js";
import {
  mapMessagesToResponsesInput,
  parseResponsesOutput,
} from "../src/model-router/openai-responses-api.js";
import {
  isAlwaysOnResolvedTool,
  isZakuraBuiltinTool,
  namespaceSlugFromTool,
  nativeDeferredNamespace,
  toolsToDefinitions,
  mcpResultToModelOutput,
  mcpResultToText,
  pruneToolImages,
} from "../src/services/cloud-agent/tools.js";
import { mapOpenAiCompatibleMessages } from "../src/model-router/adapters/openai-compatible.js";
import type { ModelChatMessage } from "@zakura/shared";
import { makePng } from "./helpers/png.js";
import type { ResolvedTool } from "../src/services/mcp-gateway.js";
import { prepareHistoryForModel } from "../src/services/cloud-agent/messages.js";
import { listAgentNativeTools } from "../src/services/agent-tools.js";
import type { Agent } from "../src/db/schema.js";

function tool(
  name: string,
  opts?: { defer?: boolean; ns?: string },
): ModelToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: `desc ${name}`,
      parameters: { type: "object", properties: {} },
    },
    ...(opts?.defer
      ? {
          deferLoading: true,
          namespace: {
            name: opts.ns ?? "mcp_a",
            description: `MCP server "${opts.ns ?? "mcp_a"}" (http)`,
          },
        }
      : {}),
  };
}

function resolved(
  partial: Partial<ResolvedTool> &
    Pick<ResolvedTool, "qualifiedName" | "providerId"> & { localName?: string },
): ResolvedTool {
  return {
    instanceId: null,
    localName: partial.localName ?? partial.qualifiedName.replace(/^re_/, ""),
    description: "",
    inputSchema: { type: "object", properties: {} },
    ...partial,
  };
}

describe("supportsToolSearch / shouldUseToolSearchPack", () => {
  it("matches gpt-5.4+ including luna suffix", () => {
    assert.equal(supportsToolSearch("gpt-5.6-luna"), true);
    assert.equal(supportsToolSearch("gpt-4o"), false);
  });

  it("skips tool_search pack for small tool surfaces", () => {
    assert.equal(shouldUseToolSearchPack("gpt-5.6-luna", 20, 5), false);
    assert.equal(
      shouldUseToolSearchPack("gpt-5.6-luna", 10, TOOL_SEARCH_MIN_DEFERRED_TOOLS),
      true,
    );
  });
});

describe("semantic sharding", () => {
  it("classifies read vs write", () => {
    assert.equal(semanticBucketForToolName("list_messages"), "read");
    assert.equal(semanticBucketForToolName("send_email"), "write");
    assert.equal(semanticBucketForToolName("re_gmail__get_profile"), "read");
    assert.equal(semanticBucketForToolName("computer_click"), "other");
  });

  it("splits large namespaces by semantics not raw index", () => {
    const tools = [
      ...Array.from({ length: 6 }, (_, i) =>
        tool(`list_${i}`, { defer: true, ns: "gmail" }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        tool(`send_${i}`, { defer: true, ns: "gmail" }),
      ),
      tool("noop_x", { defer: true, ns: "gmail" }),
    ];
    const shards = shardNamespaceGroups(
      [{ name: "gmail", description: 'MCP server "gmail"', tools }],
      TOOL_SEARCH_NAMESPACE_MAX_TOOLS,
    );
    const names = shards.map((s) => s.name).sort();
    assert.ok(names.includes("gmail_read"));
    assert.ok(names.includes("gmail_write"));
    assert.ok(names.includes("gmail_other"));
    assert.ok(!names.includes("gmail_2"));
  });
});

describe("fitNamespacesToRoom", () => {
  it("merges overflow into external_misc", () => {
    const groups = Array.from({ length: 5 }, (_, i) => ({
      name: `ns_${i}`,
      description: `NS ${i}`,
      tools: [tool(`t_${i}`, { defer: true, ns: `ns_${i}` })],
    }));
    const { kept, omitted, mergedIntoMisc } = fitNamespacesToRoom(groups, 3);
    assert.equal(mergedIntoMisc, true);
    assert.equal(kept.length, 3); // 2 direct + misc
    assert.equal(kept.at(-1)?.name, TOOL_SEARCH_OVERFLOW_NAMESPACE);
    assert.deepEqual(omitted, ["ns_2", "ns_3", "ns_4"]);
    assert.equal(kept.at(-1)?.tools.length, 3);
  });

  it("shards oversized misc into external_misc_N", () => {
    const groups = Array.from({ length: 4 }, (_, i) => ({
      name: `ns_${i}`,
      description: `NS ${i}`,
      tools: Array.from({ length: 8 }, (_, j) =>
        tool(`list_${i}_${j}`, { defer: true, ns: `ns_${i}` }),
      ),
    }));
    // room=3 → 至少 1 个 misc 槽；overflow 24 tools → 需 3 个 misc 分片，会挤掉更多 direct
    const { kept, mergedIntoMisc } = fitNamespacesToRoom(groups, 3);
    assert.equal(mergedIntoMisc, true);
    assert.ok(kept.length <= 3);
    assert.ok(
      kept.every((g) => g.tools.length <= TOOL_SEARCH_NAMESPACE_MAX_TOOLS),
    );
    assert.ok(kept.some((g) => g.name.startsWith(TOOL_SEARCH_OVERFLOW_NAMESPACE)));
  });
});

describe("packOpenAiChatTools", () => {
  it("removes unsupported regex lookaround from nested tool schemas", () => {
    const schema = {
      type: "object",
      properties: {
        contact: {
          type: "object",
          properties: {
            email: {
              type: "string",
              pattern: "^(?!.*\\.\\.)[^@]+@[^@]+$",
              format: "email",
            },
            code: { type: "string", pattern: "^[A-Z]{2}$" },
          },
        },
      },
    };

    const sanitized = sanitizeOpenAiToolSchema(schema) as typeof schema;
    assert.equal(sanitized.properties.contact.properties.email.pattern, undefined);
    assert.equal(sanitized.properties.contact.properties.email.format, "email");
    assert.equal(sanitized.properties.contact.properties.code.pattern, "^[A-Z]{2}$");
    assert.equal(schema.properties.contact.properties.email.pattern, "^(?!.*\\.\\.)[^@]+@[^@]+$");
  });

  it("sanitizes schemas in both chat and responses tool formats", () => {
    const withLookbehind = tool("send_contact");
    withLookbehind.function.parameters = {
      type: "object",
      properties: { value: { type: "string", pattern: "(?<=prefix)value" } },
    };

    for (const format of ["chat", "responses"] as const) {
      const packed = packOpenAiChatTools([withLookbehind], "gpt-5.6-sol", { format });
      const first = packed!.tools[0] as Record<string, any>;
      const parameters = format === "chat" ? first.function.parameters : first.parameters;
      assert.equal(parameters.properties.value.pattern, undefined);
    }
  });

  it("returns pack result object with usedToolSearch", () => {
    const deferred = Array.from({ length: TOOL_SEARCH_MIN_DEFERRED_TOOLS }, (_, i) =>
      tool(`list_${i}`, { defer: true, ns: "gmail" }),
    );
    const packed = packOpenAiChatTools([tool("re_fs_read"), ...deferred], "gpt-5.6-luna", { format: "responses" });
    assert.ok(packed);
    assert.equal(packed!.usedToolSearch, true);
    assert.deepEqual(packed!.tools.at(-1), { type: "tool_search" });
    assert.equal((packed!.tools[0] as { name: string }).name, "re_fs_read");
  });

  it("responses format uses flat always-on functions", () => {
    const deferred = Array.from({ length: TOOL_SEARCH_MIN_DEFERRED_TOOLS }, (_, i) =>
      tool(`list_${i}`, { defer: true, ns: "gmail" }),
    );
    const packed = packOpenAiChatTools([tool("re_fs_read"), ...deferred], "gpt-5.6", {
      format: "responses",
    });
    const first = packed!.tools[0] as { type: string; name?: string; function?: unknown };
    assert.equal(first.type, "function");
    assert.equal(first.name, "re_fs_read");
    assert.equal(first.function, undefined);
  });

  it("prefers namespaces used in message history when fitting", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      tool(`list_${i}`, { defer: true, ns: `ns${i}` }),
    );
    // force many namespaces: each tool its own ns already
    const packed = packOpenAiChatTools([tool("re_fs_read"), ...many], "gpt-5.6-luna", {
      format: "responses",
      messages: [
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "list_39", arguments: "{}" },
            },
          ],
        },
      ],
    });
    assert.ok(packed!.usedToolSearch);
    const nsNames = packed!.tools
      .filter((t) => (t as { type?: string }).type === "namespace")
      .map((t) => (t as { name: string }).name);
    assert.ok(nsNames.includes("ns39") || nsNames.includes(TOOL_SEARCH_OVERFLOW_NAMESPACE));
  });

  it("caps flat tools at 128 preferring always-on", () => {
    const always = Array.from({ length: 10 }, (_, i) => tool(`re_${i}`));
    const deferred = Array.from({ length: 150 }, (_, i) =>
      tool(`ext_${i}`, { defer: true }),
    );
    const packed = packOpenAiChatTools([...always, ...deferred], "gpt-4o");
    assert.equal(packed!.tools.length, OPENAI_TOOLS_ARRAY_MAX);
  });

  it("keeps Chat Completions tools flat even for models that support Responses tool search", () => {
    const deferred = Array.from({ length: 20 }, (_, i) => tool(`ext_${i}`, { defer: true }));
    const packed = packOpenAiChatTools([tool("re_fs_read"), ...deferred], "gpt-5.4", { format: "chat" })!;
    assert.equal(packed.usedToolSearch, false);
    assert.equal(packed.tools.length, 21);
    assert.ok(packed.tools.every((t: any) => t.type === "function" && t.function?.name));
  });

  it("does not evict an always-on function to make room for tool_search", () => {
    const always = Array.from({ length: OPENAI_TOOLS_ARRAY_MAX }, (_, i) => tool(`native_${i}`));
    const packed = packOpenAiChatTools([...always, tool("extra", { defer: true })], "gpt-5.4", { format: "responses" })!;
    assert.equal(packed.usedToolSearch, false);
    assert.deepEqual(packed.tools.map((t: any) => t.name), always.map((t) => t.function.name));
  });

  it("keeps native tools eager on every turn and reloads previously called namespaces after compaction", () => {
    const agent = { enableComputer: true, enableMemory: true } as Agent;
    const { definitions } = toolsToDefinitions(listAgentNativeTools(agent));
    const before = JSON.stringify(definitions);
    const history: ModelChatMessage[] = [
      { role: "user", content: "Inspect the files" },
      { role: "assistant", content: null, toolCalls: [{ id: "stat", type: "function", function: { name: "re_fs_stat", arguments: '{"path":"/a.txt"}' } }] },
      { role: "tool", name: "re_fs_stat", toolCallId: "stat", content: "x".repeat(20_000) },
      { role: "assistant", content: "Found the file" },
      { role: "user", content: "Now move it" },
    ];
    prepareHistoryForModel(history, { maxToolResultChars: 2_000 });
    for (const messages of [[history[0]!], history, [{ role: "system" as const, content: "Compacted history" }, history.at(-1)!]]) {
      const packed = packOpenAiChatTools(definitions, "gpt-5.4", { format: "responses", messages })!;
      assert.equal(packed.usedToolSearch, true);
      for (const name of ["re_fs_read", "re_fs_write", "re_shell_exec", "re_browser_observe", "re_browser_action", "re_memory_context", "re_search_memory", "re_add_memory"]) {
        const found = packed.tools.find((t: any) => t.type === "function" && t.name === name) as any;
        assert.ok(found, `missing always-on tool ${name}`);
        assert.notEqual(found.defer_loading, true);
      }
      const files = packed.tools.find((t: any) => t.type === "namespace" && t.name === "workspace_files") as any;
      assert.ok(files);
      assert.ok(files.tools.every((t: any) => Boolean(t.defer_loading) === (messages !== history)));
    }
    assert.equal(JSON.stringify(definitions), before, "packing must not mutate cached definitions");
  });

  it("prioritizes previously called deferred tools in a capped Chat fallback", () => {
    const deferred = Array.from({ length: 150 }, (_, i) => tool(`ext_${i}`, { defer: true }));
    const packed = packOpenAiChatTools([tool("re_fs_read"), ...deferred], "gpt-5.4", {
      format: "chat",
      messages: [{ role: "assistant", content: null, toolCalls: [{ id: "last", type: "function", function: { name: "ext_149", arguments: "{}" } }] }],
    })!;
    assert.ok(packed.tools.some((t: any) => t.function?.name === "re_fs_read"));
    assert.ok(packed.tools.some((t: any) => t.function?.name === "ext_149"));
  });
});

describe("native tiering smoke", () => {
  it("defers desktop tools", () => {
    assert.equal(nativeDeferredNamespace("computer_click")?.name, "desktop");
    assert.equal(
      isAlwaysOnResolvedTool(
        resolved({
          qualifiedName: "re_fs_read",
          localName: "fs_read",
          providerId: "zakura-agent",
        }),
      ),
      true,
    );
    assert.equal(
      isZakuraBuiltinTool(
        resolved({
          qualifiedName: "re_gmail__send",
          providerId: "zakura-connector",
          agentScoped: true,
        }),
      ),
      false,
    );
    assert.equal(
      namespaceSlugFromTool(
        resolved({ qualifiedName: "re_gmail__send", providerId: "zakura-connector" }),
      ),
      "gmail",
    );
    const { definitions, nameMap } = toolsToDefinitions([
      resolved({
        qualifiedName: "re_computer_click",
        localName: "computer_click",
        providerId: "zakura-agent",
      }),
      resolved({
        qualifiedName: "re_fs_stat",
        localName: "fs_stat",
        providerId: "zakura-agent",
      }),
    ]);
    assert.equal(definitions[0]?.function.name, "re_computer_click");
    assert.equal(definitions[0]?.namespace?.name, "desktop");
    assert.equal(definitions[1]?.function.name, "re_fs_stat");
    assert.equal(nameMap.get("re_fs_stat"), "re_fs_stat");
    assert.ok(!nameMap.has("fs_stat"), "short localName must not be exposed");
  });
});

describe("describeNamespaceTools", () => {
  it("stays high-level", () => {
    assert.equal(shortToolLabel("re_gmail__send"), "send");
    assert.equal(describeNamespaceTools("CRM tools"), "CRM tools.");
  });
});

describe("responses mapping", () => {
  it("lifts system into instructions", () => {
    const mapped = mapMessagesToResponsesInput([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hi" },
    ]);
    assert.equal(mapped.instructions, "You are helpful.");
    assert.deepEqual(mapped.input[0], { role: "user", content: "hi" });
  });

  it("parses function_call output items", () => {
    const parsed = parseResponsesOutput({
      output: [
        { type: "tool_search_call", status: "completed" },
        {
          type: "function_call",
          call_id: "call_1",
          name: "list_open_orders",
          arguments: '{"id":"1"}',
        },
      ],
    });
    assert.equal(parsed.toolCalls?.[0]?.function.name, "list_open_orders");
    assert.equal(parsed.finishReason, "tool_calls");
  });

  it("preserves function namespaces and restores legacy calls from the current tool pack", () => {
    const parsed = parseResponsesOutput({ output: [{ type: "function_call", call_id: "c1", name: "re_fs_stat", namespace: "workspace_files", arguments: "{}" }] });
    assert.equal(parsed.toolCalls?.[0]?.namespace, "workspace_files");
    const mapped = mapMessagesToResponsesInput([{ role: "assistant", content: null, toolCalls: parsed.toolCalls }]);
    assert.equal((mapped.input[0] as any).namespace, "workspace_files");
    const legacy = mapMessagesToResponsesInput([
      { role: "assistant", content: null, toolCalls: [{ id: "old", type: "function", function: { name: "re_fs_stat", arguments: "{}" } }] },
    ], [{ type: "namespace", name: "workspace_files", tools: [{ type: "function", name: "re_fs_stat" }] }]);
    assert.equal((legacy.input[0] as any).namespace, "workspace_files");
  });
});

describe("computer image results", () => {
  const png = makePng(300, 180);
  const result = { content: [{ type: "text", text: '{"width":300,"height":180}' }, { type: "image", data: png, mimeType: "image/png" }] };

  it("keeps complete image parts outside the 12000-character text limit", () => {
    const output = mcpResultToModelOutput(result);
    assert.ok(png.length > 120_000);
    assert.equal(output.parts?.find((part) => part.type === "image_url")?.imageUrl.url, `data:image/png;base64,${png}`);
    assert.equal(output.parts?.find((part) => part.type === "image_url")?.imageUrl.detail, "original");
    assert.ok(output.text.length < 1000);
    const imageOnly = mcpResultToText({ content: result.content.slice(1) });
    assert.ok(imageOnly.text.length < 1000);
    assert.ok(!imageOnly.text.includes(png.slice(0, 200)));
  });

  it("turns legacy/full base64 JSON into vision input without logging all image bytes", () => {
    const output = mcpResultToModelOutput({ content: [{ type: "text", text: JSON.stringify({ format: "png", base64Full: png, width: 300, height: 180 }) }] });
    assert.ok(output.parts?.some((part) => part.type === "image_url"));
    assert.equal(JSON.parse(output.text).base64Full, undefined);
    assert.equal(JSON.parse(output.text).width, 300);
    assert.ok(output.text.length < 1000);
  });

  it("bounds images, rejects damaged PNGs and preserves tool errors", () => {
    const output = mcpResultToModelOutput({ isError: true, content: [null, { type: "image", data: png.slice(0, -16), mimeType: "image/png" }] });
    assert.equal(output.isError, true);
    assert.equal(output.parts, undefined);
    assert.match(output.text, /incomplete PNG/);
    const bounded = mcpResultToModelOutput({ content: Array.from({ length: 4 }, () => result.content[1]) });
    assert.equal(bounded.parts?.filter((part) => part.type === "image_url").length, 2);
    assert.match(bounded.text, /limit/);
  });

  it("keeps only the two latest tool images without changing call ids or metadata", () => {
    const messages: ModelChatMessage[] = [1, 2, 3].map((i) => ({ role: "tool", toolCallId: `c${i}`, content: `frame ${i}`, parts: mcpResultToModelOutput(result).parts }));
    pruneToolImages(messages);
    assert.equal(messages[0]!.parts, undefined);
    assert.equal(messages[0]!.content, "frame 1");
    assert.equal(messages.filter((message) => message.parts).length, 2);
    assert.deepEqual(messages.map((message) => message.toolCallId), ["c1", "c2", "c3"]);
  });

  it("sends Responses images in the matching tool output and preserves complete tool batches in Chat fallback", () => {
    const output = mcpResultToModelOutput(result);
    const messages: ModelChatMessage[] = [
      { role: "assistant", content: null, toolCalls: [1, 2].map((i) => ({ id: `c${i}`, type: "function", function: { name: "re_computer_screenshot", arguments: "{}" } })) },
      { role: "tool", toolCallId: "c1", name: "re_computer_screenshot", content: output.text, parts: output.parts },
      { role: "tool", toolCallId: "c2", name: "re_desktop_info", content: "ready" },
    ];
    const responses = mapMessagesToResponsesInput(messages).input as Array<Record<string, any>>;
    const imageResult = responses.find((item) => item.type === "function_call_output" && item.call_id === "c1")!;
    assert.deepEqual(imageResult.output.find((part: { type: string }) => part.type === "input_image"), { type: "input_image", image_url: `data:image/png;base64,${png}`, detail: "original" });
    const chat = mapOpenAiCompatibleMessages({ meta: { modalities: { input: ["text", "image"] } } } as never, messages);
    assert.deepEqual(chat.map((message) => message.role), ["assistant", "tool", "tool", "user"]);
    const parts = chat.at(-1)!.content as Array<Record<string, any>>;
    assert.equal(parts.find((part) => part.type === "image_url")?.image_url.url, `data:image/png;base64,${png}`);
    assert.equal(parts.find((part) => part.type === "image_url")?.image_url.detail, "high");
    assert.equal(chat[1]!.tool_call_id, "c1");
    assert.equal(chat[2]!.tool_call_id, "c2");
  });
});
