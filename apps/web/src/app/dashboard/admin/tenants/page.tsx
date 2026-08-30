"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Ban,
  Building2,
  CircleCheck,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { suspendTenant, unsuspendTenant, type AdminTenantRow } from "@/lib/admin";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const COL_COUNT = 6;

/** SaaS-only — stripped from OSS builds. */
export default function AdminTenantsPage() {
  const { confirm } = useConfirmDialog();
  const [status, setStatus] = useState("all");
  const [onboarding, setOnboarding] = useState("all");
  const filters = useMemo(() => ({ status, onboarding }), [status, onboarding]);

  const list = usePagedList<AdminTenantRow>({
    path: "/api/admin/tenants",
    defaultSort: "createdAt",
    filters,
  });

  const [busyId, setBusyId] = useState<string | null>(null);
  const [suspendTarget, setSuspendTarget] = useState<AdminTenantRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<AdminTenantRow | null>(null);

  async function handleUnsuspend(tenant: AdminTenantRow) {
    setBusyId(tenant.id);
    try {
      await unsuspendTenant(tenant.id);
      list.patchItem((t) => t.id === tenant.id, {
        suspended: false,
        suspendedAt: null,
        suspendedReason: null,
      });
      toast.success(`已解封 ${tenant.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(tenant: AdminTenantRow) {
    const ok = await confirm({
      title: `删除团队 ${tenant.name}？`,
      description: `该团队下 ${tenant.memberCount} 名成员的所有 Agent、工作区与数据都会被永久删除，且不可撤销。若只是想临时停用，请改用「封禁」。`,
      confirmLabel: "永久删除",
    });
    if (!ok) return;
    setBusyId(tenant.id);
    try {
      await api(`/api/admin/tenants/${tenant.id}`, { method: "DELETE" });
      toast.success("团队已删除");
      list.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <SettingsHeader
        title="团队"
        description="平台全部团队"
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus />
            新建团队
          </Button>
        }
      />

      <ListToolbar>
        <SearchField
          value={list.query}
          onValueChange={list.setQuery}
          placeholder="搜索名称或标识…"
          className="w-full sm:w-64"
          aria-label="搜索团队"
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          状态
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
          >
            <option value="all">全部</option>
            <option value="active">正常</option>
            <option value="suspended">已封禁</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          引导
          <select
            value={onboarding}
            onChange={(e) => setOnboarding(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
          >
            <option value="all">全部</option>
            <option value="completed">已完成</option>
            <option value="pending">未完成</option>
          </select>
        </label>
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
              columnKey="name"
              state={list.sortState}
              onSortChange={list.setSortState}
            >
              团队
            </SortableTableHead>
            <TableHead>状态</TableHead>
            <TableHead className="w-20">成员</TableHead>
            <TableHead className="w-24">引导</TableHead>
            <SortableTableHead
              columnKey="createdAt"
              state={list.sortState}
              onSortChange={list.setSortState}
            >
              创建时间
            </SortableTableHead>
            <TableHead className="w-12" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.loading || !list.items.length ? (
            <TableEmpty
              colSpan={COL_COUNT}
              loading={list.loading}
              message={list.query ? `没有匹配「${list.query}」的团队` : "暂无团队"}
            />
          ) : (
            list.items.map((t) => (
              <TableRow key={t.id} className={t.suspended ? "bg-destructive/5" : undefined}>
                <TableCell>
                  <Link
                    href={`/dashboard/admin/tenants/${t.id}`}
                    className="font-medium hover:underline"
                  >
                    {t.name}
                  </Link>
                  <div className="font-mono text-[11px] text-muted-foreground">{t.slug}</div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    {t.suspended ? (
                      <Badge variant="destructive" title={t.suspendedReason ?? undefined}>
                        已封禁
                      </Badge>
                    ) : (
                      <Badge variant="success">正常</Badge>
                    )}
                    {t.isDefault ? <Badge variant="secondary">默认</Badge> : null}
                  </div>
                </TableCell>
                <TableCell className="tabular-nums">{t.memberCount}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {t.onboardingCompleted ? "完成" : "未完成"}
                </TableCell>
                <TableCell
                  className="text-xs text-muted-foreground"
                  title={formatAbsolute(t.createdAt)}
                >
                  {formatRelative(t.createdAt)}
                </TableCell>
                <TableCell>
                  <TableActions>
                    {busyId === t.id ? (
                      <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                    ) : (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button size="icon-sm" variant="ghost" aria-label="团队操作" />
                          }
                        >
                          <MoreHorizontal />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40">
                          <DropdownMenuItem
                            render={<Link href={`/dashboard/admin/tenants/${t.id}`} />}
                          >
                            <Building2 />
                            查看详情
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setRenameTarget(t)}>
                            <Pencil />
                            重命名
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {t.suspended ? (
                            <DropdownMenuItem onClick={() => void handleUnsuspend(t)}>
                              <CircleCheck />
                              解除封禁
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={t.isDefault}
                              onClick={() => setSuspendTarget(t)}
                            >
                              <Ban />
                              封禁团队
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={t.isDefault}
                            onClick={() => void handleDelete(t)}
                          >
                            <Trash2 />
                            删除团队
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableActions>
                </TableCell>
              </TableRow>
            ))
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
        subject={suspendTarget?.name ?? ""}
        scope="tenant"
        onConfirm={async (reason) => {
          if (!suspendTarget) return;
          try {
            const res = await suspendTenant(suspendTarget.id, reason || undefined);
            list.patchItem((t) => t.id === suspendTarget.id, {
              suspended: true,
              suspendedAt: res.tenant.suspendedAt,
              suspendedReason: res.tenant.suspendedReason,
            });
            toast.success(`已封禁 ${suspendTarget.name}`);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
            throw err;
          }
        }}
      />

      <CreateTenantDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => list.reload()}
      />

      <RenameTenantDialog
        tenant={renameTarget}
        onOpenChange={(open) => !open && setRenameTarget(null)}
        onSaved={(name) => {
          if (renameTarget) list.patchItem((t) => t.id === renameTarget.id, { name });
          setRenameTarget(null);
        }}
      />
    </div>
  );
}

function CreateTenantDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim()) {
      toast.error("请填写团队名称");
      return;
    }
    setBusy(true);
    try {
      await api("/api/admin/tenants", {
        method: "POST",
        json: {
          name: name.trim(),
          slug: slug.trim() || undefined,
          ownerEmail: ownerEmail.trim() || undefined,
        },
      });
      toast.success("团队已创建");
      setName("");
      setSlug("");
      setOwnerEmail("");
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
          <DialogTitle>新建团队</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="new-tenant-name">团队名称</Label>
            <Input
              id="new-tenant-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-tenant-slug">标识（可选）</Label>
            <Input
              id="new-tenant-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="留空则从名称自动生成"
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-tenant-owner">所有者邮箱（可选）</Label>
            <Input
              id="new-tenant-owner"
              type="email"
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
              placeholder="留空则由你本人担任"
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

function RenameTenantDialog({
  tenant,
  onOpenChange,
  onSaved,
}: {
  tenant: AdminTenantRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [initialisedFor, setInitialisedFor] = useState<string | null>(null);

  if (tenant && initialisedFor !== tenant.id) {
    setInitialisedFor(tenant.id);
    setName(tenant.name);
  }
  if (!tenant && initialisedFor !== null) setInitialisedFor(null);

  async function submit() {
    if (!tenant || !name.trim()) return;
    setBusy(true);
    try {
      await api(`/api/admin/tenants/${tenant.id}`, {
        method: "PATCH",
        json: { name: name.trim() },
      });
      toast.success("已重命名");
      onSaved(name.trim());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!tenant} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>重命名团队</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="rename-tenant">团队名称</Label>
          <Input
            id="rename-tenant"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
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
