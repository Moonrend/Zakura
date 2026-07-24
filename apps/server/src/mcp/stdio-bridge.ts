/**
 * Streamable HTTP ↔ stdio MCP 桥接（@modelcontextprotocol/sdk）
 *
 * Env:
 *   MCP_COMMAND  — 可执行文件（必填）
 *   MCP_ARGS     — JSON 数组参数
 *   MCP_CWD      — 工作目录
 *   MCP_PORT     — 监听端口（默认 3100）
 *   MCP_PATH     — HTTP 路径（默认 /mcp）
 */
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  isInitializeRequest,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import cors from "cors";
import express from "express";
import type { Request, Response } from "express";

const COMMAND = process.env.MCP_COMMAND;
const ARGS = (() => {
  try {
    const raw = process.env.MCP_ARGS || "[]";
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
})();
const CWD = process.env.MCP_CWD || process.cwd();
const PORT = Number(process.env.MCP_PORT || 3100);
const PATH = process.env.MCP_PATH || "/mcp";

if (!COMMAND) {
  console.error("[stdio-bridge] MCP_COMMAND is required");
  process.exit(1);
}

const transports: Record<string, StreamableHTTPServerTransport> = {};
const servers: Record<string, Server> = {};

let upstream: Client | null = null;
let upstreamReady: Promise<Client> | null = null;

async function getUpstream(): Promise<Client> {
  if (upstream) return upstream;
  if (upstreamReady) return upstreamReady;

  upstreamReady = (async () => {
    const transport = new StdioClientTransport({
      command: COMMAND!,
      args: ARGS,
      cwd: CWD,
      stderr: "inherit",
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    });
    const client = new Client(
      { name: "zakura-stdio-bridge", version: "0.3.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    upstream = client;
    console.error(
      `[stdio-bridge] connected stdio → ${COMMAND} ${ARGS.join(" ")}`,
    );
    return client;
  })();

  try {
    return await upstreamReady;
  } catch (err) {
    upstreamReady = null;
    throw err;
  }
}

function createBridgeServer(client: Client): Server {
  const caps = client.getServerCapabilities() ?? {};
  const serverInfo = client.getServerVersion();

  const server = new Server(
    {
      name: serverInfo?.name ?? "zakura-stdio-bridge",
      version: serverInfo?.version ?? "0.3.0",
      title: serverInfo?.title,
    },
    {
      capabilities: {
        tools: caps.tools ?? {},
        ...(caps.resources ? { resources: caps.resources } : {}),
        ...(caps.prompts ? { prompts: caps.prompts } : {}),
        ...(caps.logging ? { logging: caps.logging } : {}),
        ...(caps.completions ? { completions: caps.completions } : {}),
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (req) =>
    client.listTools(req.params),
  );
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    client.callTool(req.params),
  );

  if (caps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (req) =>
      client.listResources(req.params),
    );
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (req) =>
      client.listResourceTemplates(req.params),
    );
    server.setRequestHandler(ReadResourceRequestSchema, async (req) =>
      client.readResource(req.params),
    );
    if (caps.resources.subscribe) {
      server.setRequestHandler(SubscribeRequestSchema, async (req) =>
        client.subscribeResource(req.params),
      );
      server.setRequestHandler(UnsubscribeRequestSchema, async (req) =>
        client.unsubscribeResource(req.params),
      );
    }
  }

  if (caps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (req) =>
      client.listPrompts(req.params),
    );
    server.setRequestHandler(GetPromptRequestSchema, async (req) =>
      client.getPrompt(req.params),
    );
  }

  if (caps.completions) {
    server.setRequestHandler(CompleteRequestSchema, async (req) =>
      client.complete(req.params),
    );
  }

  return server;
}

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(
  cors({
    origin: "*",
    exposedHeaders: ["Mcp-Session-Id", "MCP-Protocol-Version"],
    allowedHeaders: [
      "Content-Type",
      "mcp-session-id",
      "last-event-id",
      "mcp-protocol-version",
      "Accept",
    ],
  }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, ready: !!upstream, command: COMMAND });
});

app.get("/", (_req, res) => {
  res.json({ ok: true, ready: !!upstream, command: COMMAND });
});

app.post(PATH, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  try {
    const client = await getUpstream();

    if (sessionId && transports[sessionId]) {
      await transports[sessionId]!.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const mcpServer = createBridgeServer(client);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
          servers[sid] = mcpServer;
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
          if (servers[sid]) {
            void servers[sid]!.close().catch(() => undefined);
            delete servers[sid];
          }
        }
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid or missing session ID" },
      id: null,
    });
  } catch (err) {
    console.error("[stdio-bridge] POST error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
        id: null,
      });
    }
  }
});

app.get(PATH, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  try {
    await transports[sessionId]!.handleRequest(req, res);
  } catch (err) {
    console.error("[stdio-bridge] GET error:", err);
    if (!res.headersSent) res.status(500).send("SSE error");
  }
});

app.delete(PATH, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  try {
    await transports[sessionId]!.handleRequest(req, res);
  } catch (err) {
    console.error("[stdio-bridge] DELETE error:", err);
    if (!res.headersSent) res.status(500).send("Session termination error");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.error(
    `[stdio-bridge] listening :${PORT}${PATH} (SDK) → ${COMMAND} ${ARGS.join(" ")}`,
  );
});

process.on("SIGTERM", () => {
  void upstream?.close();
  process.exit(0);
});
