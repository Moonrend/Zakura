import { api } from "@/lib/api";
import type { McpToolRow, McpResourceRow, McpResourceTemplateRow, McpPromptRow } from "@/components/mcp/capability-explorers";

export type SpaceMcpCapabilities = {
  spaceId: string;
  tools: McpToolRow[];
  resources: McpResourceRow[];
  resourceTemplates: McpResourceTemplateRow[];
  prompts: McpPromptRow[];
  errors: Array<{ instanceId: string; method: string; error: string }>;
};
export function fetchSpaceMcpCapabilities(spaceId: string) {
  return api<SpaceMcpCapabilities>(`/api/spaces/${encodeURIComponent(spaceId)}/mcp/capabilities`);
}
export type SpaceMcpInventory = {
  spaceId: string;
  instances: Array<{ id: string; name: string; slug: string; status: string; kind: "http" | "stdio"; ownerSpaceId: string | null; ownershipError: string | null; lastError: string | null }>;
};
export function fetchSpaceMcpInventory(spaceId: string) {
  return api<SpaceMcpInventory>(`/api/spaces/${encodeURIComponent(spaceId)}/mcp/inventory`);
}
