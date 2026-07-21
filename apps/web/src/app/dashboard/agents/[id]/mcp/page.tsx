"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { CloudDownload, Save, Store } from "lucide-react";
import {
  fetchAgentProviders,
  saveAgentProviders,
  statusVariant,
  type AgentProviderOptions,
} from "@/lib/agents";
import { SettingsHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

function providerLabel(id: string) {
  switch (id) {
    case "generic-mcp":
      return "HTTP";
    case "stdio-mcp":
      return "Stdio";
    case "openviking":
      return "OpenViking";
    default:
      return id;
  }
}

export default function AgentMcpPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [opts, setOpts] = useState<AgentProviderOptions | null>(null);
  const [mode, setMode] = useState<"all" | "selected">("selected");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const p = await fetchAgentProviders(id);
      setOpts(p);
      setMode(p.mcp.mode);
      setSelected(new Set(p.mcp.instances.filter((i) => i.bound).map((i) => i.id)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleInstance(instanceId: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(instanceId);
      else next.delete(instanceId);
      return next;
    });
  }

  async function saveBindings() {
    setBusy(true);
    try {
      const res = await saveAgentProviders(id, {
        mcp: {
          mode,
          instanceIds: mode === "selected" ? [...selected] : undefined,
        },
      });
      setOpts(res.options);
      setMode(res.options.mcp.mode);
      setSelected(
        new Set(res.options.mcp.instances.filter((i) => i.bound).map((i) => i.id)),
      );
      toast.success("已保存");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!opts) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  const instances = opts.mcp.instances;

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="MCP"
        actions={
          <>
            <Select
              value={mode}
              onValueChange={(v) => {
                if (v != null) setMode(v as "all" | "selected");
              }}
              items={[
                { value: "all", label: "全部 running" },
                { value: "selected", label: "仅所选" },
              ]}
            >
              <SelectTrigger className="h-8 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部 running</SelectItem>
                <SelectItem value="selected">仅所选</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link href="/dashboard/mcp/store" />}
            >
              <Store />
              商店
            </Button>
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link href="/dashboard/mcp/import" />}
            >
              <CloudDownload />
              导入
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void saveBindings()}>
              <Save />
              保存
            </Button>
          </>
        }
      />

      {instances.length === 0 ? (
        <div className="rounded-lg border border-dashed py-12 text-center">
          <p className="mb-3 text-sm text-muted-foreground">暂无 MCP 实例</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button size="sm" nativeButton={false} render={<Link href="/dashboard/mcp/store" />}>
              <Store />
              商店
            </Button>
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link href="/dashboard/mcp/import" />}
            >
              <CloudDownload />
              导入
            </Button>
          </div>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">绑定</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {instances.map((inst) => {
              const bound = mode === "all" ? true : selected.has(inst.id);
              return (
                <TableRow key={inst.id}>
                  <TableCell>
                    <Link
                      href={`/dashboard/mcp/${inst.id}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {inst.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <code className="text-[11px] text-muted-foreground">{inst.slug}</code>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{providerLabel(inst.providerId)}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(inst.status)}>{inst.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Switch
                      checked={bound}
                      disabled={mode === "all"}
                      onCheckedChange={(v) => toggleInstance(inst.id, v)}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {mode === "all" && instances.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          当前为「全部 running」模式：自动挂载所有运行中的实例，无需逐个勾选。
        </p>
      ) : null}
    </div>
  );
}
