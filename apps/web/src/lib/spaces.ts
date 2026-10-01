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
  createdAt: string;
  updatedAt: string;
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
