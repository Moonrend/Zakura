"use client";

import { toast } from "sonner";
import { Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RecoveryCodesView({ codes }: { codes: string[] }) {
  const text = codes.join("\n");

  async function copy() {
    await navigator.clipboard.writeText(text);
    toast.success("已复制恢复码");
  }

  function download() {
    const blob = new Blob(
      [`Zakura 登录恢复码\n每个只能用一次，用完即作废。请离线保存。\n\n${text}\n`],
      { type: "text/plain;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "zakura-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      <ul className="grid grid-cols-2 gap-1.5 rounded-lg border bg-muted/30 p-3 font-mono text-xs tabular-nums">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" type="button" onClick={() => void copy()}>
          <Copy className="size-3.5" />
          复制
        </Button>
        <Button size="sm" variant="outline" type="button" onClick={download}>
          <Download className="size-3.5" />
          下载
        </Button>
      </div>
    </div>
  );
}
