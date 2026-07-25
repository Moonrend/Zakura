"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronRight,
  Download,
  File,
  FilePlus,
  Folder,
  FolderPlus,
  Image as ImageIcon,
  Save,
  Trash2,
  Upload,
  Archive,
  Pencil,
  ArrowUp,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  fsArchive,
  fsDelete,
  fsDownload,
  fsExtract,
  fsList,
  fsMkdir,
  fsRead,
  fsRename,
  fsUpload,
  fsWrite,
  formatSize,
  isArchiveFile,
  isImageFile,
  isTextFile,
  joinFsPath,
  parentFsPath,
  type FsEntry,
} from "@/lib/agent-fs";

type Props = {
  agentId: string;
  canWrite?: boolean;
};

type DialogMode = "mkdir" | "newFile" | "rename" | null;

export function AgentFileManager({ agentId, canWrite = true }: Props) {
  const [cwd, setCwd] = useState("/");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [revision, setRevision] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [dialogName, setDialogName] = useState("");
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  const crumbs = useMemo(() => {
    const parts = cwd === "/" ? [] : cwd.replace(/^\//, "").split("/").filter(Boolean);
    const items: Array<{ label: string; path: string }> = [{ label: "workspace", path: "/" }];
    let acc = "";
    for (const p of parts) {
      acc += `/${p}`;
      items.push({ label: p, path: acc });
    }
    return items;
  }, [cwd]);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const res = await fsList(agentId, cwd);
      setEntries(res.entries);
      if (!opts?.silent) setSelected(new Set());
    } catch (err) {
      if (!opts?.silent) toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [agentId, cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  // Agent 可能通过 shell/MCP 写入文件；切回页面或定时刷新以跟上变更
  useEffect(() => {
    const onFocus = () => {
      void load({ silent: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load({ silent: true });
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load({ silent: true });
    }, 8000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function openEntry(entry: FsEntry) {
    if (entry.isDir) {
      setCwd(entry.path);
      return;
    }
    if (dirty && openPath && !confirm("当前文件未保存，放弃更改？")) return;

    setOpenPath(entry.path);
    setDirty(false);
    setRevision(null);
    setContent("");
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }

    if (isTextFile(entry.name)) {
      try {
        const res = await fsRead(agentId, entry.path);
        setContent(res.content);
        setRevision(res.revision);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    if (isImageFile(entry.name)) {
      try {
        const token = localStorage.getItem("zakura_session");
        const res = await fetch(
          `/api/agents/${agentId}/fs/download?path=${encodeURIComponent(entry.path)}`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {} },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        setPreviewUrl(URL.createObjectURL(blob));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    }
  }

  async function save() {
    if (!openPath || !canWrite) return;
    setSaving(true);
    try {
      const res = await fsWrite(agentId, openPath, content, revision ?? undefined);
      setRevision(res.revision);
      setDirty(false);
      toast.success("已保存");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function toggleSelect(path: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function handleDelete(paths: string[]) {
    if (!canWrite || paths.length === 0) return;
    if (!confirm(`删除 ${paths.length} 项？此操作不可恢复。`)) return;
    try {
      for (const p of paths) {
        await fsDelete(agentId, p, true);
      }
      if (openPath && paths.some((p) => openPath === p || openPath.startsWith(`${p}/`))) {
        setOpenPath(null);
        setContent("");
        setDirty(false);
      }
      toast.success("已删除");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function submitDialog() {
    const name = dialogName.trim();
    if (!name || name.includes("/") || name.includes("\\")) {
      toast.error("名称无效");
      return;
    }
    try {
      if (dialog === "mkdir") {
        await fsMkdir(agentId, joinFsPath(cwd, name));
        toast.success("文件夹已创建");
      } else if (dialog === "newFile") {
        const path = joinFsPath(cwd, name);
        await fsWrite(agentId, path, "");
        toast.success("文件已创建");
        setDialog(null);
        await load();
        await openEntry({
          name,
          path,
          size: 0,
          mode: "-644",
          modTime: new Date().toISOString(),
          isDir: false,
        });
        return;
      } else if (dialog === "rename" && renameTarget) {
        const parent = parentFsPath(renameTarget);
        await fsRename(agentId, renameTarget, joinFsPath(parent, name));
        toast.success("已重命名");
        if (openPath === renameTarget) setOpenPath(joinFsPath(parent, name));
      }
      setDialog(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleUpload(files: FileList | null) {
    if (!files?.length || !canWrite) return;
    try {
      for (const file of Array.from(files)) {
        await fsUpload(agentId, joinFsPath(cwd, file.name), file);
      }
      toast.success(`已上传 ${files.length} 个文件`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (uploadRef.current) uploadRef.current.value = "";
    }
  }

  async function handleExtract(path: string) {
    if (!canWrite) return;
    try {
      const res = await fsExtract(agentId, path);
      toast.success(`已解压到 ${res.destination}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const openName = openPath?.split("/").filter(Boolean).pop() ?? null;
  const selectedList = Array.from(selected);

  return (
    <div className="grid min-h-[560px] gap-3 lg:grid-cols-[minmax(260px,340px)_1fr]">
      <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={cwd === "/"}
            title="上级"
            onClick={() => setCwd(parentFsPath(cwd))}
          >
            <ArrowUp />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="刷新"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
          </Button>
          {canWrite ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                title="新建文件"
                onClick={() => {
                  setDialog("newFile");
                  setDialogName("");
                }}
              >
                <FilePlus />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title="新建文件夹"
                onClick={() => {
                  setDialog("mkdir");
                  setDialogName("");
                }}
              >
                <FolderPlus />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title="上传"
                onClick={() => uploadRef.current?.click()}
              >
                <Upload />
              </Button>
            </>
          ) : null}
          {selectedList.length > 0 ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                title="下载"
                onClick={() =>
                  void (selectedList.length === 1 && !entries.find((e) => e.path === selectedList[0])?.isDir
                    ? fsDownload(agentId, selectedList[0])
                    : fsArchive(agentId, selectedList)
                  ).catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
                }
              >
                <Download />
              </Button>
              {canWrite ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  title="删除"
                  onClick={() => void handleDelete(selectedList)}
                >
                  <Trash2 />
                </Button>
              ) : null}
            </>
          ) : null}
          <input
            ref={uploadRef}
            type="file"
            className="hidden"
            multiple
            onChange={(e) => void handleUpload(e.target.files)}
          />
        </div>

        <div className="flex flex-wrap items-center gap-0.5 border-b px-2 py-1.5 text-xs text-muted-foreground">
          {crumbs.map((c, i) => (
            <span key={c.path} className="inline-flex items-center gap-0.5">
              {i > 0 ? <ChevronRight className="size-3 opacity-50" /> : null}
              <button
                type="button"
                className={cn(
                  "rounded px-1 hover:bg-accent hover:text-foreground",
                  c.path === cwd && "font-medium text-foreground",
                )}
                onClick={() => setCwd(c.path)}
              >
                {c.label}
              </button>
            </span>
          ))}
        </div>

        <div className="min-h-[320px] flex-1 overflow-auto p-1">
          {loading ? (
            <p className="p-3 text-xs text-muted-foreground">加载中…</p>
          ) : entries.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">空目录</p>
          ) : (
            <ul className="space-y-0.5">
              {entries.map((entry) => {
                const Icon = entry.isDir
                  ? Folder
                  : isImageFile(entry.name)
                    ? ImageIcon
                    : isArchiveFile(entry.name)
                      ? Archive
                      : File;
                const active = openPath === entry.path;
                const checked = selected.has(entry.path);
                return (
                  <li key={entry.path}>
                    <div
                      className={cn(
                        "group flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1.5 text-sm transition-colors hover:bg-accent content-auto",
                        active && "bg-accent",
                        checked && "bg-primary/5",
                      )}
                      onClick={() => void openEntry(entry)}
                      onDoubleClick={() => {
                        if (canWrite && !entry.isDir) {
                          setRenameTarget(entry.path);
                          setDialogName(entry.name);
                          setDialog("rename");
                        }
                      }}
                    >
                      <input
                        type="checkbox"
                        className="size-3.5 shrink-0 accent-[var(--primary)]"
                        checked={checked}
                        onChange={() => undefined}
                        onClick={(e) => toggleSelect(entry.path, e)}
                      />
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      {!entry.isDir ? (
                        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                          {formatSize(entry.size)}
                        </span>
                      ) : null}
                      <div className="hidden shrink-0 gap-0.5 group-hover:flex">
                        {!entry.isDir ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0"
                            title="下载"
                            onClick={(e) => {
                              e.stopPropagation();
                              void fsDownload(agentId, entry.path).catch((err) =>
                                toast.error(err instanceof Error ? err.message : String(err)),
                              );
                            }}
                          >
                            <Download className="size-3.5" />
                          </Button>
                        ) : null}
                        {canWrite && isArchiveFile(entry.name) ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0"
                            title="解压"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleExtract(entry.path);
                            }}
                          >
                            <Archive className="size-3.5" />
                          </Button>
                        ) : null}
                        {canWrite ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0"
                            title="重命名"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenameTarget(entry.path);
                              setDialogName(entry.name);
                              setDialog("rename");
                            }}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {openName ?? "未选择文件"}
          </span>
          {openPath && isTextFile(openName ?? "") && canWrite ? (
            <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
              <Save />
              保存
            </Button>
          ) : null}
          {openPath && !isTextFile(openName ?? "") && !isImageFile(openName ?? "") ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void fsDownload(agentId, openPath).catch((err) =>
                  toast.error(err instanceof Error ? err.message : String(err)),
                )
              }
            >
              <Download />
              下载
            </Button>
          ) : null}
        </div>
        <div className="min-h-[320px] flex-1 overflow-auto p-3">
          {!openPath ? (
            <div className="flex h-full min-h-[280px] items-center justify-center text-xs text-muted-foreground">
              选择文件以预览或编辑
            </div>
          ) : isTextFile(openName ?? "") ? (
            <Textarea
              className="min-h-[420px] h-full resize-none font-mono text-xs leading-relaxed"
              value={content}
              readOnly={!canWrite}
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(true);
              }}
            />
          ) : isImageFile(openName ?? "") && previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt={openName ?? ""}
              className="mx-auto max-h-[520px] max-w-full rounded-md border object-contain"
            />
          ) : (
            <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
              <p>二进制文件，请下载查看</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void fsDownload(agentId, openPath).catch((err) =>
                    toast.error(err instanceof Error ? err.message : String(err)),
                  )
                }
              >
                <Download />
                下载
              </Button>
            </div>
          )}
        </div>
        {dirty ? (
          <p className="border-t px-3 py-1.5 text-[11px] text-warning-foreground">未保存的更改</p>
        ) : null}
      </section>

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog === "mkdir"
                ? "新建文件夹"
                : dialog === "newFile"
                  ? "新建文件"
                  : "重命名"}
            </DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={dialogName}
            placeholder="名称"
            onChange={(e) => setDialogName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitDialog();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button onClick={() => void submitDialog()}>确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
