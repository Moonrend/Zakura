"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, Loader2, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useMe } from "@/components/me-context";
import { SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

type Member = {
  id: string;
  role: string;
  status: string;
  user: { id: string; email: string; name: string | null };
};

type Invite = {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
};

export default function TenantMembersPage() {
  const router = useRouter();
  const me = useMe();
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (!me.multiTenant && me.edition !== "saas") {
        toast.error("成员管理仅在 SaaS 版可用");
        router.replace("/dashboard/settings/tenant");
        return;
      }
      const [m, i] = await Promise.all([
        api<{ members: Member[] }>("/api/tenant/members"),
        api<{ invites: Invite[] }>("/api/tenant/invites"),
      ]);
      setMembers(m.members);
      setInvites(i.invites);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      if (String(err).includes("Admin") || String(err).includes("403")) {
        router.replace("/dashboard/settings/tenant");
      }
    } finally {
      setLoading(false);
    }
  }, [me.edition, me.multiTenant, router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function invite() {
    if (!email.trim()) {
      toast.error("请填写邮箱");
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ acceptUrl: string }>("/api/tenant/invites", {
        method: "POST",
        json: { email: email.trim(), role },
      });
      setCreatedUrl(res.acceptUrl);
      setEmail("");
      await load();
      toast.success("邀请已创建");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    try {
      await api(`/api/tenant/invites/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeMember(id: string) {
    try {
      await api(`/api/tenant/members/${id}`, { method: "DELETE" });
      await load();
      toast.success("已移除成员");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="成员与邀请"
        actions={
          <Button size="sm" onClick={() => { setOpen(true); setCreatedUrl(null); }}>
            <Plus className="size-3.5" />
            邀请
          </Button>
        }
      />

      <SettingsSection title="成员">
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用户</TableHead>
                <TableHead>角色</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <div className="font-medium">{m.user.name || m.user.email}</div>
                    <div className="text-xs text-muted-foreground">{m.user.email}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{m.role}</Badge>
                  </TableCell>
                  <TableCell>
                    {m.role !== "owner" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void removeMember(m.id)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SettingsSection>

      <SettingsSection title="待接受邀请">
        {invites.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无待处理邀请</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>邮箱</TableHead>
                <TableHead>角色</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invites.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>{i.email}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{i.role}</Badge>
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" onClick={() => void revoke(i.id)}>
                      撤销
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SettingsSection>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>邀请成员</DialogTitle>
          </DialogHeader>
          {createdUrl ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">将链接发给被邀请人（仅显示一次）：</p>
              <code className="block break-all rounded-md border bg-muted/40 px-2.5 py-2 font-mono text-xs">
                {createdUrl}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await navigator.clipboard.writeText(createdUrl);
                  toast.success("已复制");
                }}
              >
                <Copy className="size-3.5" />
                复制链接
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="invite-email">邮箱</Label>
                <Input
                  id="invite-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="invite-role">角色</Label>
                <select
                  id="invite-role"
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                  value={role}
                  onChange={(e) => setRole(e.target.value as "member" | "admin")}
                >
                  <option value="member">成员</option>
                  <option value="admin">管理员</option>
                </select>
              </div>
            </div>
          )}
          <DialogFooter>
            {createdUrl ? (
              <Button onClick={() => setOpen(false)}>完成</Button>
            ) : (
              <Button disabled={busy} onClick={() => void invite()}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                创建邀请
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
