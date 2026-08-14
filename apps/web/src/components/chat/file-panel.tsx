"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Download,
  File as FileIcon,
  FilePlus,
  FolderPlus,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { subscribePlatformEvents } from "@/lib/platform-events";
import {
  fileExt,
  formatSize,
  fsDelete,
  fsDownload,
  fsFetchBlob,
  fsList,
  fsMkdir,
  fsRead,
  fsRename,
  fsUpload,
  fsWrite,
  isImageFile,
  isTextFile,
  joinFsPath,
  parentFsPath,
  type FsEntry,
} from "@/lib/agent-fs";

const EXT_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  xml: "xml",
  svg: "xml",
  vue: "html",
  dockerfile: "dockerfile",
};

function languageOf(path: string): string {
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  if (base === "dockerfile") return "dockerfile";
  return EXT_LANGUAGE[fileExt(base)] ?? "plaintext";
}

/** 规范化为面板内统一使用的 / 开头路径 */
function normPath(p: string): string {
  const cleaned = `/${p.replace(/\\/g, "/")}`.replace(/\/+/g, "/");
  return cleaned === "/" ? "/" : cleaned.replace(/\/$/, "");
}

type OpenFile =
  | { kind: "text"; path: string; content: string; revision: string; dirty: boolean }
  | { kind: "image"; path: string; url: string }
  | { kind: "binary"; path: string; size?: number };

/**
 * Agent 工作区文件面板：懒加载文件树 + Monaco 编辑器。
 * openRequest 变化时自动打开对应文件（供聊天中的文件工具行联动）。
 */
