"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ExternalLink, Loader2 } from "lucide-react";
import {
  connectMeshOauth,
  ensureMeshAclTags,
  fetchMesh,
  startMeshOauth,
  type MeshPayload,
} from "@/lib/network";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { PageLoading } from "@/components/ui/progress-linear";

export type TailscaleMeshReady = {
  /** 可用 Tailscale 安装 Runner */
  ready: boolean;
  /** 平台 Headscale：强制组网 */
  platformMode: boolean;
  mesh: MeshPayload | null;
};

type ConnectFormProps = {
  clientId: string;
  clientSecret: string;
  tags: string;
  busy?: boolean;
  onClientIdChange: (v: string) => void;
  onClientSecretChange: (v: string) => void;
  onTagsChange: (v: string) => void;
  onOpenCreateClient: () => void;
  onConnect: () => void;
  /** 紧凑布局（弹窗内） */
  compact?: boolean;
};

/** Tailscale OAuth 连接表单 —— 组网设置页与 Runner 注册共用 */
export function TailscaleOauthConnectForm({
  clientId,
  clientSecret,
  tags,
  busy,
  onClientIdChange,
  onClientSecretChange,
  onTagsChange,
  onOpenCreateClient,
  onConnect,
  compact,
}: ConnectFormProps) {
  return (
    <div className={compact ? "space-y-2.5" : "space-y-3"}>
      <Button size="sm" variant="outline" onClick={onOpenCreateClient}>
        <ExternalLink className="size-3.5" />
        打开 Tailscale 创建 OAuth Client
      </Button>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Client ID</Label>
          <Input
            className="font-mono text-xs"
            value={clientId}
            onChange={(e) => onClientIdChange(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="space-y-1">
          <Label>Client Secret</Label>
          <Input
            type="password"
            className="font-mono text-xs"
            value={clientSecret}
            onChange={(e) => onClientSecretChange(e.target.value)}
            autoComplete="off"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label>Tags</Label>
        <Input
          className="font-mono text-xs"
          value={tags}
          onChange={(e) => onTagsChange(e.target.value)}
          placeholder="tag:zakura"
        />
        <p className="text-[11px] text-muted-foreground">
          与 OAuth Client Tags 一致
        </p>
      </div>
      <Button
        size="sm"
        disabled={busy || !clientId.trim() || !clientSecret.trim() || !tags.trim()}
        onClick={onConnect}
      >
        {busy ? <Loader2 className="animate-spin" /> : null}
        连接 Tailscale
      </Button>
    </div>
  );
}

type PanelProps = {
  /** 仅在挂载 / 显式刷新时拉 mesh；父级控制是否渲染本组件 = 是否发起请求 */
  onStatusChange?: (status: TailscaleMeshReady) => void;
  onConnected?: (mesh: MeshPayload) => void;
  compact?: boolean;
  className?: string;
};

function deriveReady(mesh: MeshPayload): TailscaleMeshReady {
  const platformMode = mesh.meshProvider === "headscale-platform";
  const oauthConnected = mesh.oauth?.status === "connected";
  const ready = platformMode || Boolean(mesh.connected) || oauthConnected;
  return {
    ready,
    platformMode,
    mesh,
  };
}

/**
 * 按需加载的 Tailscale 组网面板。
 * 仅在组件挂载时请求 /mesh，不走慢的 mesh-status。
 */
export function TailscaleMeshPanel({
  onStatusChange,
  onConnected,
  compact,
  className,
}: PanelProps) {
  const [mesh, setMesh] = useState<MeshPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tags, setTags] = useState("tag:zakura");
  const [busy, setBusy] = useState(false);

  const onStatusChangeRef = useRef(onStatusChange);
  const onConnectedRef = useRef(onConnected);
  onStatusChangeRef.current = onStatusChange;
  onConnectedRef.current = onConnected;

  const emit = useCallback((next: MeshPayload | null) => {
    if (!next) {
      onStatusChangeRef.current?.({
        ready: false,
        platformMode: false,
        mesh: null,
      });
      return;
    }
    onStatusChangeRef.current?.(deriveReady(next));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchMesh();
      setMesh(next);
      if (next.oauth?.tags?.length) {
        setTags(next.oauth.tags.join(", "));
      }
      emit(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setMesh(null);
      emit(null);
    } finally {
      setLoading(false);
    }
  }, [emit]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openCreateClient() {
    try {
      const res = await startMeshOauth();
      window.open(res.createClientUrl, "_blank", "noopener,noreferrer");
      toast.message("已打开 Tailscale OAuth 控制台", { description: res.note });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function connect() {
    const tagList = tags
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (!clientId.trim() || !clientSecret.trim()) {
      toast.error("请填写 Client ID / Secret");
      return;
    }
    if (!tagList.length) {
      toast.error("请填写 Tags");
      return;
    }
    setBusy(true);
    try {
      const next = await connectMeshOauth({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        tags: tagList,
      });
      setMesh(next);
      setClientSecret("");
      try {
        await ensureMeshAclTags(tagList);
      } catch {
        /* ignore */
      }
      toast.success("Tailscale 已连接");
      emit(next);
      onConnectedRef.current?.(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className={className}>
        <PageLoading />
      </div>
    );
  }

  if (!mesh) {
    return (
      <div className={className}>
        <p className="text-sm text-destructive">无法加载组网状态</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={() => void load()}>
          重试
        </Button>
      </div>
    );
  }

  const status = deriveReady(mesh);
  const oauthConnected = mesh.oauth?.status === "connected";

  if (status.platformMode) {
    return (
      <div className={className}>
        <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Badge>平台组网</Badge>
            <span className="text-xs text-muted-foreground">Headscale 已托管</span>
          </div>
        </div>
      </div>
    );
  }

  if (status.ready || oauthConnected) {
    return (
      <div className={className}>
        <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Badge>已连接</Badge>
            {mesh.oauth?.displayName ? (
              <span className="text-xs text-muted-foreground">{mesh.oauth.displayName}</span>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="mb-2.5">
        <div className="flex items-center gap-2">
          <Badge variant="secondary">未连接</Badge>
          <span className="text-xs text-muted-foreground">连接 Tailscale 账号</span>
        </div>
      </div>
      <TailscaleOauthConnectForm
        compact={compact}
        clientId={clientId}
        clientSecret={clientSecret}
        tags={tags}
        busy={busy}
        onClientIdChange={setClientId}
        onClientSecretChange={setClientSecret}
        onTagsChange={setTags}
        onOpenCreateClient={() => void openCreateClient()}
        onConnect={() => void connect()}
      />
    </div>
  );
}
