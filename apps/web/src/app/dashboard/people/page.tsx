"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatWhen } from "@/lib/device-from-ua";
import { ROLE_LABELS, personName, type Person } from "@/lib/people";
import { useMe } from "@/components/me-context";
import { SettingsHeader } from "@/components/settings-shell";
import { UserAvatar } from "@/components/user-avatar";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PageLoading } from "@/components/ui/progress-linear";

export default function PeoplePage() {
  const me = useMe();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    const res = await api<{ people: Person[] }>("/api/tenant/people");
    setPeople(res.people);
  }, []);

  useEffect(() => {
    void load().catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
  }, [load]);

  const filtered = useMemo(() => {
    if (!people) return [];
    const q = query.trim().toLowerCase();
    if (!q) return people;
    return people.filter((p) =>
      [p.name, p.email, p.title, p.bio].some((v) => v?.toLowerCase().includes(q)),
    );
  }, [people, query]);

  if (!people) return <PageLoading />;

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="成员"
        description={`${me.tenant.name} · ${people.length} 人。点进去看主页。`}
      />
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜名称、邮箱或头衔"
          className="pl-8"
        />
      </div>
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">{query.trim() ? "没有匹配的人。" : "这个团队还没有成员。"}</p>
      ) : (
        <div className="divide-y rounded-lg border">
          {filtered.map((person) => (
            <Link
              key={person.id}
              href={`/dashboard/people/${person.id}`}
              className="flex items-center gap-3 px-3 py-3 transition-colors hover:bg-muted/40"
            >
              <UserAvatar
                userId={person.id}
                name={person.name}
                email={person.email}
                avatarRev={person.avatarRev}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{personName(person)}</span>
                  {person.id === me.user?.id ? <Badge variant="secondary">我</Badge> : null}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {[person.title, person.email].filter(Boolean).join(" · ")}
                </div>
              </div>
              <div className="hidden shrink-0 text-right sm:block">
                <div className="text-xs text-muted-foreground">
                  {ROLE_LABELS[person.role as keyof typeof ROLE_LABELS] ?? person.role}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {person.lastLoginAt ? `最近 ${formatWhen(person.lastLoginAt)}` : "尚未登录"}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
