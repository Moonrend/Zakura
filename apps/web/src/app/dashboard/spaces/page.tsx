"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import { SettingsHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageLoading } from "@/components/ui/progress-linear";
import { Empty, EmptyContent, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { FluidItem, FluidList } from "@/components/ui/fluid-hover";
import {
  createSpace,
  fetchSpaces,
  type SpaceItem,
} from "@/lib/spaces";
import { cn } from "@/lib/utils";

function workspaceStatusView(status: string): { label: string; error?: boolean } {
  switch (status) {
    case "running":
      return { label: "运行中" };
    case "starting":
    case "provisioning":
      return { label: "启动中" };
    case "error":
    case "failed":
      return { label: "启动失败", error: true };
    case "stopped":
    case "idle":
    case "none":
      return { label: "已停止" };
    default:
      return { label: "就绪" };
  }
}

export default function SpacesListPage() {
  const router = useRouter();
  const [list, setList] = useState<SpaceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setList(await fetchSpaces());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // 静默轮询：工作区状态可能随时变化（容器启停、迁移等）
    const timer = setInterval(() => void load(true), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  function resetCreate() {
    setName("");
    setDescription("");
  }

  function openCreate() {
    resetCreate();
    setOpen(true);
  }

  async function create() {
    if (!name.trim()) {
      toast.error("请填写名称");
      return;
    }
    setBusy(true);
    try {
      const res = await createSpace({
        name: name.trim(),
        description: description.trim() || undefined,
      });
      setOpen(false);
      resetCreate();
      router.push(`/dashboard/spaces/${res.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Spaces"
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus />
            新建空间
          </Button>
        }
      />

      {loading ? (
        <PageLoading />
      ) : list.length === 0 ? (
        <Empty>
          <EmptyTitle>还没有空间</EmptyTitle>
          <EmptyDescription>创建一个空间，把相关的 Agent 放到同一台共享电脑上</EmptyDescription>
          <EmptyContent>
            <Button size="sm" onClick={openCreate}>
              <Plus />
              新建空间
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <FluidList
          axis="xy"
          gapClick={{ maxDistance: 16 }}
          className="grid gap-2 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3"
          highlightClassName="rounded-xl"
        >
          {list.map((space) => {
            const status = workspaceStatusView(space.workspaceStatus);
            return (
              <FluidItem key={space.id}>
                <Link
                  href={`/dashboard/spaces/${space.id}`}
                  className="flex flex-col rounded-xl bg-card p-4 shadow-surface-2 focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="min-w-0 truncate text-sm font-medium tracking-tight">
                      {space.name}
                      {space.isDefault ? (
                        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                          默认
                        </span>
                      ) : null}
                    </h3>
                    <span
                      className={cn(
                        "shrink-0 text-xs",
                        status.error ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {status.label}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {space.description || space.slug}
                  </p>
                  <div className="mt-auto pt-3 text-xs text-muted-foreground/70">
                    {space.agentCount} 个 Agent
                  </div>
                </Link>
              </FluidItem>
            );
          })}
        </FluidList>
      )}

      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) resetCreate();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新建空间</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="space-name">名称</Label>
              <Input
                id="space-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如 research-team"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy) void create();
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="space-desc">描述</Label>
              <Input
                id="space-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="可选"
              />
            </div>
            <DialogFooter>
              <Button className="w-full" disabled={busy} onClick={() => void create()}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                {busy ? "创建中…" : "创建"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
