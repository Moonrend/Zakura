"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { createRuntimeNode, type RunnerInstallPackage, type RuntimeNode } from "@/lib/runners";
import { RunnerInstallPanel } from "@/components/runner-install-panel";
import { NodeStatusDot } from "@/components/node-status-dot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Created = { node: RuntimeNode; install: RunnerInstallPackage | null };

/**
 * 两步：起名 → 复制安装命令。
 *
 * 节点类型和访问方式不再让用户选：两种类型运行同一个代理，平台组网可用时
 * 直接下发带组网的安装命令（公网和 NAT 都能用），否则下发直连命令。
 * 设备上线状态来自父级推送的节点列表，弹窗内实时变成「已连接」。
 */
export function AddDeviceDialog({
  open,
  onOpenChange,
  nodes,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodes: RuntimeNode[];
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);

  useEffect(() => {
    if (!open) return;
    setCreated(null);
    setName(`服务器 ${nodes.filter((n) => n.kind !== "local").length + 1}`);
    // 只在打开时取一次默认名，列表推送不应覆盖用户正在输入的名称
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const live = created ? nodes.find((n) => n.id === created.node.id) : undefined;
  const connected = live?.status === "online";

  async function submit() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const res = await createRuntimeNode({ name: name.trim(), kind: "server" });
      setCreated({ node: res.node, install: res.installTailscale ?? res.install });
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <DialogContent className="max-w-lg sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{created ? `安装到「${created.node.name}」` : "添加设备"}</DialogTitle>
          <DialogDescription>
            {created
              ? "在设备上以管理员身份运行下面的命令。需要已安装 Docker。"
              : "给设备起个名字，下一步会生成安装命令。"}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-4">
            {created.install ? (
              <RunnerInstallPanel install={created.install} compact />
            ) : (
              <p className="text-sm text-destructive">无法生成安装命令，请到设备详情页重试。</p>
            )}
            <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground">
              {connected ? <NodeStatusDot status="online" /> : <Loader2 className="size-3.5 animate-spin" />}
              {connected ? "设备已连接" : "等待设备连接…"}
            </p>
            <DialogFooter className="gap-2 sm:justify-between">
              <Button variant="ghost" nativeButton={false} render={<Link href={`/dashboard/runners/${created.node.id}`} />}>
                查看设备
              </Button>
              <Button onClick={() => onOpenChange(false)}>{connected ? "完成" : "稍后安装"}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <div className="space-y-1.5">
              <Label htmlFor="device-name">名称</Label>
              <Input id="device-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                下一步
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
