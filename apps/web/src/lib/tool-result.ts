import { foldPtyText } from "@zakura/shared";

/**
 * 工具返回值解析。
 *
 * MCP 生态里每家搜索/抓取工具的返回结构都不一样（有的 `{results:[…]}`，有的
 * `{organic:[…]}`，有的干脆是一段 Markdown）。这里不枚举厂商，而是：
 * 1) JSON 能解析时，深度遍历找出「带 http(s) 链接的对象」，就地取标题与摘要；
 * 2) 否则退回文本扫描（Markdown 链接 + 裸链接）。
 * 目标是让 UI 总能拿到一组网页来源，从而把工具调用渲染成人能读的卡片。
 */

export type WebSource = {
  url: string;
  /** 站点主机名（去掉 www.），用于分组与图标 */
  domain: string;
  title: string;
  snippet?: string;
};

const URL_KEYS = [
  "url",
  "link",
  "href",
  "uri",
  "source_url",
  "sourceUrl",
  "displayLink",
  "permalink",
  "webUrl",
];

const TITLE_KEYS = [
  "title",
  "name",
  "heading",
  "page_title",
  "pageTitle",
  "displayTitle",
  "label",
];

const SNIPPET_KEYS = [
  "snippet",
  "description",
  "summary",
  "excerpt",
  "abstract",
  "content",
  "text",
  "body",
  "raw_content",
];

/** 提取主机名；解析失败返回空串（调用方据此丢弃该条） */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** 去掉末尾斜杠与 hash，用于去重 */
function normalizeUrl(url: string): string {
  return url.replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
}

/** 裸链接常把句尾标点吞进来，这里剥掉 */
function trimUrlTail(url: string): string {
  let out = url;
  while (out.length > 0 && /[.,;:!?、。，）)\]}"'>]$/.test(out)) {
    // 括号成对时保留（如维基百科的 (disambiguation) 链接）
    const last = out[out.length - 1]!;
    if (last === ")" && (out.match(/\(/g)?.length ?? 0) > (out.match(/\)/g)?.length ?? 0)) {
      break;
    }
    out = out.slice(0, -1);
  }
  return out;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function isHttpUrl(v: unknown): v is string {
  return typeof v === "string" && /^https?:\/\/\S+$/i.test(v.trim());
}

