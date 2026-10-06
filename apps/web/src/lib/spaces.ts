import { api } from "@/lib/api";

export type SpaceItem = {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  description: string;
  workspaceImage: string | null;
  runtimeNodeId: string | null;
  workspaceKind: string;
  workspaceStatus: string;
  workspaceRevision: string | null;
  workspaceHostPath: string;
  isDefault: boolean;
  agentCount: number;
  mcpUrl?: string;
  createdAt: string;
  updatedAt: string;
};

export type SpaceProviderOptions = {
  mcp: {
    mode: "all" | "selected";
    exposeWorkspaceFs?: boolean;
    instances: Array<{
      id: string;
      name: string;
      slug: string;
      providerId: string;
      status: string;
      bound: boolean;
    }>;
  };
};

export type SpaceKey = {
  id: string;
  name: string;
  agentId: string | null;
  spaceId: string | null;
  keyPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  rawKey: string;
};

export async function fetchSpaces(): Promise<SpaceItem[]> {
  return api<SpaceItem[]>("/api/spaces");
}

export async function fetchSpace(id: string): Promise<SpaceItem> {
  return api<SpaceItem>(`/api/spaces/${encodeURIComponent(id)}`);
}

export async function createSpace(input: {
  name: string;
  description?: string;
  workspaceImage?: string | null;
}): Promise<SpaceItem> {
  return api<SpaceItem>("/api/spaces", { method: "POST", json: input });
}

export async function updateSpace(
  id: string,
  patch: { name?: string; description?: string; workspaceImage?: string | null },
): Promise<SpaceItem> {
  return api<SpaceItem>(`/api/spaces/${encodeURIComponent(id)}`, {
    method: "PATCH",
    json: patch,
  });
}

export async function deleteSpace(id: string): Promise<void> {
  await api(`/api/spaces/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function fetchSpaceProviders(id: string): Promise<SpaceProviderOptions> {
  return api<SpaceProviderOptions>(`/api/spaces/${encodeURIComponent(id)}/providers`);
}

export async function saveSpaceProviders(
  id: string,
  body: {
    mcp: {
      mode?: "all" | "selected";
      instanceIds?: string[];
      exposeWorkspaceFs?: boolean;
    };
  },
): Promise<SpaceProviderOptions> {
  return api<SpaceProviderOptions>(`/api/spaces/${encodeURIComponent(id)}/providers`, {
    method: "PUT",
    json: body,
  });
}

export async function createSpaceKey(id: string, name: string): Promise<SpaceKey> {
  return api<SpaceKey>(`/api/spaces/${encodeURIComponent(id)}/keys`, {
    method: "POST",
    json: { name },
  });
}
