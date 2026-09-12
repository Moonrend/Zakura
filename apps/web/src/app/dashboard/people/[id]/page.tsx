"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Copy } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { formatWhen } from "@/lib/device-from-ua";
import { useMe } from "@/components/me-context";
import { ROLE_LABELS, personName, type Person } from "@/lib/people";
import { UserAvatar } from "@/components/user-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageLoading } from "@/components/ui/progress-linear";

export default function PersonPage() {
  const params = useParams<{ id: string }>();
  const me = useMe();
  const [person, setPerson] = useState<Person | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void api<{ person: Person }>(`/api/tenant/people/${encodeURIComponent(params.id)}`)
      .then((res) => {
        if (alive) setPerson(res.person);
      })
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) setPerson(null);
        else {
          toast.error(err instanceof Error ? err.message : String(err));
          setPerson(null);
        }
      });
    return () => {
      alive = false;
    };
  }, [params.id]);

  if (person === undefined) return <PageLoading />;

  if (!person) {
    return (
      <div className="space-y-4">
        <Button size="sm" variant="ghost" className="-ml-2" nativeButton={false} render={<Link href="/dashboard/people" />}>
          <ArrowLeft />
          返回成员
        </Button>
        <p className="text-sm text-muted-foreground">找不到这个人，可能已经离开团队。</p>
      </div>
    );
  }

  const mine = person.id === me.user?.id;
  const role = ROLE_LABELS[person.role as keyof typeof ROLE_LABELS] ?? person.role;

  return (
    <div className="space-y-6">
      <Button size="sm" variant="ghost" className="-ml-2" nativeButton={false} render={<Link href="/dashboard/people" />}>
        <ArrowLeft />
        成员
      </Button>

      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <UserAvatar
          userId={person.id}
          name={person.name}
          email={person.email}
          avatarRev={person.avatarRev}
          size="xl"
        />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-heading text-xl font-semibold tracking-tight sm:text-2xl">{personName(person)}</h1>
              {mine ? <Badge variant="secondary">我</Badge> : null}
            </div>
            {person.title ? <p className="text-sm text-muted-foreground">{person.title}</p> : null}
          </div>
          {person.bio ? (
            <p className="max-w-prose text-sm leading-relaxed">{person.bio}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{mine ? "还没写简介。到账户页补上。" : "还没写简介。"}</p>
          )}
          {mine ? (
            <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/dashboard/settings/account" />}>
              编辑资料
            </Button>
          ) : null}
        </div>
      </div>

      <dl className="grid gap-3 rounded-lg border p-4 text-sm sm:grid-cols-2">
        <div className="space-y-1">
          <dt className="text-xs text-muted-foreground">邮箱</dt>
          <dd className="flex items-center gap-1.5">
            <span className="min-w-0 truncate">{person.email}</span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="复制邮箱"
              onClick={async () => {
                await navigator.clipboard.writeText(person.email);
                toast.success("已复制邮箱");
              }}
            >
              <Copy />
            </Button>
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="text-xs text-muted-foreground">角色</dt>
          <dd>{role}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-xs text-muted-foreground">加入团队</dt>
          <dd>{formatWhen(person.joinedAt)}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-xs text-muted-foreground">最近登录</dt>
          <dd>{person.lastLoginAt ? formatWhen(person.lastLoginAt) : "尚未登录"}</dd>
        </div>
      </dl>
    </div>
  );
}