function cleanText(s: string, max = 400): string {
  const flat = s
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 深度遍历 JSON，收集所有「含 http 链接」的对象 */
function collectFromJson(node: unknown, out: WebSource[], depth = 0): void {
  if (depth > 6 || out.length > 64) return;
  if (Array.isArray(node)) {
    for (const item of node) collectFromJson(item, out, depth + 1);
    return;
  }
  if (!node || typeof node !== "object") return;

  const obj = node as Record<string, unknown>;
  const url = firstString(obj, URL_KEYS);
  if (isHttpUrl(url)) {
    const domain = hostOf(url);
    if (domain) {
      const title = firstString(obj, TITLE_KEYS);
      const snippet = firstString(
        obj,
        SNIPPET_KEYS.filter((k) => !TITLE_KEYS.includes(k)),
      );
      out.push({
        url,
        domain,
        title: cleanText(title || domain, 160) || domain,
        snippet: snippet ? cleanText(snippet) : undefined,
      });
    }
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") collectFromJson(value, out, depth + 1);
  }
}

/** Markdown 链接 + 裸链接扫描；裸链接向前找一行当标题 */
function collectFromText(text: string, out: WebSource[]): void {
  const seenSpans = new Set<string>();

  const mdLink = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g;
  for (const m of text.matchAll(mdLink)) {
    const url = trimUrlTail(m[2]!);
    const domain = hostOf(url);
    if (!domain) continue;
    seenSpans.add(url);
    out.push({ url, domain, title: cleanText(m[1]!, 160) || domain });
  }

  const lines = text.split(/\r?\n/);
  const bare = /https?:\/\/[^\s<>"'`\])]+/g;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    for (const m of line.matchAll(bare)) {
      const url = trimUrlTail(m[0]!);
      if (seenSpans.has(url)) continue;
      const domain = hostOf(url);
      if (!domain) continue;
      // 标题优先取同一行链接前的文字，其次取上一非空行
      const before = line.slice(0, m.index ?? 0).replace(/^[\s\-*>#\d.、)]+/, "").trim();
      const prev = (lines[i - 1] ?? "").replace(/^[\s\-*>#\d.、)]+/, "").trim();
      const title = before || (prev && !prev.includes("http") ? prev : "") || domain;
      out.push({ url, domain, title: cleanText(title, 160) });
    }
  }
}

/**
 * 从工具返回值里解析网页来源列表。
 * 解析不到返回空数组 —— 调用方据此决定是否降级为普通文本展示。
 */
export function parseWebSources(raw?: string, limit = 24): WebSource[] {
  if (!raw || raw.length < 8) return [];
  const collected: WebSource[] = [];

  const trimmed = raw.trim();
  const parsed = tryParseJson(trimmed);
  if (parsed !== undefined) collectFromJson(parsed, collected);
  if (collected.length === 0) collectFromText(raw, collected);

  const seen = new Set<string>();
  const out: WebSource[] = [];
  for (const item of collected) {
    const key = normalizeUrl(item.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 宽松 JSON 解析：直接解析失败时，截取首个 `{…}` / `[…]` 再试一次。
 * 服务端会把 MCP 的多段 content 拼在一起，JSON 前后常夹着说明文字。
 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* 继续尝试截取 */
  }
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* 换下一种括号 */
    }
  }
  return undefined;
}

export type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  status?: "running" | "exited" | "timeout";
  jobId?: string;
};

/** shell_exec 返回 `{stdout, stderr, exitCode}`；解析失败返回 null */
export function parseShellResult(raw?: string): ShellResult | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const hasShape =
      "stdout" in parsed || "stderr" in parsed || "exitCode" in parsed || "exit_code" in parsed;
    if (!hasShape) return null;
    const code = parsed.exitCode ?? parsed.exit_code;
    const status =
      parsed.status === "running" || parsed.status === "exited" || parsed.status === "timeout"
        ? parsed.status
        : undefined;
    return {
      stdout: typeof parsed.stdout === "string" ? foldPtyText(parsed.stdout) : "",
      stderr: typeof parsed.stderr === "string" ? foldPtyText(parsed.stderr) : "",
      exitCode: typeof code === "number" ? code : null,
      status,
      jobId: typeof parsed.job_id === "string" ? parsed.job_id : undefined,
    };
  } catch {
    return null;
  }
}

/** 工具名是否属于「搜索」族（含各家 MCP 的命名变体） */
export function isSearchTool(name: string): boolean {
  return /search|query|retriev|lookup|discover/i.test(name) && !/memory/i.test(name);
}

/** 工具名是否属于「抓取网页」族 */
export function isFetchTool(name: string): boolean {
  return /fetch|crawl|scrape|extract|browse|visit|read_url|open_url/i.test(name);
}

/* ==========================================================================
   Markdown 正文
   Firecrawl / Jina Reader / r.jina.ai 这类抓取工具返回的是整篇 Markdown，
   按纯文本贴出来既难读又浪费空间，解析出来交给 Markdown 渲染器。
   ========================================================================== */

export type MarkdownDoc = {
  markdown: string;
  title?: string;
  url?: string;
};

/** 正文里出现标题 / 列表 / 代码块 / 链接 / 引用 / 表格，才当 Markdown 处理 */
const MARKDOWN_HINT =
  /(^|\n)\s{0,3}#{1,6}\s|(^|\n)\s{0,3}[-*+]\s+\S|(^|\n)\s{0,3}\d+\.\s+\S|```|\[[^\]\n]{1,200}\]\(https?:\/\/|(^|\n)>\s|\n\s*\|[^\n]*\|/;

export function looksLikeMarkdown(text: string, min = 120): boolean {
  return text.length >= min && MARKDOWN_HINT.test(text);
}

