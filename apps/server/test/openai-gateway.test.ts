import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { parseCloudAgentSessionOrigin } from "@zakura/shared";
import type { Agent } from "../src/db/schema.js";
import type { AgentService } from "../src/services/agents.js";
import type { CloudAgentSessionStore } from "../src/services/cloud-agent-session.js";
import type { McpGateway } from "../src/services/mcp-gateway.js";
import type { ModelRouterService } from "../src/services/model-router.js";
import {
  OpenAiGatewayService,
  extractClaudeCodeSessionId,
  mergeTools,
  resolveClientSessionKey,
  resolveGatewayModel,
  scoreGatewayMessageMatch,
} from "../src/services/openai-gateway.js";
import { hasApiKeyScope } from "../src/services/auth.js";
import { registerOpenAiGatewayRoutes } from "../src/api/openai-gateway-routes.js";

const serverTool = (name: string) => ({
  type: "function" as const,
  function: {
    name,
    description: `server ${name}`,
    parameters: { type: "object", properties: {} },
  },
});

const clientTool = (name: string) => ({
  type: "function" as const,
  function: {
    name,
    description: `client ${name}`,
    parameters: { type: "object", properties: {} },
  },
});

describe("OpenAI gateway tool policy", () => {
  it("skips server tool injection when Zakura MCP tools are already present", () => {
    const result = mergeTools([serverTool("re_fs_read")], [
      clientTool("re_fs_read"),
      clientTool("local_search"),
    ]);
    assert.equal(result.usedZakuraMcp, true);
    assert.deepEqual(
      result.tools.map((tool) => tool.function.name),
      ["re_fs_read", "local_search"],
    );
  });

  it("injects server tools when the request has no Zakura MCP tool", () => {
    const result = mergeTools([serverTool("re_fs_read")], [clientTool("local_search")]);
    assert.equal(result.usedZakuraMcp, false);
    assert.deepEqual(
      result.tools.map((tool) => tool.function.name),
      ["re_fs_read", "local_search"],
    );
  });

  it("keeps the client definition on a name collision", () => {
    const result = mergeTools([serverTool("local_search")], [clientTool("local_search")]);
    assert.equal(result.tools[0]?.function.description, "client local_search");
  });
});

describe("OpenAI gateway session origin", () => {
  it("preserves the gateway channel for the fork-only UI policy", () => {
    assert.equal(
      parseCloudAgentSessionOrigin({
        source: "api",
        channel: "openai-gateway",
      }).channel,
      "openai-gateway",
    );
  });
});

describe("OpenAI gateway model selection", () => {
  it("uses the client model before the Agent fallback", () => {
    assert.equal(resolveGatewayModel("client-model", "agent-model"), "client-model");
    assert.equal(resolveGatewayModel("", "agent-model"), "agent-model");
  });
});

describe("OpenAI gateway key scopes", () => {
  it("treats gateway as a single capability (no models/chat split)", () => {
    // hasApiKeyScope is the primitive; gateway auth accepts any gateway-* or *
    assert.equal(hasApiKeyScope({ scopes: '["gateway:chat"]' }, "gateway:chat"), true);
    assert.equal(hasApiKeyScope({ scopes: '["gateway:models"]' }, "gateway:models"), true);
    assert.equal(hasApiKeyScope({ scopes: '["gateway"]' }, "gateway"), true);
    assert.equal(hasApiKeyScope({ scopes: '["*"]' }, "gateway:chat"), true);
    assert.equal(hasApiKeyScope({ scopes: "invalid" }, "gateway:chat"), false);
  });
});