export function FilePanel({
  agentId,
  fsEnabled,
  openRequest,
  projectPath,
  overlay = false,
  onClose,
}: {
  agentId: string;
  fsEnabled: boolean;
  /** 外部请求打开的文件：{path, nonce}；nonce 变化触发。dir=true 时展开目录。 */
  openRequest?: { path: string; nonce: number; dir?: boolean } | null;
  /** 当前会话绑定的项目 slug，面板默认展开该目录 */
  projectPath?: string | null;
  /** 移动端全屏覆盖模式 */
  overlay?: boolean;
  onClose: () => void;
}) {
  const { confirm } = useConfirmDialog();
  const { resolvedTheme } = useTheme();
  const [dirCache, setDirCache] = useState<Map<string, FsEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["/"]));
  const [file, setFile] = useState<OpenFile | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<{
    kind: "newFile" | "newFolder" | "rename";
    dir: string;
    /** rename 时的原路径 */
    path: string;
  } | null>(null);
  const [dialogValue, setDialogValue] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const handledNonce = useRef(0);

  const loadDir = useCallback(
    async (dir: string, force = false) => {
      if (!force && dirCache.has(dir)) return;
      try {
        const res = await fsList(agentId, dir);
        setDirCache((prev) => {
          const next = new Map(prev);
          next.set(
            dir,
            [...res.entries].sort((a, b) =>
              a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
            ),
          );
          return next;
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [agentId, dirCache],
  );

  // agent 切换：重置全部状态
  useEffect(() => {
    setDirCache(new Map());
    setExpanded(new Set(["/"]));
    setFile(null);
    setDialog(null);
    if (fsEnabled) void loadDir("/", true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, fsEnabled]);

  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    },
    [],
  );

  // Agent 写文件时经平台事件刷新对应目录（订阅经 ref 保持稳定，避免连接抖动）
  const dirCacheRef = useRef(dirCache);
  dirCacheRef.current = dirCache;
  const loadDirRef = useRef(loadDir);
  loadDirRef.current = loadDir;

  useEffect(() => {
    if (!projectPath || !fsEnabled) return;
    const paths = ["/", "/projects", `/projects/${projectPath}`];
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const p of paths) next.add(p);
      return next;
    });
    for (const p of paths) void loadDirRef.current(p);
  }, [projectPath, fsEnabled, agentId]);

  useEffect(() => {
    if (!fsEnabled) return;
    return subscribePlatformEvents((ev) => {
      if (ev.type !== "agent_fs_changed" || ev.agentId !== agentId) return;
      const p = normPath(ev.path);
      const dir = p.slice(0, p.lastIndexOf("/")) || "/";
      if (dirCacheRef.current.has(dir)) void loadDirRef.current(dir, true);
    });
  }, [agentId, fsEnabled]);

  const openFile = useCallback(
    async (path: string) => {
      const p = normPath(path);
      const name = p.split("/").pop() ?? p;
      setLoadingFile(true);
      try {
        if (isImageFile(name)) {
          const blob = await fsFetchBlob(agentId, p);
          if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
          const url = URL.createObjectURL(blob);
          objectUrlRef.current = url;
          setFile({ kind: "image", path: p, url });
        } else if (isTextFile(name)) {
          const res = await fsRead(agentId, p);
          setFile({
            kind: "text",
            path: p,
            content: res.content,
            revision: res.revision,
            dirty: false,
          });
        } else {
          setFile({ kind: "binary", path: p });
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingFile(false);
      }
    },
    [agentId],
  );

  // 外部打开请求（工具行点击文件路径；项目「打开目录」则展开树）
  useEffect(() => {
    if (!openRequest || !fsEnabled) return;
    if (openRequest.nonce === handledNonce.current) return;
    handledNonce.current = openRequest.nonce;
    if (openRequest.dir) {
      const p = normPath(openRequest.path);
      const parts = p.split("/").filter(Boolean);
      const paths = ["/"];
      let acc = "";
      for (const part of parts) {
        acc += `/${part}`;
        paths.push(acc);
      }
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const d of paths) next.add(d);
        return next;
      });
      for (const d of paths) void loadDirRef.current(d);
      return;
    }
    void openFile(openRequest.path);
  }, [openRequest, fsEnabled, openFile]);

  async function handleSave() {
    if (file?.kind !== "text" || saving) return;
    setSaving(true);
    try {
      const res = await fsWrite(agentId, file.path, file.content, file.revision);
      setFile({ ...file, revision: res.revision, dirty: false });
      toast.success("已保存");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/409|changed on disk/i.test(msg)) {
        toast.error("文件已被修改（可能是 Agent 写入）。请复制你的改动后重新打开。");
      } else {
        toast.error(msg);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleUpload(files: FileList | null, dir: string) {
    if (!files?.length) return;
    for (const f of Array.from(files)) {
      try {
        await fsUpload(agentId, joinFsPath(dir, f.name), f);
      } catch (err) {
        toast.error(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await loadDir(dir, true);
    toast.success(`已上传 ${files.length} 个文件`);
  }

  async function commitDialog() {
    if (!dialog) return;
    const value = dialogValue.trim();
    setDialog(null);
    if (!value) return;
    try {
      if (dialog.kind === "newFolder") {
        await fsMkdir(agentId, joinFsPath(dialog.dir, value));
        await loadDir(dialog.dir, true);
      } else if (dialog.kind === "newFile") {
        const p = joinFsPath(dialog.dir, value);
        await fsWrite(agentId, p, "");
        await loadDir(dialog.dir, true);
        await openFile(p);
      } else {
        const dir = parentFsPath(dialog.path);
        await fsRename(agentId, dialog.path, joinFsPath(dir, value));
        await loadDir(dir, true);
        if (file && normPath(file.path) === normPath(dialog.path)) setFile(null);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete(entry: FsEntry) {
    if (!(await confirm({ title: `删除 ${entry.path}？`, confirmLabel: "删除" }))) return;
    try {
      await fsDelete(agentId, entry.path, entry.isDir);
      await loadDir(parentFsPath(entry.path), true);
      if (file && normPath(file.path) === normPath(entry.path)) setFile(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDownload(entry: FsEntry) {
    try {
      await fsDownload(agentId, entry.path);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function renderTree(dir: string, depth: number): React.ReactNode {
    const entries = dirCache.get(dir);
    if (!entries) {
      return (
        <div
          className="flex items-center gap-2 py-1 text-xs text-muted-foreground"
          style={{ paddingLeft: depth * 14 + 8 }}
        >
          <Loader2 className="h-3 w-3 animate-spin" />
          加载中…
        </div>
      );
    }
    if (entries.length === 0) {
      return (
        <div
          className="py-1 text-xs text-muted-foreground/60"
          style={{ paddingLeft: depth * 14 + 8 }}
        >
          （空）
        </div>
      );
    }
    return entries.map((entry) => {
      const p = normPath(entry.path);
      const isOpen = expanded.has(p);
      return (
        <div key={p}>
          <div
            className="group flex items-center rounded-md text-[13px] hover:bg-muted/60"
            style={{ paddingLeft: depth * 14 }}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-2 text-left"
              onClick={() => {
                if (entry.isDir) {
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(p)) next.delete(p);
                    else next.add(p);
                    return next;
                  });
                  void loadDir(p);
                } else {
                  void openFile(p);
                }
              }}
            >
              {entry.isDir ? (
                <>
                  {isOpen ? (
                    <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                  )}
                  {isOpen ? (
                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                </>
              ) : isImageFile(entry.name) ? (
                <ImageIcon className="ml-[15px] h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
              ) : (
                <FileIcon className="ml-[15px] h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
              )}
              <span className="min-w-0 truncate">{entry.name}</span>
              {!entry.isDir && (
                <span className="ml-auto shrink-0 pr-1 text-[10px] tabular-nums text-muted-foreground/50">
                  {formatSize(entry.size)}
                </span>
              )}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="文件操作"
                    className="mr-1 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted group-hover:opacity-100 data-[popup-open]:opacity-100"
                  />
                }
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-32">
                {entry.isDir && (
                  <>
                    <DropdownMenuItem
                      onClick={() => {
                        setDialog({ kind: "newFile", dir: p, path: "" });
                        setDialogValue("");
                      }}
                    >
                      <FilePlus />
                      新建文件
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setDialog({ kind: "newFolder", dir: p, path: "" });
                        setDialogValue("");
                      }}
                    >
                      <FolderPlus />
                      新建文件夹
                    </DropdownMenuItem>
                  </>
                )}
                {!entry.isDir && (
                  <DropdownMenuItem onClick={() => void handleDownload(entry)}>
                    <Download />
                    下载
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => {
                    setDialog({ kind: "rename", dir: parentFsPath(p), path: p });
                    setDialogValue(entry.name);
                  }}
                >
                  <Pencil />
                  重命名
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => void handleDelete(entry)}
                >
                  <Trash2 />
                  删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {entry.isDir && isOpen && renderTree(p, depth + 1)}
        </div>
      );
    });
  }

  return (
    <aside
      className={
        overlay
          ? "animate-rise fixed inset-0 z-50 flex flex-col bg-background"
          : "animate-slide-in-right flex h-full w-[400px] shrink-0 flex-col border-l border-border/60 bg-muted/10"
      }
    >
      {/* 头部 */}
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border/50 px-2">
        {file ? (
          <>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="返回文件列表"
              onClick={() => setFile(null)}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
              {file.path}
            </span>
            {file.kind === "text" && (
              <Button
                size="sm"
                variant={file.dirty ? "default" : "ghost"}
                disabled={!file.dirty || saving}
                onClick={() => void handleSave()}
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                保存
              </Button>
            )}
          </>
        ) : (
          <>
            <span className="px-2 text-sm font-medium">文件</span>
            <div className="flex-1" />
            <input
              ref={uploadRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                void handleUpload(e.target.files, "/");
                e.target.value = "";
              }}
            />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="上传"
              disabled={!fsEnabled}
              onClick={() => uploadRef.current?.click()}
            >
              <Upload className="h-4 w-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="新建文件"
              disabled={!fsEnabled}
              onClick={() => {
                setDialog({ kind: "newFile", dir: "/", path: "" });
                setDialogValue("");
              }}
            >
              <FilePlus className="h-4 w-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="刷新"
              disabled={!fsEnabled}
              onClick={() => {
                setDirCache(new Map());
                void loadDir("/", true);
              }}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </>
        )}
        <Button size="icon-sm" variant="ghost" aria-label="关闭" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* 内容 */}
      {!fsEnabled ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          该 Agent 未开启电脑环境，暂无工作区文件。可在控制台为其启用。
        </div>
      ) : file ? (
        <div className="relative min-h-0 flex-1">
          {file.kind === "text" && (
            <Editor
              height="100%"
              path={file.path}
              language={languageOf(file.path)}
              value={file.content}
              theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
              options={{
                minimap: { enabled: false },
                fontSize: 12.5,
                wordWrap: "on",
                scrollBeyondLastLine: false,
                automaticLayout: true,
                padding: { top: 8 },
              }}
              onChange={(value) =>
                setFile((prev) =>
                  prev?.kind === "text"
                    ? { ...prev, content: value ?? "", dirty: true }
                    : prev,
                )
              }
              loading={
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  加载编辑器…
                </div>
              }
            />
          )}
          {file.kind === "image" && (
            <ScrollArea className="h-full">
              <div className="flex min-h-full items-center justify-center p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={file.url} alt={file.path} className="max-w-full rounded-md" />
              </div>
            </ScrollArea>
          )}
          {file.kind === "binary" && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
              <FileIcon className="h-8 w-8 opacity-50" />
              二进制文件，无法在线编辑
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void handleDownload({
                    name: file.path.split("/").pop() ?? file.path,
                    path: file.path,
                    size: 0,
                    mode: "",
                    modTime: "",
                    isDir: false,
                  })
                }
              >
                <Download className="h-3.5 w-3.5" />
                下载
              </Button>
            </div>
          )}
          {loadingFile && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/50">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-1.5">{renderTree("/", 0)}</div>
        </ScrollArea>
      )}

      {/* 新建/重命名内联对话 */}
      {dialog && (
        <div className="border-t border-border/50 p-2">
          <div className="mb-1 text-xs text-muted-foreground">
            {dialog.kind === "newFile"
              ? `新建文件于 ${dialog.dir}`
              : dialog.kind === "newFolder"
                ? `新建文件夹于 ${dialog.dir}`
                : `重命名 ${dialog.path}`}
          </div>
          <div className="flex gap-1.5">
            <Input
              autoFocus
              value={dialogValue}
              onChange={(e) => setDialogValue(e.target.value)}
              className="h-8 text-sm"
              placeholder="名称"
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitDialog();
                if (e.key === "Escape") setDialog(null);
              }}
            />
            <Button size="sm" onClick={() => void commitDialog()}>
              确定
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDialog(null)}>
              取消
            </Button>
          </div>
        </div>
      )}
    </aside>
  );
}
