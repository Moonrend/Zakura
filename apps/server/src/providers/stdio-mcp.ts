import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderPlugin } from "@zakura/core";
import { textResult } from "@zakura/core";
import type {
  HealthResult,
  McpToolDef,
  McpToolResult,
  ProviderConfigSchema,
  RuntimeSpec,
} from "@zakura/shared";
import { mcpHttpRpc } from "../lib/mcp-http.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Lives next to providers/ under src/mcp/ (tsx) or dist/mcp/ after build. */
const BRIDGE_HOST_PATH = join(HERE, "..", "mcp", "stdio-bridge.mjs");

const DEFAULT_NODE_IMAGE = "node:22-bookworm-slim";
/** Includes `uv` / `uvx` for PyPI MCP packages */
const DEFAULT_PYTHON_IMAGE = "ghcr.io/astral-sh/uv:python3.12-bookworm-slim";

const DOCKER_SOCK_HOST =
  process.env.ZAKURA_DOCKER_SOCK?.trim() || "/var/run/docker.sock";

const configSchema: ProviderConfigSchema = {
  type: "object",
  title: "Stdio MCP（容器）",
  required: ["command"],
  properties: {
    command: {
      type: "string",
      title: "命令",
      description: "容器内可执行文件，例如 npx / node / uvx / docker / python",
      default: "npx",
    },
    args: {
      type: "string",
      title: "参数（JSON 数组）",
      format: "json",
      description: '例如 ["-y","@modelcontextprotocol/server-filesystem","/data"]',
      default: "[]",
    },
    env: {
      type: "string",
      title: "环境变量（JSON 对象）",
      format: "json",
      default: "{}",
    },
    image: {
      type: "string",
      title: "容器镜像",
      description: `默认 Node: ${DEFAULT_NODE_IMAGE}；Python 包建议 ${DEFAULT_PYTHON_IMAGE}`,
      default: DEFAULT_NODE_IMAGE,
    },
    workingDir: {
      type: "string",
      title: "工作目录",
      default: "/data",
    },
    packageManager: {
      type: "string",
      title: "包类型提示",
      description: "npm | pypi | oci | binary — 影响默认镜像与启动引导",
      enum: ["npm", "pypi", "oci", "binary"],
      default: "npm",
    },
  },
};

function parseJsonObject(raw: unknown, fallback: Record<string, string> = {}): Record<string, string> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v == null) continue;
      out[k] = String(v);
    }
    return out;
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      return parseJsonObject(JSON.parse(raw), fallback);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

type PackageManager = "npm" | "pypi" | "oci" | "binary";

function normalizePackageManager(raw: unknown): PackageManager {
  if (raw === "pypi" || raw === "oci" || raw === "binary") return raw;
  return "npm";
}

function resolveImage(config: Record<string, unknown>): string {
  if (typeof config.image === "string" && config.image.trim()) return config.image.trim();
  if (config.packageManager === "pypi") return DEFAULT_PYTHON_IMAGE;
  return DEFAULT_NODE_IMAGE;
}

function mcpEndpoint(handle: { endpointUrl?: string | null }): string {
  const base = (handle.endpointUrl || "").replace(/\/$/, "");
  if (!base) throw new Error("stdio-mcp endpoint not ready");
  return `${base}/mcp`;
}

/** Bootstrap script: ensure uvx exists, then run the Node HTTP↔stdio bridge. */
function pypiBootstrapCmd(): string[] {
  return [
    "bash",
    "-lc",
    [
      "set -euo pipefail;",
      "export DEBIAN_FRONTEND=noninteractive;",
      'export PATH="$HOME/.local/bin:/usr/local/bin:$PATH";',
      "if ! command -v uvx >/dev/null 2>&1; then",
      "  apt-get update -qq;",
      "  apt-get install -y -qq curl ca-certificates >/dev/null;",
      "  curl -LsSf https://astral.sh/uv/install.sh | sh;",
      '  export PATH="$HOME/.local/bin:$PATH";',
      "fi;",
      "command -v uvx >/dev/null;",
      "exec node /opt/zakura/stdio-bridge.mjs",
    ].join(" "),
  ];
}

/**
 * Bootstrap script: install static docker CLI (if missing), then run bridge.
 * Nested `docker run -i --rm <oci-image>` talks to the host daemon via the mounted socket.
 */
function ociBootstrapCmd(): string[] {
  return [
    "bash",
    "-lc",
    [
      "set -euo pipefail;",
      "export DEBIAN_FRONTEND=noninteractive;",
      "if ! command -v docker >/dev/null 2>&1; then",
      "  apt-get update -qq;",
      "  apt-get install -y -qq curl ca-certificates >/dev/null;",
      '  ARCH=$(uname -m);',
      '  case "$ARCH" in x86_64|amd64) DARCH=x86_64;; aarch64|arm64) DARCH=aarch64;; *) DARCH=x86_64;; esac;',
      '  curl -fsSL "https://download.docker.com/linux/static/stable/${DARCH}/docker-27.5.1.tgz" | tar xz -C /tmp;',
      "  install -m 755 /tmp/docker/docker /usr/local/bin/docker;",
      "  rm -rf /tmp/docker;",
      "fi;",
      "command -v docker >/dev/null;",
      "docker version >/dev/null;",
      "exec node /opt/zakura/stdio-bridge.mjs",
    ].join(" "),
  ];
}

