"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { formatAbsolute, formatRelative } from "@/lib/format";
import {
  fetchMyUsage,
  fetchUserUsage,
  USAGE_ACTION_LABEL,
  USAGE_CATEGORY_LABEL,
  type UserUsageBundle,
} from "@/lib/user-usage";
import { SettingsSection } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
import { PageLoading } from "@/components/ui/progress-linear";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function UserUsagePanel({
  userId,
  scope = "tenant",
}: {
  userId?: string;
  scope?: "tenant" | "all" | "me";
}) {
  const [data, setData] = useState<UserUsageBundle | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load =
      scope === "me" || !userId
        ? fetchMyUsage(30)
        : fetchUserUsage(userId, { days: 30, scope });
    void load
      .then((bundle) => {
        if (!cancelled) setData(bundle);
      })
      .catch((err) => {
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, scope]);

  if (loading || !data) {
    return (
      <SettingsSection title="用量（近 30 天）">
        <PageLoading />
      </SettingsSection>
    );
  }

  const { totals } = data.summary;

  return (
    <>
      <SettingsSection title="用量（近 30 天）">
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="登录" value={totals.logins} />
          <Stat label="会话" value={totals.sessionsStarted} />
          <Stat
            label="回合"
            value={totals.runsOk + totals.runsError}
            hint={totals.runsError ? `${totals.runsError} 失败/取消` : undefined}
          />
          <Stat
            label="最近活跃"
            value={data.summary.lastSeenAt ? formatRelative(data.summary.lastSeenAt) : "—"}
            title={data.summary.lastSeenAt ? formatAbsolute(data.summary.lastSeenAt) : undefined}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={`活动日志（${data.eventTotal}）`}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>动作</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>说明</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.events.map((ev) => (
              <TableRow key={ev.id}>
                <TableCell className="text-xs text-muted-foreground" title={formatAbsolute(ev.createdAt)}>
                  {formatRelative(ev.createdAt)}
                </TableCell>
                <TableCell className="text-xs">{USAGE_CATEGORY_LABEL[ev.category] ?? ev.category}</TableCell>
                <TableCell className="text-xs">{USAGE_ACTION_LABEL[ev.action] ?? ev.action}</TableCell>
                <TableCell>
                  <Badge variant={ev.status === "ok" ? "success" : "destructive"}>
                    {ev.status === "ok" ? "正常" : "异常"}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-[220px] truncate font-mono text-[11px] text-muted-foreground">
                  {ev.summary || ev.sessionId || "—"}
                </TableCell>
              </TableRow>
            ))}
            {data.events.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  尚无按用户记录的活动。登录或发起对话后会出现在这里。
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </SettingsSection>

      {data.sessions.length ? (
        <SettingsSection title={`最近会话（${data.sessions.length}）`}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>标题</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>更新</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.sessions.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/dashboard/agents/${s.agentId}`}
                      className="hover:underline"
                    >
                      {s.title || "未命名"}
                    </Link>
                    <div className="font-mono text-[11px] text-muted-foreground">{s.id}</div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{s.kind}</TableCell>
                  <TableCell className="text-xs text-muted-foreground" title={formatAbsolute(s.updatedAt)}>
                    {formatRelative(s.updatedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SettingsSection>
      ) : null}
    </>
  );
}

function Stat({
  label,
  value,
  hint,
  title,
}: {
  label: string;
  value: string | number;
  hint?: string;
  title?: string;
}) {
  return (
    <div className="rounded-lg border px-3 py-2.5" title={title}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
      {hint ? <div className="text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