describe("OpenAI gateway session continuation", () => {
  it("reads Claude Code and Codex session headers without Zakura-specific fields", () => {
    assert.equal(
      resolveClientSessionKey(
        new Headers({ "x-claude-code-session-id": "claude-sess" }),
        {},
      ),
      "claude-sess",
    );
    assert.equal(
      resolveClientSessionKey(new Headers({ "session-id": "codex-sess" }), {}),
      "codex-sess",
    );
    assert.equal(
      extractClaudeCodeSessionId(
        "user_abc_account_456_session_f47ac10b-58cc-4372-a567-0e02b2c3d479",
      ),
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    );
    assert.equal(
      extractClaudeCodeSessionId(
        JSON.stringify({ session_id: "json-session", device_id: "x" }),
      ),
      "json-session",
    );
    assert.equal(
      resolveClientSessionKey(new Headers(), {
        metadata: {
          user_id: "user_abc_account_456_session_from-body",
        },
      }),
      "from-body",
    );
  });

  it("reuses sessions by client session key from Codex-style headers", async () => {
    const agent = {
      id: "agent-1",
      tenantId: "tenant-1",
      name: "Test Agent",
      slug: "test-agent",
      configJson: JSON.stringify({ cloud: { enableTools: false } }),
      enableMemory: false,
    } as unknown as Agent;
    let created = 0;
    const service = new OpenAiGatewayService({
      agentService: { get: async () => agent } as unknown as AgentService,
      gateway: { listToolsForAgent: async () => [] } as unknown as McpGateway,
      modelRouter: { resolveRoute: async () => null } as unknown as ModelRouterService,
      store: {
        getSession: async () => null,
        listGatewaySessions: async () => [
          {
            id: "zakura-session-1",
            updatedAt: new Date().toISOString(),
            originJson: JSON.stringify({
              source: "api",
              channel: "openai-gateway",
              clientSessionKey: "codex-sess",
            }),
          },
        ],
        listEvents: async () => [],
        createSession: async () => {
          created += 1;
          return { id: "new" };
        },
        appendEvent: async () => ({}),
        warmSession: async () => {},
        updateSession: async () => null,
      } as unknown as CloudAgentSessionStore,
    });

    const context = await service.prepare(
      "tenant-1",
      "agent-1",
      { messages: [{ role: "user", content: "hello" }] },
      { clientSessionKey: "codex-sess" },
    );
    assert.equal(context.sessionId, "zakura-session-1");
    assert.equal(created, 0);
  });

  it("merges by user-message fingerprint even when assistant text diverges", () => {
    // 续聊：客户端更长
    assert.ok(scoreGatewayMessageMatch(["问1", "问2"], ["问1", "问2", "问3"]) > 0);
    // 重试 / 只发最新一句：客户端更短或等长
    assert.ok(scoreGatewayMessageMatch(["问1"], ["问1"]) > 0);
    assert.ok(scoreGatewayMessageMatch(["问1", "问2"], ["问1"]) > 0);
    assert.equal(scoreGatewayMessageMatch(["问1"], ["别的"]), 0);
  });

  it("reuses the gateway session when client retries with the same user turn", async () => {
    const agent = {
      id: "agent-1",
      tenantId: "tenant-1",
      name: "Test Agent",
      slug: "test-agent",
      configJson: JSON.stringify({ cloud: { enableTools: false } }),
      enableMemory: false,
    } as unknown as Agent;
    let created = 0;
    const events: Array<{ type: string; runId: string | null; payload: Record<string, unknown> }> =
      [
        {
          type: "user_message",
          runId: "r1",
          payload: { messageId: "m1", content: "尝试在本地初始化一个vue项目，启动vue-ui" },
        },
        { type: "run_start", runId: "r1", payload: { runId: "r1", replyToMessageId: "m1" } },
        {
          type: "assistant_message",
          runId: "r1",
          payload: { messageId: "a1", content: "" },
        },
        { type: "run_end", runId: "r1", payload: { runId: "r1", status: "completed" } },
      ];
    const service = new OpenAiGatewayService({
      agentService: { get: async () => agent } as unknown as AgentService,
      gateway: { listToolsForAgent: async () => [] } as unknown as McpGateway,
      modelRouter: { resolveRoute: async () => null } as unknown as ModelRouterService,
      store: {
        listGatewaySessions: async () => [
          {
            id: "session-existing",
            updatedAt: new Date().toISOString(),
            originJson: JSON.stringify({ source: "api", channel: "openai-gateway" }),
          },
        ],
        listEvents: async () => events,
        createSession: async () => {
          created += 1;
          return { id: "session-new" };
        },
        getSession: async () => null,
        appendEvent: async () => ({}),
        warmSession: async () => {},
        updateSession: async () => null,
      } as unknown as CloudAgentSessionStore,
    });

    // 客户端重试时往往只带最新 user，且不带回显的空 assistant
    const context = await service.prepare("tenant-1", "agent-1", {
      messages: [{ role: "user", content: "尝试在本地初始化一个vue项目，启动vue-ui" }],
    });
    assert.equal(context.sessionId, "session-existing");
    assert.equal(created, 0);
  });
});

