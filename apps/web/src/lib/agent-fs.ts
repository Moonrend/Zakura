import { api } from "@/lib/api";

export type FsEntry = {
  name: string;
  path: string;
  size: number;
  mode: string;
  modTime: string;
  isDir: boolean;
};

export type FsListResponse = {
  path: string;
  entries: FsEntry[];
};

export type FsReadResponse = {
  path: string;
  content: string;
  size: number;
  revision: string;
};

function sessionHeader(): HeadersInit {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("zakura_session") : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function qs(path: string) {
  return `path=${encodeURIComponent(path)}`;
}

export async function fsList(agentId: string, path = "/") {
  return api<FsListResponse>(`/api/agents/${agentId}/fs/list?${qs(path)}`);
}

export async function fsStat(agentId: string, path = "/") {
  return api<FsEntry>(`/api/agents/${agentId}/fs?${qs(path)}`);
}

export async function fsRead(agentId: string, path: string) {
  return api<FsReadResponse>(`/api/agents/${agentId}/fs/read?${qs(path)}`);
}

export async function fsWrite(
  agentId: string,
  path: string,
  content: string,
  expectedRevision?: string,
) {
  return api<{ ok: true; path: string; revision: string }>(
    `/api/agents/${agentId}/fs/write`,
    {
      method: "POST",
      json: { path, content, ...(expectedRevision ? { expectedRevision } : {}) },
    },
  );
}

export async function fsMkdir(agentId: string, path: string) {
  return api<{ ok: true; path: string }>(`/api/agents/${agentId}/fs/mkdir`, {
    method: "POST",
    json: { path },
  });
}

export async function fsDelete(agentId: string, path: string, recursive = true) {
  return api<{ ok: true; path: string }>(`/api/agents/${agentId}/fs/delete`, {
    method: "POST",
    json: { path, recursive },
  });
}

export async function fsRename(agentId: string, oldPath: string, newPath: string) {
  return api<{ ok: true; path: string }>(`/api/agents/${agentId}/fs/rename`, {
    method: "POST",
    json: { oldPath, newPath },
  });
}

export async function fsExtract(agentId: string, path: string, destination?: string) {
  return api<{ ok: true; destination: string }>(`/api/agents/${agentId}/fs/extract`, {
    method: "POST",
    json: { path, destination },
  });
}

export async function fsUpload(agentId: string, path: string, file: File) {
  const form = new FormData();
  form.set("path", path);
  form.set("file", file);
  const res = await fetch(`/api/agents/${agentId}/fs/upload`, {
    method: "POST",
    headers: sessionHeader(),
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
  return data as { path: string; size: number };
}

/**
 * 带进度、可中止的上传。
 *
 * fetch 至今拿不到上传进度（ReadableStream 上传各家浏览器支持不齐），
 * 几十兆的文件在进度条上只能干等，所以这条路径走 XHR。
 */
export function fsUploadWithProgress(
  agentId: string,
  path: string,
  file: File,
  opts: { onProgress?: (ratio: number) => void; signal?: AbortSignal } = {},
): Promise<{ path: string; size: number }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const form = new FormData();
    form.set("path", path);
    form.set("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/agents/${agentId}/fs/upload`);
    for (const [key, value] of Object.entries(sessionHeader())) {
      xhr.setRequestHeader(key, value);
    }

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && e.total > 0) opts.onProgress?.(e.loaded / e.total);
    });
    xhr.addEventListener("load", () => {
      let data: unknown = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* 非 JSON 响应（网关错误页等），下面按状态码处理 */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        opts.onProgress?.(1);
        resolve(data as { path: string; size: number });
      } else {
        reject(new Error((data as { error?: string }).error || `HTTP ${xhr.status}`));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("上传失败，请检查网络")));
    xhr.addEventListener("timeout", () => reject(new Error("上传超时")));
    xhr.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));

    opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

