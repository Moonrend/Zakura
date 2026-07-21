"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CloudDownload, Store } from "lucide-react";
import { api } from "@/lib/api";
import { SettingsHeader } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

type InstanceRow = {
  id: string;
  name: string;
  slug: string;
  providerId: string;
  status: string;
  healthStatus: string;
  lastError?: string | null;
};

const MCP_PROVIDERS = new Set([
  "generic-mcp",
  "stdio-mcp",
  "openviking",
  "google-workspace",
]);

function providerLabel(id: string) {
  switch (id) {
    case "generic-mcp":
      return "HTTP";
    case "stdio-mcp":
      return "Stdio";
    case "openviking":
      return "OpenViking";
    case "google-workspace":
      return "Google Workspace";
    default:
      return id;
  }
}

function needsUpstreamAuth(i: InstanceRow): boolean {
  return (
    !!i.lastError?.startsWith("AUTH_REQUIRED") ||
    /missing required Authorization|401|unauthorized/i.test(i.lastError ?? "")
  );
}

function statusVariant(
  status: string,
): "default" | "secondary" | "success" | "warn" | "danger" {
  if (status === "running") return "success";
  if (status === "starting" || status === "stopping") return "warn";
  if (status === "error" || status === "unhealthy") return "danger";
  return "secondary";
}

function formatError(err: string | null | undefined): string {
  if (!err) return "—";
  return err.replace(/^(AUTH_REQUIRED|UNREACHABLE):\s*/, "");
}

export default function McpServersPage() {
  const [instances, setInstances] = useState<InstanceRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const inst = await api<InstanceRow[]>("/api/instances");
      setInstances(inst.filter((i) => MCP_PROVIDERS.has(i.providerId)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      <SettingsHeader title="服务器" />

      {loading ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : instances.length === 0 ? (
        <div className="rounded-lg border border-dashed py-12 text-center">
          <p className="mb-3 text-sm text-muted-foreground">暂无 MCP 服务器</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button size="sm" nativeButton={false} render={<Link href="/dashboard/mcp/official" />}>
              <Store />
              官方商店
            </Button>
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link href="/dashboard/mcp/store" />}
            >
              社区商店
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
              <TableHead>Provider</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>错误</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {instances.map((i) => {
              const authNeeded = needsUpstreamAuth(i);
              return (
                <TableRow key={i.id}>
                  <TableCell>
                    <Link
                      href={`/dashboard/mcp/${i.id}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {i.name}
                    </Link>
                    {authNeeded ? (
                      <Badge variant="destructive" className="ml-1.5 text-[10px]">
                        需 OAuth
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <code className="text-[11px] text-muted-foreground">{i.slug}</code>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{providerLabel(i.providerId)}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(i.status)}>{i.status}</Badge>
                  </TableCell>
                  <TableCell
                    className="max-w-xs truncate text-xs text-muted-foreground"
                    title={i.lastError ?? undefined}
                  >
                    {formatError(i.lastError)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