/**
 * Run local CLI / npm / pypi / OCI MCP servers inside an isolated container,
 * bridged to streamable HTTP via stdio-bridge.mjs.
 */
export function createStdioMcpProvider(): ProviderPlugin {
  return {
    id: "stdio-mcp",
    name: "Stdio MCP",
    description:
      "在 Node 容器中运行本地命令行 MCP（npx / uvx / docker run OCI …），经 HTTP 桥接接入网关",
    version: "0.2.0",
    category: "mcp",
    capabilities: ["mcp-proxy", "tools", "containers"],
    configSchema,

    validateConfig(config) {
      const command = typeof config.command === "string" ? config.command.trim() : "";
      if (!command) throw new Error("command is required");
      const args = parseJsonArray(config.args);
      const env = parseJsonObject(config.env);
      const packageManager = normalizePackageManager(config.packageManager);
      return {
        command,
        args: JSON.stringify(args),
        env: JSON.stringify(env),
        image: resolveImage({ ...config, packageManager }),
        workingDir:
          typeof config.workingDir === "string" && config.workingDir.trim()
            ? config.workingDir.trim()
            : "/data",
        packageManager,
      };
    },

    createRuntimeSpec(config, ctx): RuntimeSpec {
      const command = String(config.command);
      const args = parseJsonArray(config.args);
      const env = parseJsonObject(config.env);
      const packageManager = normalizePackageManager(config.packageManager);
      // Bridge is Node-based — always run on a Node image; install uv / docker CLI when needed.
      const image =
        typeof config.image === "string" &&
        config.image.trim() &&
        !config.image.includes("python") &&
        !config.image.includes("uv:")
          ? config.image.trim()
          : DEFAULT_NODE_IMAGE;
      const workingDir = String(config.workingDir || "/data");
      const dataHost = join(ctx.dataDir, "stdio-mcp", ctx.instanceId);

      const startCmd =
        packageManager === "pypi"
          ? pypiBootstrapCmd()
          : packageManager === "oci"
            ? ociBootstrapCmd()
            : ["node", "/opt/zakura/stdio-bridge.mjs"];

      const volumes: NonNullable<RuntimeSpec["containers"][0]["volumes"]> = [
        {
          hostPath: dataHost,
          containerPath: "/data",
        },
        {
          hostPath: BRIDGE_HOST_PATH,
          containerPath: "/opt/zakura/stdio-bridge.mjs",
          readOnly: true,
        },
      ];

      if (packageManager === "oci") {
        volumes.push({
          hostPath: DOCKER_SOCK_HOST,
          containerPath: "/var/run/docker.sock",
        });
      }

      return {
        primaryContainer: "mcp",
        endpointTemplate: "http://{host}:{port}",
        containers: [
          {
            name: "mcp",
            image,
            purpose: "component",
            workingDir,
            ports: [{ containerPort: 3100, hostIp: "127.0.0.1" }],
            volumes,
            env: {
              ...env,
              MCP_COMMAND: command,
              MCP_ARGS: JSON.stringify(args),
              MCP_CWD: workingDir,
              MCP_PORT: "3100",
              MCP_PATH: "/mcp",
              NODE_ENV: "production",
              PATH: "/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
              ...(packageManager === "oci"
                ? { DOCKER_HOST: "unix:///var/run/docker.sock" }
                : {}),
            },
            command: startCmd,
            restartPolicy: "unless-stopped",
            healthcheck: {
              test: [
                "CMD-SHELL",
                "node -e \"fetch('http://127.0.0.1:3100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
              ],
              intervalMs: 15000,
              timeoutMs: 5000,
              retries: 12,
            },
          },
        ],
      };
    },

    async afterStart(handle, ctx) {
      // Wait briefly for bridge + child initialize (npm/uvx first download can be slow)
      const url = mcpEndpoint(handle);
      const deadline = Date.now() + 120000;
      let lastErr = "";
      while (Date.now() < deadline) {
        try {
          await mcpHttpRpc(url, {}, "tools/list", undefined, 15000);
          ctx.logger.info("stdio-mcp ready", { instanceId: handle.id, url });
          return;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      ctx.logger.warn("stdio-mcp warm-up incomplete", { lastErr, url });
    },

    async healthCheck(handle): Promise<HealthResult> {
      try {
        await mcpHttpRpc(mcpEndpoint(handle), {}, "tools/list", undefined, 10000);
        return { status: "healthy", message: "tools/list ok" };
      } catch (err) {
        return {
          status: "unhealthy",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async listTools(handle): Promise<McpToolDef[]> {
      const result = (await mcpHttpRpc(mcpEndpoint(handle), {}, "tools/list")) as {
        tools?: Array<{
          name: string;
          description?: string;
          inputSchema?: Record<string, unknown>;
        }>;
      };
      return (result.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? t.name,
        inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      }));
    },

    async callTool(handle, toolName, args): Promise<McpToolResult> {
      try {
        const result = await mcpHttpRpc(mcpEndpoint(handle), {}, "tools/call", {
          name: toolName,
          arguments: args,
        });
        if (result && typeof result === "object" && "content" in result) {
          return result as McpToolResult;
        }
        return textResult(JSON.stringify(result, null, 2));
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  };
}

export { DEFAULT_NODE_IMAGE, DEFAULT_PYTHON_IMAGE, parseJsonArray, parseJsonObject };
export type { PackageManager };
