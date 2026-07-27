import type { FetchBackendId } from "@zakura/shared";

export interface FetchRequest {
  url: string;
  timeoutMs?: number;
}

export interface FetchResult {
  url: string;
  title?: string;
  content: string;
  contentType?: string;
  backend: FetchBackendId;
}

export interface BackendCredentials {
  apiKey?: string;
  baseUrl?: string;
}

export interface FetchBackendMeta {
  id: FetchBackendId;
  name: string;
  description: string;
  requiresApiKey: boolean;
  requiresBaseUrl?: boolean;
  docsUrl?: string;
  apiKeyUrl?: string;
  platformServiceKey?: string;
}

export interface FetchBackend extends FetchBackendMeta {
  fetch(req: FetchRequest, creds: BackendCredentials): Promise<FetchResult>;
}

/** One credential / endpoint slot; multiple slots of the same backend round-robin. */
export type CredSlot = {
  id: string;
  label?: string;
  usePlatform?: boolean;
  apiKey?: string;
  baseUrl?: string;
};

export type BackendRuntimeConfig = {
  enabled: boolean;
  slots?: CredSlot[];
  apiKey?: string;
  baseUrl?: string;
};

export type WebFetchConfig = {
  defaultBackend?: FetchBackendId;
  backends: Partial<Record<FetchBackendId, BackendRuntimeConfig>>;
};

export type CredSlotPublic = {
  id: string;
  label?: string;
  usePlatform?: boolean;
  hasApiKey: boolean;
  baseUrl?: string;
};

export type BackendRuntimeConfigPublic = {
  enabled: boolean;
  slots: CredSlotPublic[];
};

export type WebFetchConfigPublic = {
  defaultBackend?: FetchBackendId;
  backends: Partial<Record<FetchBackendId, BackendRuntimeConfigPublic>>;
};
