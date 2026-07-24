"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { SettingsHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

type KeyRow = {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt?: string | null;
  createdAt: string;
};

export default function KeysPage() {
  const [rows, setRows] = useState<KeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("mcp");
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await api<KeyRow[]>("/api/api-keys"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="API Keys"
        actions={
          <Button
            size="sm"
            onClick={() => {
              setCreated(null);
              setName("mcp");
              setOpen(true);
            }}
          >
            <Plus />
            新建
          </Button>
        }
      />

      {loading ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>前缀</TableHead>
              <TableHead>最近使用</TableHead>
              <TableHead>创建</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell>
                  <code className="text-[11px]">{r.keyPrefix}…</code>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.lastUsedAt || "—"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(r.createdAt).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
            {!rows.length ? (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  暂无 Key
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{created ? "Key 已创建" : "新建 Key"}</DialogTitle>
            {created ? (
              <DialogDescription>仅显示一次</DialogDescription>
            ) : null}
          </DialogHeader>
          {created ? (
            <div className="space-y-3">
              <code className="block break-all rounded-lg bg-muted px-2.5 py-2 font-mono text-xs">
                {created}
              </code>
              <DialogFooter>
                <Button className="w-full" onClick={() => setOpen(false)}>
                  完成
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const res = await api<{ rawKey: string }>("/api/api-keys", {
                    method: "POST",
                    json: { name: name.trim() || "mcp" },
                  });
                  setCreated(res.rawKey);
                  await load();
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="key-name">名称</Label>
                <Input
                  id="key-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>
              <DialogFooter>
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? <Loader2 className="animate-spin" /> : null}
                  创建
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