async function downloadBlob(url: string, init?: RequestInit, fallbackName = "download") {
  const res = await fetch(url, {
    ...init,
    headers: { ...sessionHeader(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") ?? "";
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd);
  const name = match ? decodeURIComponent(match[1].replace(/"/g, "")) : fallbackName;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function fsDownload(agentId: string, path: string) {
  const name = path.split("/").filter(Boolean).pop() || "file";
  await downloadBlob(`/api/agents/${agentId}/fs/download?${qs(path)}`, undefined, name);
}

/** 读取文件内容为 Blob（预览用，不触发浏览器下载） */
export async function fsFetchBlob(agentId: string, path: string): Promise<Blob> {
  const res = await fetch(`/api/agents/${agentId}/fs/download?${qs(path)}`, {
    headers: sessionHeader(),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.blob();
}

export async function fsArchive(agentId: string, paths: string[]) {
  await downloadBlob(
    `/api/agents/${agentId}/fs/archive`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeader() },
      body: JSON.stringify({ paths }),
    },
    "workspace.tar.gz",
  );
}

export function joinFsPath(dir: string, name: string): string {
  const base = dir === "/" || dir === "." ? "" : dir.replace(/\/+$/, "");
  const cleaned = name.replace(/^\/+/, "");
  return `${base}/${cleaned}`.replace(/\/+/g, "/") || "/";
}

export function parentFsPath(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length <= 1) return "/";
  return `/${parts.slice(0, -1).join("/")}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const TEXT_EXT = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonc",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "css",
  "scss",
  "html",
  "htm",
  "xml",
  "svg",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "sh",
  "bash",
  "zsh",
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "rb",
  "sql",
  "log",
  "csv",
  "tsv",
  "dockerfile",
  "makefile",
  "gitignore",
  "gitattributes",
  "editorconfig",
  "lock",
  "conf",
  "cfg",
  "properties",
]);

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"]);

const ARCHIVE_EXT = new Set(["zip", "tar", "gz", "tgz"]);

export function fileExt(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".tar.gz")) return "tar.gz";
  const i = lower.lastIndexOf(".");
  return i >= 0 ? lower.slice(i + 1) : "";
}

export function isTextFile(name: string): boolean {
  const base = name.split("/").pop() ?? name;
  if (
    ["README", "LICENSE", "CHANGELOG", "Makefile", "Dockerfile", "Procfile"].includes(base) ||
    base.startsWith(".")
  ) {
    return true;
  }
  const ext = fileExt(base);
  return TEXT_EXT.has(ext);
}

export function isImageFile(name: string): boolean {
  return IMAGE_EXT.has(fileExt(name));
}

export function isArchiveFile(name: string): boolean {
  const ext = fileExt(name);
  return ARCHIVE_EXT.has(ext) || name.toLowerCase().endsWith(".tar.gz");
}

export type AgentProject = { name: string; path: string };

export async function listAgentProjects(agentId: string) {
  return api<{ projects: AgentProject[] }>(`/api/agents/${agentId}/projects`, {
    cacheTtlMs: false,
  });
}

export async function createAgentProject(
  agentId: string,
  body: { name: string; gitUrl?: string },
) {
  return api<{ project: AgentProject; cloneError?: string }>(
    `/api/agents/${agentId}/projects`,
    { method: "POST", json: body },
  );
}

export async function renameAgentProject(agentId: string, slug: string, name: string) {
  return api<{ project: AgentProject }>(
    `/api/agents/${agentId}/projects/${encodeURIComponent(slug)}`,
    { method: "PATCH", json: { name } },
  );
}

export async function deleteAgentProject(agentId: string, slug: string) {
  return api<{ ok: true; deleted: boolean }>(
    `/api/agents/${agentId}/projects/${encodeURIComponent(slug)}`,
    { method: "DELETE" },
  );
}

export type ProjectSkillMeta = {
  name: string;
  path: string;
  description: string;
  title: string;
};

export type ProjectConfigSnapshot = {
  slug: string;
  exists: boolean;
  instructions: {
    file: "AGENTS.md" | "CLAUDE.md" | null;
    content: string;
    claudeFallback: boolean;
  };
  skills: ProjectSkillMeta[];
  hooks: {
    file: string | null;
    events: import("@zakura/shared").AgentHooksByEvent;
    sources: Array<{ file: string; events: import("@zakura/shared").AgentHooksByEvent }>;
  };
};

export async function getProjectConfig(agentId: string, slug: string) {
  return api<{ config: ProjectConfigSnapshot }>(
    `/api/agents/${agentId}/projects/${encodeURIComponent(slug)}/config`,
    { cacheTtlMs: false },
  );
}

export async function saveProjectInstructions(
  agentId: string,
  slug: string,
  body: { content: string; file?: "AGENTS.md" | "CLAUDE.md" },
) {
  return api<{ config: ProjectConfigSnapshot; path: string }>(
    `/api/agents/${agentId}/projects/${encodeURIComponent(slug)}/instructions`,
    { method: "PUT", json: body },
  );
}

export async function saveProjectHooks(
  agentId: string,
  slug: string,
  body: { events: import("@zakura/shared").AgentHooksByEvent; file?: string | null },
) {
  return api<{ config: ProjectConfigSnapshot; path: string }>(
    `/api/agents/${agentId}/projects/${encodeURIComponent(slug)}/hooks`,
    { method: "PUT", json: body },
  );
}

export async function createProjectSkill(
  agentId: string,
  slug: string,
  body: { name: string; description: string; body?: string },
) {
  return api<{ skill: ProjectSkillMeta; config: ProjectConfigSnapshot }>(
    `/api/agents/${agentId}/projects/${encodeURIComponent(slug)}/skills`,
    { method: "POST", json: body },
  );
}

export async function readProjectSkillFile(
  agentId: string,
  slug: string,
  name: string,
  path?: string,
) {
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  return api<{ path: string; content: string }>(
    `/api/agents/${agentId}/projects/${encodeURIComponent(slug)}/skills/${encodeURIComponent(name)}/file${qs}`,
    { cacheTtlMs: false },
  );
}

export async function saveProjectSkillFile(
  agentId: string,
  slug: string,
  name: string,
  content: string,
) {
  return api<{ config: ProjectConfigSnapshot; path: string }>(
    `/api/agents/${agentId}/projects/${encodeURIComponent(slug)}/skills/${encodeURIComponent(name)}`,
    { method: "PUT", json: { content } },
  );
}

export async function deleteProjectSkill(agentId: string, slug: string, name: string) {
  return api<{ config: ProjectConfigSnapshot }>(
    `/api/agents/${agentId}/projects/${encodeURIComponent(slug)}/skills/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
}
