"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { RefreshCw, Square } from "lucide-react";
import {
  fetchActiveExposures,
  stopAllExposures,
  stopExposure,
  type PortExposureDto,
} from "@/lib/network";
import { SettingsHeader, SettingsSection, TableActions } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";

export default function NetworkActiveExposuresPage() {
  const [rows, setRows] = useState<PortExposureDto[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetchActiveExposures();
      setRows(res.exposures);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onStop(id: string) {
    setBusy(true);
    try {
      await stopExposure(id);
      toast.success("已关闭");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onStopAll() {
    if (!confirm("确认关闭全部活跃暴露？")) return;
    setBusy(true);
    try {
      const res = await stopAllExposures();
      toast.success(`已关闭 ${res.stopped} 个`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="活跃暴露"
        actions={
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" onClick={() => void load()}>
              <RefreshCw className="size-3.5" />
              刷新
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy || rows.length === 0}
              onClick={() => void onStopAll()}
            >
              全部关闭
            </Button>
          </div>
        }
      />

      <SettingsSection>
        {!rows.length ? (
          <p className="text-sm text-muted-foreground">当前没有活跃隧道</p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Agent</TH>
                <TH>端口</TH>
                <TH>Provider</TH>
                <TH>URL</TH>
                <TH>状态</TH>
                <TH>过期</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <div className="font-medium">{r.agentName ?? r.agentId}</div>
                    <div className="text-xs text-muted-foreground">{r.name}</div>
                  </TD>
                  <TD className="font-mono text-xs">{r.port}</TD>
                  <TD className="text-xs">{r.provider}</TD>
                  <TD className="max-w-[220px] truncate font-mono text-xs">
                    {r.publicUrl ? (
                      <a
                        href={r.publicUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline-offset-2 hover:underline"
                      >
                        {r.publicUrl}
                      </a>
                    ) : (
                      "—"
                    )}
                  </TD>
                  <TD>
                    <Badge variant={r.status === "active" ? "default" : "secondary"}>
                      {r.status}
                    </Badge>
                  </TD>
                  <TD className="text-xs text-muted-foreground">
                    {r.expiresAt ? new Date(r.expiresAt).toLocaleString() : "—"}
                  </TD>
                  <TD>
                    <TableActions>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        disabled={busy}
                        title="关闭"
                        onClick={() => void onStop(r.id)}
                      >
                        <Square className="size-3.5" />
                      </Button>
                    </TableActions>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </SettingsSection>
    </div>
  );
}