/** 可能装着正文的字段，按可信度排序 */
const MARKDOWN_KEYS = ["markdown", "content", "text", "raw_content", "rawContent", "body"];

function docFromObject(obj: Record<string, unknown>): MarkdownDoc | null {
  let markdown = "";
  for (const key of MARKDOWN_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length >= 40) {
      markdown = v.trim();
      break;
    }
  }
  if (!markdown) return null;

  const meta =
    obj.metadata && typeof obj.metadata === "object" && !Array.isArray(obj.metadata)
      ? (obj.metadata as Record<string, unknown>)
      : {};
  const title =
    firstString(meta, ["title", "ogTitle", "og:title"]) || firstString(obj, ["title", "name"]);
  const url =
    firstString(meta, ["sourceURL", "sourceUrl", "url", "ogUrl", "og:url"]) ||
    firstString(obj, URL_KEYS);

  return {
    markdown,
    title: title ? cleanText(title, 160) : undefined,
    url: isHttpUrl(url) ? url : undefined,
  };
}

function collectDocs(node: unknown, out: MarkdownDoc[], depth = 0): void {
  if (depth > 5 || out.length >= 8) return;
  if (Array.isArray(node)) {
    for (const item of node) collectDocs(item, out, depth + 1);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const doc = docFromObject(obj);
  if (doc) {
    out.push(doc);
    return; // 命中即止：正文里的子对象不会再有另一篇正文
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") collectDocs(value, out, depth + 1);
  }
}

/**
 * Jina Reader 的纯文本输出：
 * ```
 * Title: …
 * URL Source: https://…
 * Markdown Content:
 * # 正文
 * ```
 */
function parseJinaText(text: string): MarkdownDoc | null {
  const body = text.split(/^Markdown Content:\s*$/m)[1];
  if (body == null) return null;
  const title = /^Title:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const url = /^URL Source:\s*(\S+)$/m.exec(text)?.[1]?.trim();
  const markdown = body.trim();
  if (!markdown) return null;
  return {
    markdown,
    title: title || undefined,
    url: isHttpUrl(url ?? "") ? url : undefined,
  };
}

/**
 * 从抓取类工具的返回值里解析出正文。
 * 解析不到返回空数组，调用方降级为普通文本块。
 */
export function parseMarkdownDocs(raw?: string, limit = 3): MarkdownDoc[] {
  if (!raw) return [];
  const text = raw.trim();
  if (text.length < 60) return [];

  const jina = parseJinaText(text);
  if (jina) return [jina];

  const parsed = tryParseJson(text);
  if (parsed !== undefined) {
    const docs: MarkdownDoc[] = [];
    collectDocs(parsed, docs);
    const kept = docs.filter((d) => looksLikeMarkdown(d.markdown, 40) || d.markdown.length > 300);
    if (kept.length > 0) return kept.slice(0, limit);
    return [];
  }

  // 工具直接吐 Markdown 的情况
  return looksLikeMarkdown(text, 100) ? [{ markdown: text }] : [];
}

/* ==========================================================================
   内置 fs_* 工具的返回值
   服务端统一 JSON.stringify，这里按已知形状取出来，UI 才能画成人话。
   ========================================================================== */

function asObject(raw?: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export type FsReadResult = {
  path: string;
  content: string;
  truncated: boolean;
  totalLines: number | null;
};

/** fs_read → `{path, content, truncated, totalLines}` */
export function parseFsRead(raw?: string): FsReadResult | null {
  const obj = asObject(raw);
  if (!obj || typeof obj.content !== "string") return null;
  return {
    path: typeof obj.path === "string" ? obj.path : "",
    content: obj.content,
    truncated: obj.truncated === true,
    totalLines: typeof obj.totalLines === "number" ? obj.totalLines : null,
  };
}

export type FsEntry = { name: string; type: "file" | "dir" | "other"; size?: number };
export type FsListResult = { path: string; entries: FsEntry[]; truncated: boolean };

/** fs_list → `{path, entries:[{name,type,size}], truncated}` */
export function parseFsList(raw?: string): FsListResult | null {
  const obj = asObject(raw);
  if (!obj || !Array.isArray(obj.entries)) return null;
  const entries: FsEntry[] = [];
  for (const item of obj.entries) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.name !== "string") continue;
    entries.push({
      name: e.name,
      type: e.type === "dir" || e.type === "other" ? e.type : "file",
      size: typeof e.size === "number" ? e.size : undefined,
    });
  }
  return {
    path: typeof obj.path === "string" ? obj.path : "",
    entries,
    truncated: obj.truncated === true,
  };
}

