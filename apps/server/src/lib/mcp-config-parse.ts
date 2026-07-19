/**
 * Parse VS Code / Cursor / Claude Desktop MCP JSON configs into installable specs.
 *
 * Supported shapes:
 * - { mcpServers: { name: { url|command|args|env|headers|type } } }
 * - { servers: { name: { ... } } }  (VS Code 1.101+)
 * - single server object with url/command
 */

export type ParsedMcpServerSpec =
  | {
      kind: "http";
      name: string;
      slug: string;
      mcpUrl: string;
      apiKey?: string;
      headerName?: string;
      authType: "none" | "apiKey" | "oauth2.1";
    }
  | {
      kind: "stdio";
      name: string;
      slug: string;
      command: string;
      args: string[];
      env: Record<string, string>;
      packageManager: "npm" | "pypi" | "oci" | "binary";
    };

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || `mcp-${Date.now().toString(36)}`
  );
}

export function slugFromMcpUrl(mcpUrl: string): string {
  try {
    const u = new URL(mcpUrl);
    const host = u.hostname.replace(/^www\./, "").replace(/\./g, "-");
    const path = u.pathname
      .replace(/\/+/g, "-")
      .replace(/^-|-$/g, "")
      .replace(/[^a-z0-9-]+/gi, "")
      .slice(0, 24);
    return slugify([host, path].filter(Boolean).join("-")).slice(0, 40);
  } catch {
    return `mcp-${Date.now().toString(36)}`;
  }
}

export function nameFromMcpUrl(mcpUrl: string): string {
  try {
    const u = new URL(mcpUrl);
    const host = u.hostname.replace(/^www\./, "");
    return `MCP ${host}`;
  } catch {
    return "Imported MCP";
  }
}

function extractBearer(headers?: Record<string, unknown>): {
  apiKey?: string;
  headerName?: string;
} {
  if (!headers || typeof headers !== "object") return {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== "string" || !v.trim()) continue;
    if (k.toLowerCase() === "authorization") {
      const m = v.match(/^Bearer\s+(.+)$/i);
      return { apiKey: m?.[1]?.trim() || v.trim(), headerName: "Authorization" };
    }
    return { apiKey: v.trim(), headerName: k };
  }
  return {};
}

function detectPackageManager(command: string, args: string[]): "npm" | "pypi" | "oci" | "binary" {
  const cmd = command.toLowerCase();
  if (cmd === "docker" || cmd === "podman") return "oci";
  if (cmd === "uvx" || cmd === "uv" || cmd === "pipx" || cmd === "python" || cmd === "python3") {
    return "pypi";
  }
  if (cmd === "npx" || cmd === "npm" || cmd === "node" || cmd === "bunx") return "npm";
  if (args.some((a) => a.startsWith("@") || a.includes("npm"))) return "npm";
  return "binary";
}

function parseOneEntry(name: string, raw: Record<string, unknown>): ParsedMcpServerSpec {
  const type = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
  const url =
    (typeof raw.url === "string" && raw.url) ||
    (typeof raw.serverUrl === "string" && raw.serverUrl) ||
    "";
  const command = typeof raw.command === "string" ? raw.command : "";
  const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  const env =
    raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)
      ? Object.fromEntries(
          Object.entries(raw.env as Record<string, unknown>)
            .filter(([, v]) => v != null)
            .map(([k, v]) => [k, String(v)]),
        )
      : {};

  const headers =
    raw.headers && typeof raw.headers === "object"
      ? (raw.headers as Record<string, unknown>)
      : undefined;
  const { apiKey, headerName } = extractBearer(headers);

  const isHttp =
    type === "http" ||
    type === "sse" ||
    type === "streamable-http" ||
    type === "streamablehttp" ||
    (!!url && !command);

  if (isHttp) {
    if (!url) throw new Error(`服务器「${name}」缺少 url`);
    const authType: "none" | "apiKey" | "oauth2.1" = apiKey ? "apiKey" : "none";
    return {
      kind: "http",
      name,
      slug: slugify(name),
      mcpUrl: url,
      apiKey,
      headerName: headerName ?? "Authorization",
      authType,
    };
  }

  if (!command) throw new Error(`服务器「${name}」缺少 command 或 url`);
  return {
    kind: "stdio",
    name,
    slug: slugify(name),
    command,
    args,
    env,
    packageManager: detectPackageManager(command, args),
  };
}

/** Parse a full mcp.json / settings snippet into zero or more server specs */
export function parseMcpConfigJson(input: unknown): ParsedMcpServerSpec[] {
  let root = input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) throw new Error("配置为空");
    try {
      root = JSON.parse(trimmed);
    } catch {
      throw new Error("JSON 解析失败，请粘贴 VS Code / Cursor 的 mcp.json 片段");
    }
  }
  if (!root || typeof root !== "object") throw new Error("配置必须是 JSON 对象");

  const obj = root as Record<string, unknown>;

  // Full document with mcpServers / servers map
  const mapCandidate =
    (obj.mcpServers && typeof obj.mcpServers === "object"
      ? obj.mcpServers
      : null) ??
    (obj.servers && typeof obj.servers === "object" ? obj.servers : null);

  if (mapCandidate && !Array.isArray(mapCandidate)) {
    const out: ParsedMcpServerSpec[] = [];
    for (const [name, value] of Object.entries(mapCandidate as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      out.push(parseOneEntry(name, value as Record<string, unknown>));
    }
    if (!out.length) throw new Error("未找到可导入的服务器条目");
    return out;
  }

  // Single server object
  if (obj.url || obj.command || obj.type) {
    const name =
      (typeof obj.name === "string" && obj.name) ||
      (typeof obj.url === "string" ? nameFromMcpUrl(obj.url) : "imported-mcp");
    return [parseOneEntry(slugify(name), obj)];
  }

  throw new Error(
    "无法识别配置格式。请使用 { \"mcpServers\": { \"name\": { \"url\"|\"command\"... } } }",
  );
}

/** Human-readable install preview lines */
export function describeInstallSpec(spec: ParsedMcpServerSpec): string {
  if (spec.kind === "http") {
    const auth =
      spec.authType === "oauth2.1"
        ? "OAuth 2.1"
        : spec.authType === "apiKey"
          ? "API Key"
          : "无鉴权";
    return `HTTP ${spec.mcpUrl}（${auth}）`;
  }
  const runtime =
    spec.packageManager === "pypi"
      ? "uv/uvx"
      : spec.packageManager === "npm"
        ? "npx/npm"
        : spec.packageManager === "oci"
          ? "docker/oci"
          : "binary";
  return `${runtime}: ${spec.command} ${spec.args.join(" ")}`.trim();
}
