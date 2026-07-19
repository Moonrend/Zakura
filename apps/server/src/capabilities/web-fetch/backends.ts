import type { FetchBackendId } from "@zakura/shared";
import type {
  BackendCredentials,
  FetchBackend,
  FetchResult,
} from "./types.js";

function assertHttpUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed");
  }
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host === "metadata.google.internal"
  ) {
    throw new Error("Blocked private/local URL (SSRF protection)");
  }
  return u.toString();
}

function stripHtml(html: string): { title?: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch?.[1]?.trim();
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|br|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (text.length > 100_000) text = text.slice(0, 100_000) + "\n…";
  return { title, text };
}

export const fetchBackends: FetchBackend[] = [
  {
    id: "native",
    name: "Native",
    description: "直接 HTTP 抓取并粗提取正文（无额外依赖）",
    requiresApiKey: false,
    async fetch(req) {
      const url = assertHttpUrl(req.url);
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Zakura-web-fetch/0.1 (+https://github.com/Zakura)",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(req.timeoutMs ?? 25000),
      });
      if (!res.ok) throw new Error(`Native fetch HTTP ${res.status}`);
      const contentType = res.headers.get("content-type") ?? undefined;
      const raw = await res.text();
      if (contentType?.includes("text/plain") || contentType?.includes("markdown")) {
        return {
          url,
          content: raw.slice(0, 100_000),
          contentType,
          backend: "native",
        } satisfies FetchResult;
      }
      const { title, text } = stripHtml(raw);
      return { url, title, content: text, contentType, backend: "native" };
    },
  },
  {
    id: "jina-reader",
    name: "Jina Reader",
    description: "r.jina.ai 将网页转为 Markdown",
    requiresApiKey: false,
    async fetch(req, creds) {
      const target = assertHttpUrl(req.url);
      const endpoint = `https://r.jina.ai/${target}`;
      const headers: Record<string, string> = {
        Accept: "text/markdown",
        "X-Return-Format": "markdown",
      };
      if (creds.apiKey) headers.Authorization = `Bearer ${creds.apiKey}`;
      const res = await fetch(endpoint, {
        headers,
        signal: AbortSignal.timeout(req.timeoutMs ?? 45000),
      });
      if (!res.ok) throw new Error(`Jina Reader HTTP ${res.status}`);
      const content = await res.text();
      const titleMatch = content.match(/^Title:\s*(.+)$/m);
      return {
        url: target,
        title: titleMatch?.[1]?.trim(),
        content: content.slice(0, 120_000),
        contentType: "text/markdown",
        backend: "jina-reader",
      };
    },
  },
  {
    id: "cloudflare-markdown",
    name: "Cloudflare Markdown",
    description: "markdown.new / Cloudflare Browser Rendering Markdown",
    requiresApiKey: false,
    requiresBaseUrl: false,
    async fetch(req, creds: BackendCredentials) {
      const target = assertHttpUrl(req.url);
      // Prefer custom Browser Rendering endpoint when provided
      if (creds.baseUrl?.includes("api.cloudflare.com")) {
        const apiKey = creds.apiKey?.trim();
        if (!apiKey) throw new Error("Cloudflare Browser Rendering 需要 API Token");
        const res = await fetch(creds.baseUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url: target }),
          signal: AbortSignal.timeout(req.timeoutMs ?? 60000),
        });
        if (!res.ok) throw new Error(`Cloudflare Markdown HTTP ${res.status}`);
        const data = (await res.json()) as { result?: string; markdown?: string };
        const content = data.result ?? data.markdown ?? JSON.stringify(data);
        return {
          url: target,
          content: String(content).slice(0, 120_000),
          contentType: "text/markdown",
          backend: "cloudflare-markdown",
        };
      }

      const base = (creds.baseUrl ?? "https://markdown.new").replace(/\/$/, "");
      const endpoint = `${base}/${target}`;
      const headers: Record<string, string> = { Accept: "text/markdown, text/plain" };
      if (creds.apiKey) headers.Authorization = `Bearer ${creds.apiKey}`;
      const res = await fetch(endpoint, {
        headers,
        signal: AbortSignal.timeout(req.timeoutMs ?? 45000),
      });
      if (!res.ok) throw new Error(`Cloudflare Markdown HTTP ${res.status}`);
      const content = await res.text();
      return {
        url: target,
        content: content.slice(0, 120_000),
        contentType: "text/markdown",
        backend: "cloudflare-markdown",
      };
    },
  },
];

const byId = new Map(fetchBackends.map((b) => [b.id, b]));

export function getFetchBackend(id: string): FetchBackend | undefined {
  return byId.get(id as FetchBackendId);
}

export function listFetchBackendMeta() {
  return fetchBackends.map(({ fetch: _f, ...meta }) => meta);
}
