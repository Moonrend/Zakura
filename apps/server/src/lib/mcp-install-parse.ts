/**
 * Parse VS Code / Cursor MCP JSON configs and build human-readable install previews.
 */

export type ParsedMcpEntry = {
  key: string;
  kind: "http" | "stdio";
  name: string;
  mcpUrl?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  packageManager?: "npm" | "pypi" | "oci" | "binary";
};

export type InstallPreviewOption = {
  id: string;
  kind: "http" | "stdio-npm" | "stdio-pypi" | "stdio-oci" | "stdio-other";
  label: string;
  /** One-line command or URL shown in UI */
  summary: string;
  detail?: string;
  /** Suggested prefer for install API */
  prefer: "http" | "stdio";
  packageIndex?: number;
  remoteUrl?: string;
  envHints?: Array<{
    name: string;
    description?: string;
    isRequired?: boolean;
    isSecret?: boolean;
    default?: string;
  }>;
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

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function stringMap(v: unknown): Record<string, string> | undefined {
  const r = asRecord(v);
  if (!r) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(r)) {
    if (val == null) continue;
    out[k] = String(val);
  }
  return out;
}

function inferPackageManager(command?: string, args?: string[]): "npm" | "pypi" | "oci" | "binary" {
  const cmd = (command ?? "").toLowerCase();
  if (cmd === "docker" || cmd === "podman") return "oci";
  if (cmd === "uvx" || cmd === "uv" || cmd === "pipx") return "pypi";
  if (cmd === "npx" || cmd === "npm" || cmd === "node" || cmd === "bunx") return "npm";
  if (args?.some((a) => a.startsWith("@") || a.includes("npm"))) return "npm";
  return "binary";
}

/** Extract mcpServers / servers map from various editor config shapes */
export function extractServerMap(input: unknown): Record<string, unknown> | null {
  const root = asRecord(input);
  if (!root) return null;

  // Cursor / classic: { mcpServers: { name: {...} } }
  if (asRecord(root.mcpServers)) return asRecord(root.mcpServers);

  // VS Code 1.102+: { servers: { name: {...} } }
  if (asRecord(root.servers)) return asRecord(root.servers);

  // Nested: { mcp: { servers: {...} } }
  const mcp = asRecord(root.mcp);
  if (mcp && asRecord(mcp.servers)) return asRecord(mcp.servers);

  // Single server object pasted directly
  if (root.url || root.command || root.type) {
    return { server: root };
  }

  // Already a map of servers (heuristic: values look like server configs)
  const values = Object.values(root);
  if (
    values.length > 0 &&
    values.every((v) => {
      const r = asRecord(v);
      return r && (r.url || r.command || r.type);
    })
  ) {
    return root;
  }

  return null;
}

export function parseEditorMcpConfig(raw: string | unknown): ParsedMcpEntry[] {
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  const map = extractServerMap(parsed);
  if (!map) {
    throw new Error(
      "无法识别 MCP 配置。请粘贴 VS Code / Cursor 的 mcp.json（含 mcpServers 或 servers）",
    );
  }

  const entries: ParsedMcpEntry[] = [];
  for (const [key, value] of Object.entries(map)) {
    const cfg = asRecord(value);
    if (!cfg) continue;

    const type = String(cfg.type ?? "").toLowerCase();
    const url = typeof cfg.url === "string" ? cfg.url : undefined;
    const command = typeof cfg.command === "string" ? cfg.command : undefined;
    const args = Array.isArray(cfg.args) ? cfg.args.map(String) : undefined;
    const env = stringMap(cfg.env);
    const headers = stringMap(cfg.headers);

    if (url || type === "http" || type === "sse" || type === "streamable-http") {
      if (!url) throw new Error(`服务器「${key}」缺少 url`);
      entries.push({
        key,
        kind: "http",
        name: key,
        mcpUrl: url,
        headers,
      });
      continue;
    }

    if (command || type === "stdio") {
      if (!command) throw new Error(`服务器「${key}」缺少 command`);
      entries.push({
        key,
        kind: "stdio",
        name: key,
        command,
        args: args ?? [],
        env,
        packageManager: inferPackageManager(command, args),
      });
      continue;
    }

    throw new Error(`服务器「${key}」无法识别（需要 url 或 command）`);
  }

  if (!entries.length) throw new Error("配置中没有可用的 MCP 服务器条目");
  return entries;
}

