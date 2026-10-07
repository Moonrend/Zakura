"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatWhen } from "@/lib/device-from-ua";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Credential = { id: string; name: string | null; createdAt: string };

function errMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export function PasskeyManagerDialog({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const { confirm } = useConfirmDialog();
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCredentials = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ credentials: Credential[] }>("/api/me/mfa", { cacheTtlMs: false });
      setCredentials(res.credentials);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setName("");
      setEditingId(null);
      setEditingName("");
      setError(null);
      return;
    }
    void loadCredentials();
  }, [open, loadCredentials]);

  async function add() {
    setAddBusy(true);
    setError(null);
    try {
      const { startRegistration } = await import("@simplewebauthn/browser");
      const options = await api<Record<string, unknown>>("/api/me/mfa/webauthn/register/options", {
        method: "POST",
      });
      const json = (options as { publicKey?: Record<string, unknown> }).publicKey ?? options;
      const response = await startRegistration({ optionsJSON: json } as never);
      await api("/api/me/mfa/webauthn/register", {
        method: "POST",
        json: { response, name: name.trim() || "Passkey" },
      });
      setName("");
      await loadCredentials();
      onChanged();
      toast.success("已添加通行密钥");
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") return;
      setError(errMessage(err));
    } finally {
      setAddBusy(false);
    }
  }

  async function rename(id: string) {
    setRenameBusy(true);
    setError(null);
    try {
      await api(`/api/me/mfa/webauthn/${id}`, { method: "PATCH", json: { name: editingName.trim() } });
      setEditingId(null);
      setEditingName("");
      await loadCredentials();
      onChanged();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setRenameBusy(false);
    }
  }

  async function remove(credential: Credential) {
    const ok = await confirm({
      title: "删除这把通行密钥？",
      description: "删除后，这台设备不能再用它登录。",
      confirmLabel: "删除",
    });
    if (!ok) return;
    setError(null);
    try {
      await api(`/api/me/mfa/webauthn/${credential.id}`, { method: "DELETE" });
      await loadCredentials();
      onChanged();
      toast.success("已删除通行密钥");
    } catch (err) {
      toast.error(errMessage(err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>通行密钥</DialogTitle>
          <DialogDescription>
            本机指纹、面容或硬件密钥。登录时可直接免密登录，也能当作登录第二因素。
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : credentials.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">暂无通行密钥</p>
        ) : (
          <div className="divide-y">
            {credentials.map((credential) => (
              <div key={credential.id} className="py-2.5 first:pt-0 last:pb-0">
                {editingId === credential.id ? (
                  <div className="flex items-center gap-2">
                    <Input
                      autoFocus
                      maxLength={40}
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void rename(credential.id);
                      }}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditingId(null);
                        setEditingName("");
                      }}
                    >
                      取消
                    </Button>
                    <Button size="sm" disabled={renameBusy} onClick={() => void rename(credential.id)}>
                      {renameBusy ? <Loader2 className="animate-spin" /> : null}
                      保存
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm">{credential.name || "Passkey"}</div>
                      <div className="text-xs text-muted-foreground">{formatWhen(credential.createdAt)}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditingId(credential.id);
                          setEditingName(credential.name ?? "");
                        }}
                      >
                        重命名
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void remove(credential)}>
                        删除
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2 border-t pt-3">
          <div className="space-y-1.5">
            <Label htmlFor="passkey-new-name">添加通行密钥</Label>
            <Input
              id="passkey-new-name"
              value={name}
              placeholder="Passkey"
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">浏览器会弹出系统对话框。名称只用来在列表里区分设备。</p>
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button disabled={addBusy} onClick={() => void add()}>
            {addBusy ? <Loader2 className="animate-spin" /> : null}
            添加通行密钥
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
