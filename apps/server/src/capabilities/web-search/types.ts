import type { SearchEngineId } from "@zakura/shared";

export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
  score?: number;
}

export interface SearchRequest {
  query: string;
  limit?: number;
  language?: string;
}

export interface EngineCredentials {
  apiKey?: string;
  baseUrl?: string;
  /** Google CSE id / Bing custom config etc. */
  extra?: Record<string, string>;
}

export interface SearchEngineMeta {
  id: SearchEngineId;
  name: string;
  description: string;
  requiresApiKey: boolean;
  requiresBaseUrl?: boolean;
  /** Extra config field labels shown in UI */
  extraFields?: Array<{
    key: string;
    title: string;
    secret?: boolean;
    placeholder?: string;
  }>;
  /** Product / docs homepage */
  docsUrl?: string;
  /** Where to obtain an API key */
  apiKeyUrl?: string;
  /** True when a platform-hosted container can satisfy this engine */
  platformServiceKey?: string;
}

export interface SearchEngine extends SearchEngineMeta {
  search(req: SearchRequest, creds: EngineCredentials): Promise<SearchHit[]>;
}

/** One credential / endpoint slot; multiple slots of the same engine round-robin. */
export type CredSlot = {
  id: string;
  label?: string;
  /** Use platform-managed endpoint when available (host singleton). */
  usePlatform?: boolean;
  apiKey?: string;
  baseUrl?: string;
  extra?: Record<string, string>;
};

export type EngineRuntimeConfig = {
  enabled: boolean;
  /** Multi-key / multi-endpoint slots (round-robin). */
  slots?: CredSlot[];
  /** Legacy single-config fields (migrated into a slot at runtime). */
  apiKey?: string;
  baseUrl?: string;
  extra?: Record<string, string>;
};

export type WebSearchConfig = {
  defaultEngine?: SearchEngineId;
  engines: Partial<Record<SearchEngineId, EngineRuntimeConfig>>;
};

/** API-safe view of a slot (secrets redacted). */
export type CredSlotPublic = {
  id: string;
  label?: string;
  usePlatform?: boolean;
  hasApiKey: boolean;
  baseUrl?: string;
  extra?: Record<string, string>;
};

export type EngineRuntimeConfigPublic = {
  enabled: boolean;
  slots: CredSlotPublic[];
};

export type WebSearchConfigPublic = {
  defaultEngine?: SearchEngineId;
  engines: Partial<Record<SearchEngineId, EngineRuntimeConfigPublic>>;
};
