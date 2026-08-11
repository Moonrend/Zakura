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
} from "../src/services/cloud-agent/tools.js";
import type { ResolvedTool } from "../src/services/mcp-gateway.js";

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
  it("returns pack result object with usedToolSearch", () => {
    const deferred = Array.from({ length: TOOL_SEARCH_MIN_DEFERRED_TOOLS }, (_, i) =>
      tool(`list_${i}`, { defer: true, ns: "gmail" }),
    );
    const packed = packOpenAiChatTools([tool("re_fs_read"), ...deferred], "gpt-5.6-luna");
    assert.ok(packed);
    assert.equal(packed!.usedToolSearch, true);
    assert.deepEqual(packed!.tools.at(-1), { type: "tool_search" });
    assert.ok("function" in (packed!.tools[0] as object));
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
});
