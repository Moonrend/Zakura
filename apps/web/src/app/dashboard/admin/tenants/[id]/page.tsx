"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Ban, CircleCheck, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import {
  ROLE_LABEL,
  suspendTenant,
  unsuspendTenant,
  type AdminTenantDetail,
} from "@/lib/admin";
import { formatAbsolute, formatRelative } from "@/lib/format";
import { SettingsHeader, SettingsSection, TableActions } from "@/components/settings-shell";
import { SuspendDialog } from "@/components/admin/suspend-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageLoading } from "@/components/ui/progress-linear";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const ROLES = ["owner", "admin", "member"] as const;

/** SaaS-only — stripped from OSS builds. */
export default function AdminTenantDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const tenantId = params.id;
  const { confirm } = useConfirmDialog();

  const [data, setData] = useState<AdminTenantDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const load = useCallback(async () => {
    try {
      setData(
        await api<AdminTenantDetail>(`/api/admin/tenants/${tenantId}`, { cacheTtlMs: false }),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      router.replace("/dashboard/admin/tenants");
    } finally {
      setLoading(false);
    }
  }, [tenantId, router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function changeRole(membershipId: string, role: string) {
    setBusy(true);
    try {
      await api(`/api/admin/tenants/${tenantId}/members/${membershipId}`, {
        method: "PATCH",
        json: { role },
      });
      await load();
      toast.success("已更新成员角色");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(membershipId: string, email: string) {
    const ok = await confirm({
      title: `将 ${email} 移出团队？`,
      description: "该用户会立即失去对这个团队的访问权限，账号本身保留。",
      confirmLabel: "移出",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api(`/api/admin/tenants/${tenantId}/members/${membershipId}`, {
        method: "DELETE",
      });
      await load();
      toast.success("已移出团队");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading || !data) {
    return (
      <PageLoading />
    );
  }

  const { tenant } = data;

  return (
    <div className="space-y-4">
      <Button
        size="sm"
        variant="ghost"
        className="-ml-2"
        nativeButton={false}
        render={<Link href="/dashboard/admin/tenants" />}
      >
        <ArrowLeft />
        返回团队列表
      </Button>

      <SettingsHeader
        title={tenant.name}
        description={tenant.slug}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setRenameValue(tenant.name);
                setRenameOpen(true);
              }}
            >
              <Pencil />
              重命名
            </Button>
            {tenant.suspended ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await unsuspendTenant(tenantId);
                    await load();
                    toast.success("已解除封禁");
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : String(err));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <CircleCheck />
                解除封禁
              </Button>
            ) : (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy || tenant.isDefault}
                onClick={() => setSuspendOpen(true)}
              >
                <Ban />
                封禁团队
              </Button>
            )}
          </div>
        }
      />

      {tenant.suspended ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-xs">
          <div className="font-medium text-destructive">
            该团队已于 {formatAbsolute(tenant.suspendedAt)} 被封禁
          </div>
          <div className="mt-0.5 text-muted-foreground">
            原因：{tenant.suspendedReason || "未填写"}
            {tenant.suspendedBy ? ` · 操作人 ${tenant.suspendedBy.email}` : ""}
          </div>
        </div>
      ) : null}

      <SettingsSection title="基本信息">
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <div className="text-xs text-muted-foreground">标识</div>
            <div className="font-mono text-xs">{tenant.slug}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">引导</div>
            <div>{tenant.onboardingCompleted ? "已完成" : "未完成"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">创建时间</div>
            <div title={formatAbsolute(tenant.createdAt)}>{formatRelative(tenant.createdAt)}</div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={`成员（${data.members.length}）`}
        action={
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus />
            添加成员
          </Button>
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户</TableHead>
              <TableHead className="w-32">角色</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead>加入时间</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.members.map((m) => (
              <TableRow key={m.membershipId}>
                <TableCell>
                  <Link
                    href={`/dashboard/admin/users/${m.user.id}`}
                    className="font-medium hover:underline"
                  >
                    {m.user.name || m.user.email}
                  </Link>
                  <div className="text-[11px] text-muted-foreground">{m.user.email}</div>
                </TableCell>
                <TableCell>
                  <select
                    value={m.role}
                    disabled={busy}
                    onChange={(e) => void changeRole(m.membershipId, e.target.value)}
                    className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                </TableCell>
                <TableCell>
                  {m.user.suspended ? (
                    <Badge variant="destructive">已封禁</Badge>
                  ) : (
                    <Badge variant={m.status === "active" ? "success" : "secondary"}>
                      {m.status === "active" ? "正常" : m.status}
                    </Badge>
                  )}
                </TableCell>
                <TableCell
                  className="text-xs text-muted-foreground"
                  title={formatAbsolute(m.joinedAt)}
                >
                  {formatRelative(m.joinedAt)}
                </TableCell>
                <TableCell>
                  <TableActions>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="移出团队"
                      disabled={busy}
                      onClick={() => void removeMember(m.membershipId, m.user.email)}
                    >
                      <Trash2 />
                    </Button>
                  </TableActions>
                </TableCell>
              </TableRow>
            ))}
            {!data.members.length ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  该团队暂无成员
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </SettingsSection>

      {data.runners.length ? (
        <SettingsSection title={`Runner（${data.runners.length}）`}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>共享</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.runners.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{r.status}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.isShared ? "是" : "否"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SettingsSection>
      ) : null}

      <SuspendDialog
        open={suspendOpen}
        onOpenChange={setSuspendOpen}
        subject={tenant.name}
        scope="tenant"
        onConfirm={async (reason) => {
          try {
            await suspendTenant(tenantId, reason || undefined);
            await load();
            toast.success("已封禁");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
            throw err;
          }
        }}
      />

      <Dialog
        open={renameOpen}
        onOpenChange={(next) => {
          if (!busy) setRenameOpen(next);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名团队</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="detail-rename-tenant">团队名称</Label>
            <Input
              id="detail-rename-tenant"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setRenameOpen(false)}>
              取消
            </Button>
            <Button
              disabled={busy || !renameValue.trim()}
              onClick={async () => {
                const name = renameValue.trim();
                if (!name) return;
                setBusy(true);
                try {
                  await api(`/api/admin/tenants/${tenantId}`, {
                    method: "PATCH",
                    json: { name },
                  });
                  toast.success("已重命名");
                  setRenameOpen(false);
                  await load();
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AddMemberDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        tenantId={tenantId}
        onAdded={() => void load()}
      />
    </div>
  );
}

function AddMemberDialog({
  open,
  onOpenChange,
  tenantId,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  onAdded: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("member");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!email.trim()) {
      toast.error("请填写用户邮箱");
      return;
    }
    setBusy(true);
    try {
      await api(`/api/admin/tenants/${tenantId}/members`, {
        method: "POST",
        json: { email: email.trim(), role },
      });
      toast.success("已添加成员");
      setEmail("");
      setRole("member");
      onOpenChange(false);
      onAdded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>添加成员</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="add-member-email">用户邮箱（须已注册）</Label>
            <Input
              id="add-member-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-member-role">角色</Label>
            <select
              id="add-member-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
