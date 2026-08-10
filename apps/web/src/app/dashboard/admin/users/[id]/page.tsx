"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Ban, CircleCheck, Loader2, Pencil, RotateCcw } from "lucide-react";
import { api } from "@/lib/api";
import {
  ROLE_LABEL,
  suspendUser,
  unsuspendUser,
  type AdminUserDetail,
} from "@/lib/admin";
import { formatAbsolute, formatRelative } from "@/lib/format";
import { SettingsHeader, SettingsSection, SettingsField } from "@/components/settings-shell";
import { SuspendDialog } from "@/components/admin/suspend-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** SaaS-only — stripped from OSS builds. */
export default function AdminUserDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const userId = params.id;

  const [data, setData] = useState<AdminUserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<AdminUserDetail>(`/api/admin/users/${userId}`, { cacheTtlMs: false }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      router.replace("/dashboard/admin/users");
    } finally {
      setLoading(false);
    }
  }, [userId, router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await api(`/api/admin/users/${userId}`, { method: "PATCH", json: body });
      await load();
      toast.success("已更新");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function applyAgentDefaults() {
    setBusy(true);
    try {
      await api(`/api/admin/users/${userId}/agent-defaults/apply`, { method: "POST" });
      toast.success("已应用 Agent 默认配置");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading || !data) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { user } = data;

  return (
    <div className="space-y-4">
      <Button
        size="sm"
        variant="ghost"
        className="-ml-2"
        nativeButton={false}
        render={<Link href="/dashboard/admin/users" />}
      >
        <ArrowLeft />
        返回用户列表
      </Button>

      <SettingsHeader
        title={user.name || user.email}
        description={user.email}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditOpen(true)}>
              <Pencil />
              编辑
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || user.suspended}
              onClick={() => void applyAgentDefaults()}
            >
              <RotateCcw />
              应用 Agent 默认
            </Button>
            {user.suspended ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await unsuspendUser(userId);
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
                disabled={busy}
                onClick={() => setSuspendOpen(true)}
              >
                <Ban />
                封禁用户
              </Button>
            )}
          </div>
        }
      />

      {user.suspended ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-xs">
          <div className="font-medium text-destructive">
            该账号已于 {formatAbsolute(user.suspendedAt)} 被封禁
          </div>
          <div className="mt-0.5 text-muted-foreground">
            原因：{user.suspendedReason || "未填写"}
            {user.suspendedBy ? ` · 操作人 ${user.suspendedBy.email}` : ""}
          </div>
        </div>
      ) : null}

      <SettingsSection title="账号">
        <div className="divide-y">
          <SettingsField label="平台管理员">
            <Switch
              checked={user.isPlatformAdmin}
              disabled={busy || user.suspended}
              onCheckedChange={(v) => void patch({ isPlatformAdmin: v })}
            />
          </SettingsField>
          <SettingsField label="允许使用 Local Runner">
            <Switch
              checked={user.canUseLocalRunner}
              disabled={busy || user.isPlatformAdmin || user.suspended}
              onCheckedChange={(v) => void patch({ canUseLocalRunner: v })}
            />
          </SettingsField>
          <SettingsField label="登录方式">
            <span className="text-xs text-muted-foreground">
              {user.hasPassword ? "邮箱密码" : "仅 OAuth"}
              {data.identities.length
                ? ` · ${data.identities.map((i) => i.provider).join("、")}`
                : ""}
            </span>
          </SettingsField>
          <SettingsField label="注册时间">
            <span className="text-xs text-muted-foreground" title={formatAbsolute(user.createdAt)}>
              {formatRelative(user.createdAt)}
            </span>
          </SettingsField>
        </div>
      </SettingsSection>

      <SettingsSection title={`所属团队（${data.memberships.length}）`}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>团队</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>成员状态</TableHead>
              <TableHead>加入时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.memberships.map((m) => (
              <TableRow key={m.membershipId}>
                <TableCell>
                  <Link
                    href={`/dashboard/admin/tenants/${m.tenantId}`}
                    className="font-medium hover:underline"
                  >
                    {m.name}
                  </Link>
                  <div className="font-mono text-[11px] text-muted-foreground">{m.slug}</div>
                  {m.tenantSuspended ? (
                    <Badge variant="destructive" className="mt-1">
                      团队已封禁
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="text-xs">{ROLE_LABEL[m.role] ?? m.role}</TableCell>
                <TableCell>
                  <Badge variant={m.status === "active" ? "success" : "secondary"}>
                    {m.status === "active" ? "正常" : m.status}
                  </Badge>
                </TableCell>
                <TableCell
                  className="text-xs text-muted-foreground"
                  title={formatAbsolute(m.joinedAt)}
                >
                  {formatRelative(m.joinedAt)}
                </TableCell>
              </TableRow>
            ))}
            {!data.memberships.length ? (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  该用户尚未加入任何团队
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </SettingsSection>

      {data.runners.length ? (
        <SettingsSection title={`创建的 Runner（${data.runners.length}）`}>
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
        subject={user.email}
        scope="user"
        onConfirm={async (reason) => {
          try {
            await suspendUser(userId, reason || undefined);
            await load();
            toast.success("已封禁");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
            throw err;
          }
        }}
      />

      <EditUserDetailDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        user={user}
        onSaved={() => void load()}
      />
    </div>
  );
}

function EditUserDetailDialog({
  open,
  onOpenChange,
  user,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: AdminUserDetail["user"];
  onSaved: () => void;
}) {
  const [name, setName] = useState(user.name ?? "");
  const [email, setEmail] = useState(user.email);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [initialisedFor, setInitialisedFor] = useState<string | null>(null);

  if (open && initialisedFor !== user.id) {
    setInitialisedFor(user.id);
    setName(user.name ?? "");
    setEmail(user.email);
    setPassword("");
  }
  if (!open && initialisedFor !== null) setInitialisedFor(null);

  async function submit() {
    setBusy(true);
    try {
      const json: Record<string, unknown> = {};
      if (name !== (user.name ?? "")) json.name = name;
      if (email !== user.email) json.email = email.trim();
      if (password) json.password = password;
      if (!Object.keys(json).length) {
        onOpenChange(false);
        return;
      }
      await api(`/api/admin/users/${user.id}`, { method: "PATCH", json });
      toast.success("已保存");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>编辑用户</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="detail-edit-email">邮箱</Label>
            <Input
              id="detail-edit-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="detail-edit-name">姓名</Label>
            <Input
              id="detail-edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="detail-edit-password">重置密码（留空不改）</Label>
            <Input
              id="detail-edit-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="至少 8 位"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
