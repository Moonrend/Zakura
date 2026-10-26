export type ConnectProtocol = "mcp" | "gateway";
export type ConnectKeyAccess = "both" | ConnectProtocol;

export const CONNECT_KEY_ACCESS = [
  { value: "both", label: "MCP 和 AI Gateway" },
  { value: "mcp", label: "MCP" },
  { value: "gateway", label: "AI Gateway" },
] satisfies Array<{ value: ConnectKeyAccess; label: string }>;

export function connectKeyScopes(access: ConnectKeyAccess): string[] {
  if (access === "mcp") return ["mcp"];
  if (access === "gateway") return ["gateway:models", "gateway:chat"];
  return ["mcp", "gateway:models", "gateway:chat"];
}

export function keySupportsProtocol(scopes: string[], protocol: ConnectProtocol): boolean {
  if (scopes.includes("*")) return true;
  return protocol === "mcp"
    ? scopes.includes("mcp")
    : scopes.some((scope) => scope === "gateway" || scope.startsWith("gateway:"));
}

export function connectKeyAccessLabel(scopes: string[]): string {
  if (scopes.includes("*")) return "全部权限";
  const labels: string[] = [];
  if (keySupportsProtocol(scopes, "mcp")) labels.push("MCP");
  if (keySupportsProtocol(scopes, "gateway")) labels.push("AI Gateway");
  if (scopes.includes("api")) labels.push("API");
  return labels.join("、") || scopes.join("、") || "无权限";
}

export function buildConnectSnippets({
  mcpUrl,
  gatewayBaseUrl,
  spaceSlug,
  key = "<access-key>",
}: {
  mcpUrl: string;
  gatewayBaseUrl: string;
  spaceSlug: string;
  key?: string;
}) {
  const serverName = `zakura-${spaceSlug || "space"}`;
  const connection = {
    url: mcpUrl,
    headers: { Authorization: `Bearer ${key}` },
  };
  return {
    mcpServers: JSON.stringify({ mcpServers: { [serverName]: connection } }, null, 2),
    servers: JSON.stringify({ servers: { [serverName]: { type: "http", ...connection } } }, null, 2),
    request: `curl '${mcpUrl}' \\\n  -H 'Authorization: Bearer ${key}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Accept: application/json, text/event-stream' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    gateway: `OPENAI_BASE_URL=${gatewayBaseUrl}\nOPENAI_API_KEY=${key}`,
  };
}
