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
  extraFields?: Array<{ key: string; title: string; secret?: boolean; placeholder?: string }>;
}

export interface SearchEngine extends SearchEngineMeta {
  search(req: SearchRequest, creds: EngineCredentials): Promise<SearchHit[]>;
}

export type EngineRuntimeConfig = {
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
  extra?: Record<string, string>;
};

export type WebSearchConfig = {
  defaultEngine?: SearchEngineId;
  engines: Partial<Record<SearchEngineId, EngineRuntimeConfig>>;
};
