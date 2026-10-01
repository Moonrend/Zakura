"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus, Server } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { PageLoading } from "@/components/ui/progress-linear";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { FluidList } from "@/components/ui/fluid-hover";
import { api } from "@/lib/api";
import {
  createSpace,
  fetchSpaces,
  type SpaceItem,
} from "@/lib/spaces";
import { cn } from "@/lib/utils";

function statusTone(status: string | undefined): string {
  if (status === "ready") return "default";
  if (status === "error" || status === "failed") return "destructive";
  return "secondary";
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
        description="每个 Space 是一台共享电脑：其中的 Agent 共享 Shell / FS / 浏览器 / 桌面"
        actions={
          <Button
            size="sm"
            onClick={() => {
              resetCreate();
              setOpen(true);
            }}
          >
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
        </Empty>
      ) : (
        <FluidList
          axis="xy"
          gapClick={false}
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          highlightClassName="rounded-xl"
        >
          {list.map((space) => (
            <Link
              key={space.id}
              href={`/dashboard/spaces/${space.id}`}
              className="block rounded-xl border bg-card p-4 transition-colors hover:bg-accent/40"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium truncate">{space.name}</span>
                <div className="flex items-center gap-1.5 shrink-0">
                  {space.isDefault ? <Badge variant="outline">默认</Badge> : null}
                  <Badge variant={statusTone(space.workspaceStatus) as never}>
                    {space.workspaceStatus}
                  </Badge>
                </div>
              </div>
              {space.description ? (
                <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
                  {space.description}
                </p>
              ) : null}
              <div
                className={cn(
                  "mt-3 flex items-center gap-1.5 text-xs text-muted-foreground",
                )}
              >
                <Server className="size-3.5" />
                <span>
                  <span className="font-mono">{space.slug}</span> · {space.agentCount} 个 Agent ·{" "}
                  {space.workspaceKind}
                </span>
              </div>
            </Link>
          ))}
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
