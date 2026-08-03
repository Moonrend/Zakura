"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";

type InboundClient = {
  id: string;
  clientId: string;
  clientName: string;
  registrationType: "manual" | "dynamic" | "cimd";
  tenantBound: boolean;
  createdAt: string;
};

type OutboundClient = {
  id: string;
  mcpUrl: string;
  host: string;
  clientId: string;
  clientName: string;
  source: "dcr" | "byo";
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
};

const INBOUND_LABEL: Record<InboundClient["registrationType"], string> = {
  dynamic: "DCR",
  cimd: "CIMD",
  manual: "手动",
};

function formatDate(value: string) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

/** 用户 OAuth 客户端：接入 CIMD/DCR + 上游 DCR + 用户自配 BYO */
export default function OauthClientsPage() {
  const [inbound, setInbound] = useState<InboundClient[]>([]);
  const [dcr, setDcr] = useState<OutboundClient[]>([]);
  const [byo, setByo] = useState<OutboundClient[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{
        inbound: InboundClient[];
        dcr: OutboundClient[];
        byo: OutboundClient[];
      }>("/api/oauth/clients");
      setInbound(res.inbound ?? []);
      setDcr(res.dcr ?? []);
      setByo(res.byo ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const inboundSorted = useMemo(() => {
    const rank = (t: InboundClient["registrationType"]) =>
      t === "cimd" ? 0 : t === "dynamic" ? 1 : 2;
    return [...inbound].sort(
      (a, b) =>
        rank(a.registrationType) - rank(b.registrationType) ||
        (a.clientName || "").localeCompare(b.clientName || ""),
    );
  }, [inbound]);

  return (
    <div className="space-y-8">
      <SettingsHeader
        title="OAuth 客户端"
        description="外部工具接入本平台，以及本平台连接远程 MCP 时产生的客户端记录。"
      />

      <SettingsSection title="接入客户端（CIMD / DCR）">
        <p className="mb-3 text-xs text-muted-foreground">
          Cursor、VS Code 等通过动态注册（DCR）或 Client ID Metadata（CIMD）接入本平台 MCP
          时产生的客户端记录。
        </p>
        {loading ? (
          <Skeleton className="h-32 w-full rounded-lg" />
        ) : inboundSorted.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
            尚无接入客户端。当外部工具完成 OAuth 授权后会出现在这里。
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>Client ID</TableHead>
                  <TableHead>创建时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inboundSorted.map((client) => (
                  <TableRow key={client.id}>
                    <TableCell className="font-medium">
                      {client.clientName || "未命名"}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Badge variant="secondary">
                          {INBOUND_LABEL[client.registrationType]}
                        </Badge>
                        {!client.tenantBound ? (
                          <Badge variant="outline">共享</Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <code className="block max-w-[240px] truncate text-[11px] text-muted-foreground">
                        {client.clientId}
                      </code>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(client.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="上游动态注册（DCR）">
        <p className="mb-3 text-xs text-muted-foreground">
          安装远程 MCP 时，本平台作为客户端向对方授权服务器动态注册产生的记录。
        </p>
        {loading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : dcr.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
            尚无上游 DCR 记录。支持动态注册的远程 MCP 在首次授权时会写入。
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>上游</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead>Client ID</TableHead>
                  <TableHead>时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dcr.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{row.host}</div>
                        <code className="block max-w-[220px] truncate text-[10px] text-muted-foreground">
                          {row.mcpUrl}
                        </code>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {row.clientName || "—"}
                    </TableCell>
                    <TableCell>
                      <code className="block max-w-[200px] truncate text-[11px] text-muted-foreground">
                        {row.clientId}
                      </code>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(row.updatedAt || row.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="用户配置（BYO）">
        <p className="mb-3 text-xs text-muted-foreground">
          安装或授权时填写的自备 OAuth Client ID / Secret，按上游 host 去重保存。
        </p>
        {loading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : byo.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
            尚无用户自备客户端。在 MCP 安装流中填写 Client ID 后会出现在这里。
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>上游</TableHead>
                  <TableHead>Client ID</TableHead>
                  <TableHead>Secret</TableHead>
                  <TableHead>时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byo.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{row.host}</div>
                        <code className="block max-w-[220px] truncate text-[10px] text-muted-foreground">
                          {row.mcpUrl}
                        </code>
                      </div>
                    </TableCell>
                    <TableCell>
                      <code className="block max-w-[200px] truncate text-[11px] text-muted-foreground">
                        {row.clientId}
                      </code>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.hasSecret ? "已保存" : "无"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(row.updatedAt || row.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