export function previewFromPackagesAndRemotes(input: {
  packages?: Array<{
    registryType: string;
    identifier: string;
    version?: string;
    runtimeHint?: string;
    transport?: { type: string };
    runtimeArguments?: Array<{
      value?: string;
      name?: string;
      type?: string;
      default?: string;
    }>;
    packageArguments?: Array<{ value?: string; name?: string; type?: string; default?: string }>;
    environmentVariables?: InstallPreviewOption["envHints"];
  }>;
  remotes?: Array<{ type: string; url: string; headers?: Array<{ name: string; isSecret?: boolean; description?: string }> }>;
  installHint?: string;
}): InstallPreviewOption[] {
  const options: InstallPreviewOption[] = [];

  for (const [i, remote] of (input.remotes ?? []).entries()) {
    if (!remote.url) continue;
    const authHeaders = (remote.headers ?? [])
      .map((h) => h.name)
      .filter(Boolean)
      .join(", ");
    options.push({
      id: `http-${i}`,
      kind: "http",
      label: "HTTP 远程",
      summary: remote.url,
      detail: authHeaders
        ? `传输: ${remote.type || "http"} · 鉴权头: ${authHeaders}`
        : `传输: ${remote.type || "http"}`,
      prefer: "http",
      remoteUrl: remote.url,
      envHints: (remote.headers ?? [])
        .filter((h) => h.isSecret || /authorization|token|api.?key/i.test(h.name))
        .map((h) => ({
          name: h.name === "Authorization" ? "API_KEY" : h.name,
          description: h.description ?? `HTTP header ${h.name}`,
          isRequired: true,
          isSecret: true,
        })),
    });
  }

  for (const [i, pkg] of (input.packages ?? []).entries()) {
    const runtimeArgs = (pkg.runtimeArguments ?? [])
      .map((a) => a.value)
      .filter((v): v is string => !!v);
    const packageArgs = (pkg.packageArguments ?? [])
      .map((a) => a.value)
      .filter((v): v is string => !!v);

    if (pkg.registryType === "npm") {
      const cmd = ["npx", "-y", pkg.identifier, ...packageArgs].join(" ");
      options.push({
        id: `npm-${i}`,
        kind: "stdio-npm",
        label: "npm / npx",
        summary: cmd,
        detail: pkg.version ? `版本 ${pkg.version}` : undefined,
        prefer: "stdio",
        packageIndex: i,
        envHints: pkg.environmentVariables,
      });
    } else if (pkg.registryType === "pypi") {
      const hint = pkg.runtimeHint === "uvx" || !pkg.runtimeHint ? "uvx" : pkg.runtimeHint;
      const cmd = [hint, pkg.identifier, ...packageArgs].join(" ");
      options.push({
        id: `pypi-${i}`,
        kind: "stdio-pypi",
        label: "PyPI / uvx",
        summary: cmd,
        detail: pkg.version ? `版本 ${pkg.version}` : "Python 包，容器内安装 uv 后运行",
        prefer: "stdio",
        packageIndex: i,
        envHints: pkg.environmentVariables,
      });
    } else if (pkg.registryType === "oci") {
      const dockerArgs = ["docker", "run", "-i", "--rm", ...runtimeArgs, pkg.identifier, ...packageArgs];
      // Prefer defaults from descriptor when value omitted (preview only)
      const runtimePreview = (pkg.runtimeArguments ?? [])
        .map((a) => {
          const v = a.value ?? a.default;
          if (a.type === "named" && a.name) {
            if (v == null || v === "" || v === "true") return a.name;
            if (v === "false") return "";
            return `${a.name} ${v}`;
          }
          return v ?? "";
        })
        .filter(Boolean);
      const pkgPreview = (pkg.packageArguments ?? [])
        .map((a) => {
          const v = a.value ?? a.default;
          if (a.type === "named" && a.name) {
            if (v == null || v === "" || v === "true") return a.name;
            if (v === "false") return "";
            return `${a.name} ${v}`;
          }
          return v ?? "";
        })
        .filter(Boolean);
      const summary = ["docker", "run", "-i", "--rm", ...runtimePreview, pkg.identifier, ...pkgPreview]
        .filter(Boolean)
        .join(" ");
      options.push({
        id: `oci-${i}`,
        kind: "stdio-oci",
        label: "OCI / Docker",
        summary: summary || dockerArgs.join(" "),
        detail: "通过 Docker socket 在隔离容器内拉取并运行 OCI 镜像（stdio）",
        prefer: "stdio",
        packageIndex: i,
        envHints: pkg.environmentVariables,
      });
    } else {
      options.push({
        id: `other-${i}`,
        kind: "stdio-other",
        label: pkg.registryType || "其他",
        summary: pkg.identifier,
        prefer: "stdio",
        packageIndex: i,
        envHints: pkg.environmentVariables,
      });
    }
  }

  if (!options.length && input.installHint) {
    options.push({
      id: "hint",
      kind: /uvx|pip/i.test(input.installHint) ? "stdio-pypi" : "stdio-npm",
      label: "安装提示",
      summary: input.installHint,
      prefer: "stdio",
    });
  }

  return options;
}

export function entryToImportBody(entry: ParsedMcpEntry): {
  providerId: "generic-mcp" | "stdio-mcp";
  name: string;
  slug: string;
  config: Record<string, unknown>;
  authMode?: "none" | "apiKey" | "oauth";
} {
  const slug = slugify(entry.name || entry.key);
  if (entry.kind === "http") {
    const authHeader = entry.headers?.Authorization || entry.headers?.authorization;
    let apiKey = "";
    if (authHeader) {
      apiKey = authHeader.replace(/^Bearer\s+/i, "").trim();
    } else if (entry.headers) {
      const first = Object.values(entry.headers)[0];
      if (first) apiKey = first;
    }
    let mcpUrl = entry.mcpUrl ?? "";
    try {
      // local import to avoid circular deps at module load — duplicate light normalize
      const u = new URL(mcpUrl);
      const host = u.hostname.toLowerCase();
      let path = u.pathname.replace(/\/+$/, "") || "/";
      if (host === "mcp.notion.com") {
        if (path === "/" || path === "/sse") path = "/mcp";
      }
      if (host === "mcp.supabase.com" && (path === "/" || path === "")) path = "/mcp";
      u.pathname = path;
      mcpUrl = u.toString().replace(/\/$/, "");
    } catch {
      /* keep raw */
    }
    return {
      providerId: "generic-mcp",
      name: entry.name || entry.key,
      slug,
      config: {
        mcpUrl,
        apiKey,
        headerName: "Authorization",
      },
      authMode: apiKey ? "apiKey" : "none",
    };
  }

  return {
    providerId: "stdio-mcp",
    name: entry.name || entry.key,
    slug,
    config: {
      command: entry.command,
      args: JSON.stringify(entry.args ?? []),
      env: JSON.stringify(entry.env ?? {}),
      image: "node:22-bookworm-slim",
      workingDir: "/data",
      packageManager: entry.packageManager ?? "npm",
    },
  };
}