export type FsStatResult = {
  path: string;
  type: "file" | "dir" | "other";
  size: number;
  mtime: string;
};

/** fs_stat → `{path, type, size, mtime}` */
export function parseFsStat(raw?: string): FsStatResult | null {
  const obj = asObject(raw);
  if (!obj || typeof obj.mtime !== "string" || typeof obj.size !== "number") return null;
  return {
    path: typeof obj.path === "string" ? obj.path : "",
    type: obj.type === "dir" || obj.type === "other" ? obj.type : "file",
    size: obj.size,
    mtime: obj.mtime,
  };
}

/** fs_write → 写入字节数 */
export function parseWrittenBytes(raw?: string): number | null {
  const obj = asObject(raw);
  return obj && typeof obj.bytes === "number" ? obj.bytes : null;
}

/** 结果是不是「只有 ok / path」这种没信息量的确认，是的话不必展开 */
export function isBareAck(raw?: string): boolean {
  const obj = asObject(raw);
  if (!obj) return false;
  return Object.keys(obj).every((k) => k === "ok" || k === "path" || k === "from" || k === "to");
}

/* ==========================================================================
   记忆检索结果
   内置 store 返回 `{results:[{content,layer,tags,…}]}`，mem0 返回
   `{results:[{memory,score}]}`。统一成一组可直接渲染的条目。
   ========================================================================== */

export type MemoryItem = {
  id?: string;
  content: string;
  layer?: string;
  tags: string[];
  pinned?: boolean;
  score?: number;
};

const MEMORY_CONTENT_KEYS = ["content", "memory", "text", "value"];

function toMemoryItem(node: unknown): MemoryItem | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const obj = node as Record<string, unknown>;
  const content = firstString(obj, MEMORY_CONTENT_KEYS);
  if (!content) return null;
  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === "string")
    : [];
  return {
    id: typeof obj.id === "string" ? obj.id : undefined,
    content,
    layer: typeof obj.layer === "string" ? obj.layer : undefined,
    tags,
    pinned: obj.pinned === true,
    score: typeof obj.score === "number" ? obj.score : undefined,
  };
}

/** 深度找出第一组「看起来是记忆条目」的数组 */
function findMemoryArray(node: unknown, depth = 0): MemoryItem[] {
  if (depth > 4 || !node || typeof node !== "object") return [];
  if (Array.isArray(node)) {
    const items = node.map(toMemoryItem).filter((m): m is MemoryItem => m != null);
    return items.length > 0 ? items : [];
  }
  for (const key of ["results", "items", "memories", "data", "hits"]) {
    const found = findMemoryArray((node as Record<string, unknown>)[key], depth + 1);
    if (found.length > 0) return found;
  }
  for (const value of Object.values(node as Record<string, unknown>)) {
    if (value && typeof value === "object") {
      const found = findMemoryArray(value, depth + 1);
      if (found.length > 0) return found;
    }
  }
  return [];
}

/** 从记忆工具返回值里解析条目；解析不到返回空数组 */
export function parseMemoryItems(raw?: string, limit = 12): MemoryItem[] {
  if (!raw) return [];
  const parsed = tryParseJson(raw.trim());
  if (parsed === undefined) return [];
  return findMemoryArray(parsed).slice(0, limit);
}

const EXT_LANG: Record<string, string> = {  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "scss",
  html: "html",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  dockerfile: "dockerfile",
};

/** 由扩展名猜代码语言，用于高亮 */
export function languageFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  if (/^dockerfile$/i.test(base)) return "dockerfile";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return EXT_LANG[ext] ?? "";
}
