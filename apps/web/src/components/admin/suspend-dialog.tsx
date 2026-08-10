"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const PRESETS = [
  "违反使用条款",
  "滥用资源 / 异常用量",
  "垃圾内容或骚扰",
  "安全风险，待人工复核",
];

/** 封号弹窗：可选原因，原因会展示给被封用户。 */
export function SuspendDialog({
  open,
  onOpenChange,
  subject,
  scope,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 被封对象的展示名，如邮箱或团队名 */
  subject: string;
  scope: "user" | "tenant";
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setReason("");
      setBusy(false);
    }
  }, [open]);

  const label = scope === "user" ? "用户" : "团队";

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>封禁{label}</DialogTitle>
          <DialogDescription>
            {subject} 将立即失去访问权限，已登录的会话在下一次请求时被拒绝。
            {scope === "tenant" ? "该团队下所有成员都会被挡住。" : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="suspend-reason">封禁原因（可选，会展示给对方）</Label>
          <Textarea
            id="suspend-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="例如：违反使用条款"
            rows={3}
          />
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((preset) => (
              <Button
                key={preset}
                type="button"
                size="xs"
                variant="outline"
                onClick={() => setReason(preset)}
              >
                {preset}
              </Button>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(reason.trim());
                onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            确认封禁
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