describe("OpenAI gateway proxy behavior", () => {
  it("uses the client model and merges server tools into the request", async () => {
    let calledTool = false;
    let seenTools: string[] = [];
    const agent = {
      id: "agent-1",
      tenantId: "tenant-1",
      name: "Test Agent",
      slug: "test-agent",
      configJson: JSON.stringify({ cloud: { systemPrompt: "custom" } }),
      enableMemory: false,
    } as unknown as Agent;
    const fakeAgentService = {
      get: async () => agent,
    } as unknown as AgentService;
    const fakeGateway = {
      listToolsForAgent: async () => [
        {
          qualifiedName: "re_server_tool",
          description: "server tool",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      callTool: async () => {
        calledTool = true;
        return { content: [{ type: "text", text: "tool-ok" }] };
      },
    } as unknown as McpGateway;
    const fakeStore = {
      createSession: async () => ({ id: "session-1" }),
      getSession: async () => null,
      listEvents: async () => [],
      listGatewaySessions: async () => [],
      appendEvent: async () => ({}),
      warmSession: async () => {},
      updateSession: async () => null,
    } as unknown as CloudAgentSessionStore;
    const fakeRouter = {
      resolveRoute: async () => null,
      chat: async (
        _tenantId: string,
        _messages: unknown,
        _route: unknown,
        options: { tools?: Array<{ function: { name: string } }> },
      ) => {
        seenTools = options.tools?.map((tool) => tool.function.name) ?? [];
        return {
          content: "ok",
          model: "client-model",
          openai: {
            id: "chatcmpl_test",
            object: "chat.completion",
            created: 0,
            model: "client-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
          },
        };
      },
    } as unknown as ModelRouterService;
    const service = new OpenAiGatewayService({
      agentService: fakeAgentService,
      gateway: fakeGateway,
      modelRouter: fakeRouter,
      store: fakeStore,
    });

    const context = await service.prepare("tenant-1", "agent-1", {
      model: "client-model",
      messages: [{ role: "user", content: "hello" }],
      tools: [clientTool("local_tool")],
    });
    await service.invoke("tenant-1", context);

    assert.equal(context.model, "client-model");
    assert.deepEqual(seenTools, ["re_server_tool", "local_tool"]);
    assert.equal(calledTool, false);
  });

  it("executes Zakura tools on the server instead of returning them to the client", async () => {
    let callCount = 0;
    const agent = {
      id: "agent-1",
      tenantId: "tenant-1",
      name: "Test Agent",
      slug: "test-agent",
      configJson: JSON.stringify({}),
      enableMemory: false,
    } as unknown as Agent;
    const rounds: Array<{ tools?: string; content?: string }> = [];
    const service = new OpenAiGatewayService({
      agentService: { get: async () => agent } as unknown as AgentService,
      gateway: {
        listToolsForAgent: async () => [
          {
            qualifiedName: "re_shell_exec",
            description: "run shell",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        callTool: async (_t: string, name: string) => {
          callCount += 1;
          assert.equal(name, "re_shell_exec");
          return { content: [{ type: "text", text: "vue ui started" }] };
        },
      } as unknown as McpGateway,
      modelRouter: {
        resolveRoute: async () => null,
        chat: async (
          _tenantId: string,
          messages: Array<{ role: string; content?: string | null }>,
        ) => {
          const last = messages[messages.length - 1];
          if (last?.role === "tool") {
            rounds.push({ content: "done" });
            return {
              content: "已在云端启动 vue ui",
              model: "m",
              openai: { id: "x", object: "chat.completion", created: 0, model: "m", choices: [] },
            };
          }
          rounds.push({ tools: "re_shell_exec" });
          return {
            content: "",
            model: "m",
            toolCalls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "re_shell_exec", arguments: "{\"cmd\":\"vue ui\"}" },
              },
            ],
            openai: { id: "x", object: "chat.completion", created: 0, model: "m", choices: [] },
          };
        },
      } as unknown as ModelRouterService,
      store: {
        createSession: async () => ({ id: "session-1" }),
        getSession: async () => null,
        listEvents: async () => [],
        listGatewaySessions: async () => [],
        appendEvent: async () => ({}),
        warmSession: async () => {},
        updateSession: async () => null,
      } as unknown as CloudAgentSessionStore,
    });

    const context = await service.prepare("tenant-1", "agent-1", {
      messages: [{ role: "user", content: "启动 vue ui" }],
    });
    const result = await service.invoke("tenant-1", context);

    assert.equal(callCount, 1);
    assert.equal(result.content, "已在云端启动 vue ui");
    assert.equal(result.toolCalls?.length ?? 0, 0);
    assert.equal(rounds.length, 2);
  });
});

describe("OpenAI gateway authentication", () => {
  it("rejects requests without an API key", async () => {
    const app = new Hono();
    registerOpenAiGatewayRoutes(app as never, {
      db: {} as never,
      agentService: {} as AgentService,
      gateway: {} as OpenAiGatewayService,
    });
    const response = await app.request("/v1/models");
    assert.equal(response.status, 401);
  });
});
