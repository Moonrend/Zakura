"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Ban,
  CircleCheck,
  Loader2,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Settings2,
  Trash2,
  UserRound,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  ROLE_LABEL,
  suspendUser,
  unsuspendUser,
  type AdminUserRow,
} from "@/lib/admin";
import { formatAbsolute, formatRelative } from "@/lib/format";
import { usePagedList } from "@/hooks/use-paged-list";
import { SettingsHeader, TableActions } from "@/components/settings-shell";
import { SuspendDialog } from "@/components/admin/suspend-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTablePagination,
  ListToolbar,
  SortableTableHead,
  TableEmpty,
} from "@/components/ui/data-table";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchField } from "@/components/ui/search-field";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const COL_COUNT = 7;

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="shrink-0">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** SaaS-only — stripped from OSS builds. */
export default function AdminUsersPage() {
  const { confirm } = useConfirmDialog();

  // 概览页的「封禁中」卡片会带 ?status=suspended 过来。
  // 用惰性初始值读一次即可，避免 useSearchParams 强制要求 Suspense 边界。
  const [status, setStatus] = useState(() => {
    if (typeof window === "undefined") return "all";
    return new URLSearchParams(window.location.search).get("status") ?? "all";
  });
  const [role, setRole] = useState("all");
  const filters = useMemo(() => ({ status, role }), [status, role]);

  const list = usePagedList<AdminUserRow>({
    path: "/api/admin/users",
    defaultSort: "createdAt",
    filters,
  });

  const [busyId, setBusyId] = useState<string | null>(null);
  const [suspendTarget, setSuspendTarget] = useState<AdminUserRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminUserRow | null>(null);

  const patchRow = list.patchItem;

  const togglePermission = useCallback(
    async (user: AdminUserRow, patch: { canUseLocalRunner?: boolean; isPlatformAdmin?: boolean }) => {
      setBusyId(user.id);
      try {
        const res = await api<{ user: AdminUserRow }>(`/api/admin/users/${user.id}`, {
          method: "PATCH",
          json: patch,
        });
        patchRow((u) => u.id === user.id, {
          isPlatformAdmin: res.user.isPlatformAdmin,
          canUseLocalRunner: res.user.canUseLocalRunner,
        });
        toast.success("已更新用户权限");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [patchRow],
  );

  async function handleUnsuspend(user: AdminUserRow) {
    setBusyId(user.id);
    try {
      await unsuspendUser(user.id);
      patchRow((u) => u.id === user.id, {
        suspended: false,
        suspendedAt: null,
        suspendedReason: null,
      });
      toast.success(`已解封 ${user.email}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(user: AdminUserRow) {
    const ok = await confirm({
      title: `删除用户 ${user.email}？`,
      description:
        "该用户及其数据将被永久删除；只有该用户一人的团队会被一并删除。此操作不可撤销。",
      confirmLabel: "删除",
    });
    if (!ok) return;
    setBusyId(user.id);
    try {
      const res = await api<{ deletedTenants: number }>(`/api/admin/users/${user.id}`, {
        method: "DELETE",
      });
      toast.success(
        res.deletedTenants
          ? `已删除用户，并清理 ${res.deletedTenants} 个空团队`
          : "已删除用户",
      );
      list.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function applyAgentDefaults(user: AdminUserRow) {
    setBusyId(user.id);
    try {
      const result = await api<{ updated: number }>(
        `/api/admin/users/${user.id}/agent-defaults/apply`,
        { method: "POST" },
      );
      toast.success(`已为该用户回溯启用 ${result.updated} 个 Agent`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <SettingsHeader
        title="用户"
        description="平台全部登录账号；封禁后已签发的会话会在下一次请求时被拒绝。"
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus />
            新建用户
          </Button>
        }
      />

      <ListToolbar>
        <SearchField
          value={list.query}
          onValueChange={list.setQuery}
          placeholder="搜索邮箱或姓名…"
          className="w-full sm:w-64"
          aria-label="搜索用户"
        />
        <FilterSelect
          label="状态"
          value={status}
          onChange={setStatus}
          options={[
            { value: "all", label: "全部" },
            { value: "active", label: "正常" },
            { value: "suspended", label: "已封禁" },
          ]}
        />
        <FilterSelect
          label="身份"
          value={role}
          onChange={setRole}
          options={[
            { value: "all", label: "全部" },
            { value: "admin", label: "平台管理员" },
            { value: "user", label: "普通用户" },
          ]}
        />
      </ListToolbar>

      {list.error ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {list.error}
        </p>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            <SortableTableHead
              columnKey="email"
              state={list.sortState}
              onSortChange={list.setSortState}
            >
              用户
            </SortableTableHead>
            <TableHead>状态</TableHead>
            <TableHead>团队</TableHead>
            <TableHead className="w-24">平台管理员</TableHead>
            <TableHead className="w-24">Local Runner</TableHead>
            <SortableTableHead
              columnKey="createdAt"
              state={list.sortState}
              onSortChange={list.setSortState}
            >
              注册时间
            </SortableTableHead>
            <TableHead className="w-12" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.loading || !list.items.length ? (
            <TableEmpty
              colSpan={COL_COUNT}
              loading={list.loading}
              message={list.query ? `没有匹配「${list.query}」的用户` : "暂无用户"}
            />
          ) : (
            list.items.map((u) => {
              const busy = busyId === u.id;
              return (
                <TableRow key={u.id} className={u.suspended ? "bg-destructive/5" : undefined}>
                  <TableCell>
                    <Link
                      href={`/dashboard/admin/users/${u.id}`}
                      className="font-medium hover:underline"
                    >
                      {u.name || u.email}
                    </Link>
                    <div className="text-[11px] text-muted-foreground">{u.email}</div>
                  </TableCell>
                  <TableCell>
                    {u.suspended ? (
                      <Badge
                        variant="destructive"
                        title={u.suspendedReason ?? undefined}
                      >
                        已封禁
                      </Badge>
                    ) : (
                      <Badge variant="success">正常</Badge>
                    )}
                    {!u.hasPassword ? (
                      <span className="ml-1 text-[11px] text-muted-foreground">OAuth</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-56 text-xs text-muted-foreground">
                    {u.tenants.length ? (
                      <span className="line-clamp-2">
                        {u.tenants
                          .map((t) => `${t.name}(${ROLE_LABEL[t.role] ?? t.role})`)
                          .join("、")}
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={u.isPlatformAdmin}
                      disabled={busy || u.suspended}
                      onCheckedChange={(v) =>
                        void togglePermission(u, { isPlatformAdmin: v })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={u.canUseLocalRunner}
                      disabled={busy || u.isPlatformAdmin || u.suspended}
                      onCheckedChange={(v) =>
                        void togglePermission(u, { canUseLocalRunner: v })
                      }
                    />
                  </TableCell>
                  <TableCell
                    className="text-xs text-muted-foreground"
                    title={formatAbsolute(u.createdAt)}
                  >
                    {formatRelative(u.createdAt)}
                  </TableCell>
                  <TableCell>
                    <TableActions>
                      {busy ? (
                        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                      ) : (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button size="icon-sm" variant="ghost" aria-label="用户操作" />
                            }
                          >
                            <MoreHorizontal />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem
                              render={
                                <Link href={`/dashboard/admin/users/${u.id}`} />
                              }
                            >
                              <UserRound />
                              查看详情
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setEditTarget(u)}>
                              <Settings2 />
                              编辑资料
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => void applyAgentDefaults(u)}>
                              <RotateCcw />
                              回溯启用网页
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {u.suspended ? (
                              <DropdownMenuItem onClick={() => void handleUnsuspend(u)}>
                                <CircleCheck />
                                解除封禁
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setSuspendTarget(u)}
                              >
                                <Ban />
                                封禁用户
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => void handleDelete(u)}
                            >
                              <Trash2 />
                              删除用户
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableActions>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      <DataTablePagination
        page={list.page}
        pageSize={list.pageSize}
        total={list.total}
        loading={list.loading}
        onPageChange={list.setPage}
        onPageSizeChange={list.setPageSize}
      />

      <SuspendDialog
        open={!!suspendTarget}
        onOpenChange={(open) => !open && setSuspendTarget(null)}
        subject={suspendTarget?.email ?? ""}
        scope="user"
        onConfirm={async (reason) => {
          if (!suspendTarget) return;
          try {
            const res = await suspendUser(suspendTarget.id, reason || undefined);
            patchRow((u) => u.id === suspendTarget.id, {
              suspended: true,
              suspendedAt: res.user.suspendedAt,
              suspendedReason: res.user.suspendedReason,
            });
            toast.success(`已封禁 ${suspendTarget.email}`);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
            throw err;
          }
        }}
      />

      <CreateUserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => list.reload()}
      />

      <EditUserDialog
        user={editTarget}
        onOpenChange={(open) => !open && setEditTarget(null)}
        onSaved={(patch) => {
          if (editTarget) patchRow((u) => u.id === editTarget.id, patch);
          setEditTarget(null);
        }}
      />
    </div>
  );
}

function CreateUserDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    email: "",
    password: "",
    name: "",
    tenantName: "",
    isPlatformAdmin: false,
  });
  const [busy, setBusy] = useState(false);

  function reset() {
    setForm({ email: "", password: "", name: "", tenantName: "", isPlatformAdmin: false });
  }

  async function submit() {
    if (!form.email.trim() || form.password.length < 8) {
      toast.error("请填写邮箱，密码至少 8 位");
      return;
    }
    setBusy(true);
    try {
      await api("/api/admin/users", {
        method: "POST",
        json: {
          email: form.email.trim(),
          password: form.password,
          name: form.name.trim() || undefined,
          tenantName: form.tenantName.trim() || undefined,
          isPlatformAdmin: form.isPlatformAdmin,
        },
      });
      toast.success("用户已创建");
      reset();
      onOpenChange(false);
      onCreated();
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
          <DialogTitle>新建用户</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="new-user-email">邮箱</Label>
            <Input
              id="new-user-email"
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-user-password">初始密码（至少 8 位）</Label>
            <Input
              id="new-user-password"
              type="password"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-user-name">姓名（可选）</Label>
            <Input
              id="new-user-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-user-tenant">初始团队名（可选）</Label>
            <Input
              id="new-user-tenant"
              value={form.tenantName}
              onChange={(e) => setForm((f) => ({ ...f, tenantName: e.target.value }))}
              placeholder="留空则用邮箱前缀自动生成"
            />
          </div>
          <div className="flex items-center justify-between gap-4 py-1">
            <Label htmlFor="new-user-admin">设为平台管理员</Label>
            <Switch
              id="new-user-admin"
              checked={form.isPlatformAdmin}
              onCheckedChange={(v) => setForm((f) => ({ ...f, isPlatformAdmin: v }))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditUserDialog({
  user,
  onOpenChange,
  onSaved,
}: {
  user: AdminUserRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (patch: Partial<AdminUserRow>) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [initialisedFor, setInitialisedFor] = useState<string | null>(null);

  // 打开时用当前行初始化一次，之后交给本地状态
  if (user && initialisedFor !== user.id) {
    setInitialisedFor(user.id);
    setName(user.name ?? "");
    setEmail(user.email);
    setPassword("");
  }
  if (!user && initialisedFor !== null) setInitialisedFor(null);

  async function submit() {
    if (!user) return;
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
      const res = await api<{ user: AdminUserRow }>(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        json,
      });
      toast.success("已保存");
      onSaved({
        name: res.user.name,
        email: res.user.email,
        hasPassword: res.user.hasPassword,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!user} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>编辑用户</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="edit-user-email">邮箱</Label>
            <Input
              id="edit-user-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-user-name">姓名</Label>
            <Input
              id="edit-user-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-user-password">重置密码（留空不改）</Label>
            <Input
              id="edit-user-password"
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
