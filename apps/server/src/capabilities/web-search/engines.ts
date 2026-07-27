import type { SearchEngineId } from "@zakura/shared";
import type {
  EngineCredentials,
  SearchEngine,
  SearchHit,
  SearchRequest,
} from "./types.js";

function lim(req: SearchRequest, fallback = 8): number {
  const n = req.limit ?? fallback;
  return Math.min(Math.max(1, n), 20);
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Invalid JSON (${res.status}): ${text.slice(0, 200)}`);
  }
}

function requireKey(creds: EngineCredentials, name: string): string {
  const key = creds.apiKey?.trim();
  if (!key) throw new Error(`${name} 需要 API Key`);
  return key;
}

function normalizeHits(
  rows: Array<{ title?: string; url?: string; link?: string; snippet?: string; content?: string; description?: string }>,
): SearchHit[] {
  return rows
    .map((r) => ({
      title: r.title ?? "(untitled)",
      url: r.url ?? r.link ?? "",
      snippet: r.snippet ?? r.content ?? r.description,
    }))
    .filter((r) => r.url);
}

export const searchEngines: SearchEngine[] = [
  {
    id: "tavily",
    name: "Tavily",
    description: "面向 Agent 的搜索 API",
    docsUrl: "https://tavily.com",
    apiKeyUrl: "https://app.tavily.com/home",
    requiresApiKey: true,
    async search(req, creds) {
      const apiKey = requireKey(creds, "Tavily");
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query: req.query,
          max_results: lim(req),
          search_depth: "basic",
          include_answer: false,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
      const data = (await readJson(res)) as {
        results?: Array<{ title?: string; url?: string; content?: string; score?: number }>;
      };
      return (data.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content,
        score: r.score,
      }));
    },
  },
  {
    id: "serper",
    name: "Serper",
    description: "Google 结果（Serper.dev）",
    docsUrl: "https://serper.dev",
    apiKeyUrl: "https://serper.dev/api-key",
    requiresApiKey: true,
    async search(req, creds) {
      const apiKey = requireKey(creds, "Serper");
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": apiKey,
        },
        body: JSON.stringify({ q: req.query, num: lim(req), gl: "cn", hl: req.language ?? "zh-cn" }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
      const data = (await readJson(res)) as {
        organic?: Array<{ title?: string; link?: string; snippet?: string }>;
      };
      return normalizeHits(data.organic ?? []);
    },
  },
  {
    id: "brave",
    name: "Brave",
    description: "Brave Search API",
    docsUrl: "https://brave.com/search/api/",
    apiKeyUrl: "https://api-dashboard.search.brave.com/",
    requiresApiKey: true,
    async search(req, creds) {
      const apiKey = requireKey(creds, "Brave");
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", req.query);
      url.searchParams.set("count", String(lim(req)));
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
      const data = (await readJson(res)) as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }>; };
      };
      return normalizeHits(data.web?.results ?? []);
    },
  },
  {
    id: "exa",
    name: "Exa",
    description: "神经搜索 / 语义检索",
    docsUrl: "https://exa.ai",
    apiKeyUrl: "https://dashboard.exa.ai/api-keys",
    requiresApiKey: true,
    async search(req, creds) {
      const apiKey = requireKey(creds, "Exa");
      const res = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          query: req.query,
          numResults: lim(req),
          type: "auto",
          contents: { text: { maxCharacters: 400 } },
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`Exa HTTP ${res.status}`);
      const data = (await readJson(res)) as {
        results?: Array<{ title?: string; url?: string; text?: string }>;
      };
      return (data.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.text,
      }));
    },
  },
  {
    id: "jina",
    name: "Jina",
    description: "Jina Search (s.jina.ai)",
    docsUrl: "https://jina.ai",
    apiKeyUrl: "https://jina.ai/api-dashboard/",
    requiresApiKey: true,
    async search(req, creds) {
      const apiKey = requireKey(creds, "Jina");
      const url = new URL("https://s.jina.ai/");
      url.searchParams.set("q", req.query);
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
          "X-Respond-With": "no-content",
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`Jina Search HTTP ${res.status}`);
      const data = (await readJson(res)) as {
        data?: Array<{ title?: string; url?: string; description?: string; content?: string }>;
      };
      return (data.data ?? []).slice(0, lim(req)).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.description ?? r.content,
      }));
    },
  },
  {
    id: "google",
    name: "Google",
    description: "Google Custom Search JSON API",
    docsUrl: "https://developers.google.com/custom-search",
    apiKeyUrl: "https://developers.google.com/custom-search/v1/introduction",
    requiresApiKey: true,
    extraFields: [{ key: "cx", title: "Search Engine ID (cx)", placeholder: "CSE cx" }],
    async search(req, creds) {
      const apiKey = requireKey(creds, "Google");
      const cx = creds.extra?.cx?.trim();
      if (!cx) throw new Error("Google 需要 Search Engine ID (cx)");
      const url = new URL("https://www.googleapis.com/customsearch/v1");
      url.searchParams.set("key", apiKey);
      url.searchParams.set("cx", cx);
      url.searchParams.set("q", req.query);
      url.searchParams.set("num", String(Math.min(lim(req), 10)));
      if (req.language) url.searchParams.set("lr", `lang_${req.language.split("-")[0]}`);
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
      const data = (await readJson(res)) as {
        items?: Array<{ title?: string; link?: string; snippet?: string }>;
      };
      return normalizeHits(data.items ?? []);
    },
  },
  {
    id: "bing",
    name: "Bing",
    description: "Bing Web Search API v7",
    docsUrl: "https://www.microsoft.com/en-us/bing/apis/bing-web-search-api",
    apiKeyUrl: "https://portal.azure.com/",
    requiresApiKey: true,
    async search(req, creds) {
      const apiKey = requireKey(creds, "Bing");
      const url = new URL("https://api.bing.microsoft.com/v7.0/search");
      url.searchParams.set("q", req.query);
      url.searchParams.set("count", String(lim(req)));
      if (req.language) url.searchParams.set("mkt", req.language);
      const res = await fetch(url, {
        headers: { "Ocp-Apim-Subscription-Key": apiKey },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
      const data = (await readJson(res)) as {
        webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string }>; };
      };
      return (data.webPages?.value ?? []).map((r) => ({
        title: r.name ?? "",
        url: r.url ?? "",
        snippet: r.snippet,
      }));
    },
  },
  {
    id: "searxng",
    name: "SearXNG",
    description: "自托管元搜索（平台托管或填写 Base URL）",
    docsUrl: "https://docs.searxng.org/",
    platformServiceKey: "searxng",
    requiresApiKey: false,
    requiresBaseUrl: true,
    async search(req, creds) {
      const base = (creds.baseUrl ?? "").replace(/\/$/, "");
      if (!base) throw new Error("SearXNG 需要 Base URL");
      const url = new URL(`${base}/search`);
      url.searchParams.set("q", req.query);
      url.searchParams.set("format", "json");
      if (req.language) url.searchParams.set("language", req.language);
      const headers: Record<string, string> = { Accept: "application/json" };
      if (creds.apiKey) headers.Authorization = `Bearer ${creds.apiKey}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
      const data = (await readJson(res)) as {
        results?: Array<{ title?: string; url?: string; content?: string }>;
      };
      return normalizeHits((data.results ?? []).slice(0, lim(req)));
    },
  },
  {
    id: "duckduckgo",
    name: "DuckDuckGo",
    description: "Instant Answer + HTML 结果（无需 Key）",
    docsUrl: "https://duckduckgo.com/",
    requiresApiKey: false,
    async search(req) {
      const url = new URL("https://api.duckduckgo.com/");
      url.searchParams.set("q", req.query);
      url.searchParams.set("format", "json");
      url.searchParams.set("no_redirect", "1");
      url.searchParams.set("no_html", "1");
      const res = await fetch(url, {
        headers: { "User-Agent": "Zakura/0.1" },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
      const data = (await readJson(res)) as {
        AbstractURL?: string;
        AbstractText?: string;
        Heading?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: unknown[] }>;
        Results?: Array<{ Text?: string; FirstURL?: string }>;
      };
      const hits: SearchHit[] = [];
      if (data.AbstractURL) {
        hits.push({
          title: data.Heading || req.query,
          url: data.AbstractURL,
          snippet: data.AbstractText,
        });
      }
      for (const r of data.Results ?? []) {
        if (r.FirstURL) hits.push({ title: r.Text ?? r.FirstURL, url: r.FirstURL });
      }
      for (const t of data.RelatedTopics ?? []) {
        if (t.FirstURL) hits.push({ title: t.Text ?? t.FirstURL, url: t.FirstURL });
      }
      if (hits.length) return hits.slice(0, lim(req));

      // Fallback: lite HTML
      const lite = new URL("https://lite.duckduckgo.com/lite/");
      const form = new URLSearchParams({ q: req.query });
      const htmlRes = await fetch(lite, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Zakura/0.1",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(20000),
      });
      const html = await htmlRes.text();
      const re = /<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*>([^<]*)<\/a>/gi;
      const out: SearchHit[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) && out.length < lim(req)) {
        const href = m[1];
        if (!href.startsWith("http")) continue;
        out.push({ title: m[2].trim() || href, url: href });
      }
      return out;
    },
  },
  {
    id: "bocha",
    name: "Bocha",
    description: "博查 AI 搜索",
    docsUrl: "https://open.bochaai.com/",
    apiKeyUrl: "https://open.bochaai.com/",
    requiresApiKey: true,
    async search(req, creds) {
      const apiKey = requireKey(creds, "Bocha");
      const res = await fetch("https://api.bochaai.com/v1/web-search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query: req.query,
          count: lim(req),
          summary: true,
          freshness: "noLimit",
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`Bocha HTTP ${res.status}`);
      const data = (await readJson(res)) as {
        data?: {
          webPages?: {
            value?: Array<{ name?: string; url?: string; snippet?: string; summary?: string }>;
          };
        };
      };
      return (data.data?.webPages?.value ?? []).map((r) => ({
        title: r.name ?? "",
        url: r.url ?? "",
        snippet: r.summary ?? r.snippet,
      }));
    },
  },
  {
    id: "sogou",
    name: "Sogou",
    description: "搜狗搜索（开放平台 / 自定义网关）",
    docsUrl: "https://open.sogou.com/",
    apiKeyUrl: "https://open.sogou.com/",
    requiresApiKey: true,
    requiresBaseUrl: true,
    extraFields: [{ key: "pid", title: "pid（可选）" }],
    async search(req, creds) {
      const base = (creds.baseUrl ?? "").replace(/\/$/, "");
      if (!base) throw new Error("Sogou 需要 Base URL（开放平台或兼容网关）");
      const apiKey = requireKey(creds, "Sogou");
      const url = new URL(`${base}/search`);
      url.searchParams.set("q", req.query);
      url.searchParams.set("num", String(lim(req)));
      if (creds.extra?.pid) url.searchParams.set("pid", creds.extra.pid);
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`Sogou HTTP ${res.status}`);
      const data = (await readJson(res)) as {
        results?: Array<{ title?: string; url?: string; snippet?: string }>;
        data?: Array<{ title?: string; url?: string; snippet?: string }>;
      };
      return normalizeHits(data.results ?? data.data ?? []);
    },
  },
  {
    id: "yandex",
    name: "Yandex",
    description: "Yandex Cloud Search API",
    docsUrl: "https://yandex.cloud/en/docs/search-api/",
    apiKeyUrl: "https://console.yandex.cloud/",
    requiresApiKey: true,
    requiresBaseUrl: true,
    extraFields: [
      { key: "folderId", title: "Folder ID" },
      { key: "searchType", title: "Search type", placeholder: "SEARCH_TYPE_RU" },
    ],
    async search(req, creds) {
      const apiKey = requireKey(creds, "Yandex");
      const folderId = creds.extra?.folderId?.trim();
      if (!folderId) throw new Error("Yandex 需要 folderId");
      const base =
        (creds.baseUrl ?? "https://searchapi.api.cloud.yandex.net/v2/web/search").replace(
          /\/$/,
          "",
        );
      const res = await fetch(base, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Api-Key ${apiKey}`,
        },
        body: JSON.stringify({
          query: {
            searchType: creds.extra?.searchType || "SEARCH_TYPE_RU",
            queryText: req.query,
            familyMode: "FAMILY_MODE_MODERATE",
            page: 0,
          },
          folderId,
          groupSpec: { groupsOnPage: lim(req) },
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`Yandex HTTP ${res.status}`);
      const data = (await readJson(res)) as {
        rawData?: string;
        docs?: Array<{ title?: string; url?: string; passages?: string[] }>;
      };
      if (data.docs?.length) {
        return data.docs.map((d) => ({
          title: d.title ?? "",
          url: d.url ?? "",
          snippet: d.passages?.join(" "),
        }));
      }
      // Some deployments return XML/base64 in rawData — surface message
      if (data.rawData) {
        return [
          {
            title: "Yandex raw result",
            url: `yandex:raw`,
            snippet: String(data.rawData).slice(0, 2000),
          },
        ];
      }
      return [];
    },
  },
];

const byId = new Map(searchEngines.map((e) => [e.id, e]));

export function getSearchEngine(id: string): SearchEngine | undefined {
  return byId.get(id as SearchEngineId);
}

export function listSearchEngineMeta() {
  return searchEngines.map(({ search: _s, ...meta }) => meta);
}
