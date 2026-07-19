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
}

export interface FetchBackend extends FetchBackendMeta {
  fetch(req: FetchRequest, creds: BackendCredentials): Promise<FetchResult>;
}

export type BackendRuntimeConfig = {
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
};

export type WebFetchConfig = {
  defaultBackend?: FetchBackendId;
  backends: Partial<Record<FetchBackendId, BackendRuntimeConfig>>;
};
