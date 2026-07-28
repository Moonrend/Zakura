"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Copy,
  Crown,
  Loader2,
  MailPlus,
  MoreHorizontal,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { api, setSession } from "@/lib/api";
import { useMe } from "@/components/me-context";
import { SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

type TeamInfo = {
  id: string;
  slug: string;
  name: string;
  isDefault?: boolean;
  onboardingCompleted: boolean;
  role: "owner" | "admin" | "member";
};

type Member = {
  id: string;
  role: "owner" | "admin" | "member";
  status: string;
  user: { id: string; email: string; name: string | null };
};

type Invite = {
  id: string;
  email: string;
  role: "admin" | "member";
  expiresAt: string;
};

const roleLabels = { owner: "所有者", admin: "管理员", member: "成员" } as const;

function initials(name: string | null, email: string) {
  return (name?.trim() || email).slice(0, 2).toUpperCase();
}

export default function TeamSettingsPage() {
  const me = useMe();
  const router = useRouter();
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [name, setName] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [teamCount, setTeamCount] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);

  const canManage = team?.role === "owner" || team?.role === "admin";
  const canLoadMembers = canManage && (me.multiTenant || me.edition === "saas");
  const canDelete = team?.role === "owner" && !team.isDefault && teamCount > 1;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const current = await api<TeamInfo>("/api/tenant/current");
      setTeam(current);
      setName(current.name);

      if (current.role === "owner" || current.role === "admin") {
        if (me.multiTenant || me.edition === "saas") {
          const [memberResult, inviteResult, teamsResult] = await Promise.all([
            api<{ members: Member[] }>("/api/tenant/members"),
            api<{ invites: Invite[] }>("/api/tenant/invites"),
            api<{ tenants: unknown[] }>("/api/tenants"),
          ]);
          setMembers(memberResult.members);
          setInvites(inviteResult.invites);
          setTeamCount(teamsResult.tenants.length);
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [me.edition, me.multiTenant]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveTeam() {
    if (!name.trim()) return toast.error("团队名称不能为空");
    setSaving(true);
    try {
      const updated = await api<{ name: string }>("/api/tenant/current", {
        method: "PATCH",
        json: { name: name.trim() },
      });
      setName(updated.name);
      setTeam((value) => (value ? { ...value, name: updated.name } : value));
      toast.success("团队信息已保存");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function createInvite() {
    if (!inviteEmail.trim()) return toast.error("请填写邮箱");
    setInviteBusy(true);
    try {
      const result = await api<{ acceptUrl: string }>("/api/tenant/invites", {
        method: "POST",
        json: { email: inviteEmail.trim(), role: inviteRole },
      });
      setInviteUrl(result.acceptUrl);
      setInviteEmail("");
      await load();
      toast.success("邀请已创建");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setInviteBusy(false);
    }
  }

  async function updateMemberRole(id: string, role: "member" | "admin") {
    try {
      await api(`/api/tenant/members/${id}`, { method: "PATCH", json: { role } });
      setMembers((items) => items.map((item) => (item.id === id ? { ...item, role } : item)));
      toast.success("成员角色已更新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function removeMember(id: string) {
    try {
      await api(`/api/tenant/members/${id}`, { method: "DELETE" });
      setMembers((items) => items.filter((item) => item.id !== id));
      toast.success("成员已移除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function revokeInvite(id: string) {
    try {
      await api(`/api/tenant/invites/${id}`, { method: "DELETE" });
      setInvites((items) => items.filter((item) => item.id !== id));
      toast.success("邀请已撤销");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function deleteTeam() {
    if (!team || deleteConfirm !== team.name) return;
    setDeleteBusy(true);
    try {
      const result = await api<{
        session: string;
        team: { onboardingCompleted?: boolean };
      }>("/api/tenant/current", { method: "DELETE" });
      setSession(result.session);
      window.location.href =
        result.team.onboardingCompleted === false ? "/onboarding" : "/dashboard/agents";
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setDeleteBusy(false);
    }
  }

  const memberSummary = `${members.length} 位成员${invites.length ? ` · ${invites.length} 个待接受邀请` : ""}`;

  if (loading || !team) {
    return <div className="space-y-4"><Skeleton className="h-8 w-36" /><Skeleton className="h-52 w-full" /><Skeleton className="h-52 w-full" /></div>;
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="团队设置"
        description="管理当前团队的资料、成员与团队生命周期。"
        actions={me.multiTenant ? (
          <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/dashboard/settings/teams" />}>
            <Users className="size-3.5" />所有团队
          </Button>
        ) : null}
      />

      <SettingsSection title="团队资料" description="团队名称会显示在导航、邀请和授权页面中。">
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(220px,.7fr)]">
          <div className="space-y-1.5">
            <Label htmlFor="team-name">团队名称</Label>
            <Input id="team-name" value={name} disabled={!canManage} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="team-slug">团队标识</Label>
            <Input id="team-slug" value={team.slug} disabled className="font-mono text-xs" />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">{roleLabels[team.role]}</Badge>
            {!team.onboardingCompleted ? <Link href="/onboarding" className="underline underline-offset-2">继续团队引导</Link> : <span>团队已完成设置</span>}
          </div>
          {canManage ? (
            <Button size="sm" disabled={saving || !name.trim() || name.trim() === team.name} onClick={() => void saveTeam()}>
              {saving ? <Loader2 className="animate-spin" /> : null}保存更改
            </Button>
          ) : null}
        </div>
      </SettingsSection>

      {canLoadMembers ? (
        <SettingsSection
          title="成员"
          description={memberSummary}
          action={<Button size="sm" onClick={() => { setInviteUrl(null); setInviteOpen(true); }}><MailPlus className="size-3.5" />邀请成员</Button>}
        >
          <div className="divide-y">
            {members.map((member) => (
              <div key={member.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <Avatar><AvatarFallback>{initials(member.user.name, member.user.email)}</AvatarFallback></Avatar>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{member.user.name || member.user.email}</div>
                  <div className="truncate text-xs text-muted-foreground">{member.user.email}</div>
                </div>
                <div className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                  {member.role === "owner" ? <Crown className="size-3.5" /> : member.role === "admin" ? <ShieldCheck className="size-3.5" /> : <UserRound className="size-3.5" />}
                  {roleLabels[member.role]}
                </div>
                {member.role !== "owner" ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="成员操作" />}><MoreHorizontal /></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => void updateMemberRole(member.id, member.role === "admin" ? "member" : "admin")}>
                        {member.role === "admin" ? "设为普通成员" : "设为管理员"}
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onClick={() => void removeMember(member.id)}>移出团队</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : <div className="w-8" />}
              </div>
            ))}
          </div>

          {invites.length ? (
            <div className="border-t pt-3">
              <div className="mb-2 text-xs font-medium text-muted-foreground">待接受邀请</div>
              <div className="space-y-1">
                {invites.map((invite) => (
                  <div key={invite.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/50">
                    <MailPlus className="size-4 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm">{invite.email}</span>
                    <Badge variant="outline">{roleLabels[invite.role]}</Badge>
                    <Button size="sm" variant="ghost" onClick={() => void revokeInvite(invite.id)}>撤销</Button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </SettingsSection>
      ) : (
        <SettingsSection
          title="成员"
          description={canManage ? "团队成员与邀请管理在 SaaS 多团队模式下可用。" : "只有团队管理员可以查看和管理成员。"}
        >
          <p className="text-sm text-muted-foreground">
            {canManage ? "当前部署由本地管理员账号管理，无需单独邀请团队成员。" : `你当前是${roleLabels[team.role]}，如需调整成员请联系团队管理员。`}
          </p>
        </SettingsSection>
      )}

      <SettingsSection title="危险操作" description="删除后，团队内的 Agent、配置和数据将永久删除。" className="border-destructive/35">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium">删除这个团队</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {team.isDefault ? "默认团队不能删除。" : teamCount <= 1 ? "你必须至少保留一个团队。" : team.role !== "owner" ? "只有团队所有者可以删除团队。" : "此操作无法撤销，删除后将自动切换到其他团队。"}
            </p>
          </div>
          <Button size="sm" variant="destructive" disabled={!canDelete} onClick={() => { setDeleteConfirm(""); setDeleteOpen(true); }}>
            <Trash2 className="size-3.5" />删除团队
          </Button>
        </div>
      </SettingsSection>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>邀请成员加入 {team.name}</DialogTitle></DialogHeader>
          {inviteUrl ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">复制邀请链接并发送给成员。链接仅在这里显示一次。</p>
              <code className="block break-all rounded-lg border bg-muted/40 p-3 font-mono text-xs">{inviteUrl}</code>
              <Button variant="outline" onClick={async () => { await navigator.clipboard.writeText(inviteUrl); toast.success("邀请链接已复制"); }}><Copy className="size-3.5" />复制链接</Button>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
              <div className="space-y-1.5"><Label htmlFor="invite-email">邮箱</Label><Input id="invite-email" type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="name@example.com" /></div>
              <div className="space-y-1.5"><Label>角色</Label><Select value={inviteRole} onValueChange={(value) => setInviteRole(value as "member" | "admin")} items={[{ value: "member", label: "成员" }, { value: "admin", label: "管理员" }]}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="member">成员</SelectItem><SelectItem value="admin">管理员</SelectItem></SelectContent></Select></div>
            </div>
          )}
          <DialogFooter>{inviteUrl ? <Button onClick={() => setInviteOpen(false)}>完成</Button> : <Button disabled={inviteBusy} onClick={() => void createInvite()}>{inviteBusy ? <Loader2 className="animate-spin" /> : null}创建邀请</Button>}</DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>永久删除“{team.name}”？</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">团队内的 Agent、模型、MCP、成员关系和所有配置都会永久删除。请输入团队名称确认。</p>
            <div className="space-y-1.5"><Label htmlFor="delete-team-confirm">团队名称</Label><Input id="delete-team-confirm" value={deleteConfirm} onChange={(event) => setDeleteConfirm(event.target.value)} autoComplete="off" /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setDeleteOpen(false)}>取消</Button><Button variant="destructive" disabled={deleteBusy || deleteConfirm !== team.name} onClick={() => void deleteTeam()}>{deleteBusy ? <Loader2 className="animate-spin" /> : <Trash2 />}永久删除团队</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
