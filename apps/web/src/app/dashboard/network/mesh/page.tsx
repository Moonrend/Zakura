"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, KeyRound, RefreshCw } from "lucide-react";
import {
  connectMeshOauth,
  disconnectMesh,
  ensureMeshAclTags,
  fetchMesh,
  generateMeshAuthKey,
  saveMeshAuthKey,
  startMeshOauth,
  syncMesh,
  updateMeshOauthTags,
  type MeshPayload,
} from "@/lib/network";
import { TailscaleOauthConnectForm } from "@/components/tailscale-mesh-panel";
import { SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

export default function NetworkMeshPage() {
  const [data, setData] = useState<MeshPayload | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tags, setTags] = useState("");
  const [authKey, setAuthKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchMesh());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (data?.oauth?.tags?.length && !tags.trim()) {
      setTags(data.oauth.tags.join(", "));
    }
  }, [data?.oauth?.tags, tags]);

  async function onOpenCreateClient() {
    try {
      const res = await startMeshOauth();
      window.open(res.createClientUrl, "_blank", "noopener,noreferrer");
      toast.message("已打开 Tailscale OAuth 控制台", {
        description: res.note,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function parseTags(): string[] {
    return tags
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  async function onConnectOauth() {
    const tagList = parseTags();
    if (!tagList.length) {
      toast.error("请填写与 OAuth Client 一致的 Tags");
      return;
    }
    setBusy(true);
    try {
      setData(
        await connectMeshOauth({
          clientId,
          clientSecret,
          tags: tagList,
        }),
      );
      setClientSecret("");
      toast.success("Tailscale OAuth 已连接");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSync() {
    setBusy(true);
    try {
      setData(await syncMesh());
      toast.success("已同步设备列表");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onUpdateTags() {
    const tagList = parseTags();
    if (!tagList.length) {
      toast.error("请填写至少一个 Tags");
      return;
    }
    setBusy(true);
    try {
      setData(await updateMeshOauthTags(tagList));
      toast.success("Tags 已更新");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onEnsureAclTags() {
    const tagList = parseTags();
    if (!tagList.length) {
      toast.error("请先填写 Tags（例如 tag:zakura-runner）");
      return;
    }
    setBusy(true);
    try {
      const res = await ensureMeshAclTags(tagList);
      setData(res);
      const added = res.aclEnsure?.added ?? [];
      const present = res.aclEnsure?.alreadyPresent ?? [];
      if (added.length) {
        toast.success(`已写入 ACL：${added.join(", ")}`, {
          description:
            "请到 Tailscale 编辑 OAuth Client，勾选同一 tag 后，再生成 Auth Key。",
        });
      } else {
        toast.message(`ACL 已存在：${present.join(", ") || "—"}`, {
          description: "若仍无法生成 Key，请确认 OAuth Client 已勾选这些 tag。",
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onGenerateKey() {
    const tagList = parseTags();
    setBusy(true);
    try {
      const res = await generateMeshAuthKey(
        tagList.length ? { tags: tagList } : undefined,
      );
      setData(res);
      if (res.generatedKey) {
        setGeneratedKey(res.generatedKey);
        toast.success("已生成并保存 Runner Auth Key");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSaveKey() {
    setBusy(true);
    try {
      setData(await saveMeshAuthKey(authKey));
      setAuthKey("");
      toast.success("Auth Key 已保存");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect() {
    setBusy(true);
    try {
      setData(await disconnectMesh());
      setGeneratedKey(null);
      toast.success("已断开组网凭证");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("复制失败");
    }
  }

  if (!data) {
    return (
      <div className="space-y-5">
        <SettingsHeader title="Runner 组网" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const platformMode = data.meshProvider === "headscale-platform";
  const oauthConnected = data.oauth?.status === "connected";

  // ── Platform-managed (SaaS Headscale): devices only ────────────────────
  if (platformMode) {
    const tailnet = data.tailnetDevices ?? [];
    return (
      <div className="space-y-5">
        <SettingsHeader
          title="Runner 组网"
          actions={
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void onSync()}>
              <RefreshCw className="size-3.5" />
              同步
            </Button>
          }
        />

        <p className="text-sm text-muted-foreground">
          平台组网已启用，Runner 自动加入
          {data.headscaleUser ? (
            <>
              {" "}
              · <code className="font-mono text-xs">{data.headscaleUser}</code>
            </>
          ) : null}
        </p>

        {data.platform?.lastError ? (
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            {data.platform.lastError}
          </pre>
        ) : null}

        <SettingsSection title="本租户设备">
          {tailnet.length === 0 && data.devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无设备。创建 Runner 并启用安装脚本后将出现在此。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>地址</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>标签 / 用户</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tailnet.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.hostname || d.name}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {d.addresses?.join(", ") || "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={d.online ? "default" : "secondary"}>
                        {d.online ? "在线" : "离线"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {d.tags?.length ? d.tags.join(", ") : d.user || "—"}
                    </TableCell>
                  </TableRow>
                ))}
                {data.devices.map((d) => (
                  <TableRow key={`rn-${d.id}`}>
                    <TableCell className="font-medium">{d.name}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {d.tailscale?.ip || d.endpoint || "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={d.status === "online" ? "default" : "secondary"}>
                        {d.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">Runner · {d.slug}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SettingsSection>
      </div>
    );
  }

  // ── Tailscale cloud (self-hosted / no platform Headscale) ──────────────
  return (
    <div className="space-y-5">
      <SettingsHeader
        title="Runner 组网"
        actions={
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void onSync()}>
            <RefreshCw className="size-3.5" />
            同步设备列表
          </Button>
        }
      />

      {data.hostJoinsTailscale === false ? (
        <p className="text-xs text-muted-foreground rounded-lg border border-border/60 px-3 py-2">
          控制面不入网；安装包用外部 URL
        </p>
      ) : null}

      <SettingsSection title="Tailscale 云（自有账号）">
        <p className="text-sm text-muted-foreground">OAuth Client + 一致的 Tags</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge variant={oauthConnected ? "default" : "secondary"}>
            {oauthConnected ? "OAuth 已连接" : "OAuth 未连接"}
          </Badge>
          {data.oauth?.displayName ? (
            <span className="text-sm text-muted-foreground">{data.oauth.displayName}</span>
          ) : null}
        </div>

        {data.oauth?.lastError ? (
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            {data.oauth.lastError}
          </pre>
        ) : null}

        {!oauthConnected ? (
          <div className="mt-3">
            <TailscaleOauthConnectForm
              clientId={clientId}
              clientSecret={clientSecret}
              tags={tags}
              busy={busy}
              onClientIdChange={setClientId}
              onClientSecretChange={setClientSecret}
              onTagsChange={setTags}
              onOpenCreateClient={() => void onOpenCreateClient()}
              onConnect={() => void onConnectOauth()}
            />
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap gap-2">
              <Input
                className="max-w-md font-mono text-xs"
                placeholder="tag:zakura-runner"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
              />
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void onUpdateTags()}>
                更新 Tags
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void onEnsureAclTags()}>
                在 ACL 中创建 Tags
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={() => void onGenerateKey()}>
                <KeyRound className="size-3.5" />
                生成 Runner Auth Key
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void onDisconnect()}>
                断开连接
              </Button>
            </div>
          </div>
        )}

        {generatedKey ? (
          <div className="relative mt-3">
            <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              刚生成的 Auth Key
              <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => void copyText(generatedKey)}>
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              </Button>
            </div>
            <pre className="overflow-auto rounded-lg bg-muted px-3 py-2.5 font-mono text-[11px] break-all">
              {generatedKey}
            </pre>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title="预授权密钥（高级 / 手动）">
        <div className="flex flex-wrap gap-2">
          <Input
            className="max-w-md font-mono text-xs"
            placeholder="tskey-auth-..."
            value={authKey}
            onChange={(e) => setAuthKey(e.target.value)}
          />
          <Button size="sm" disabled={busy || !authKey.trim()} onClick={() => void onSaveKey()}>
            保存并应用
          </Button>
        </div>
      </SettingsSection>

      {(data.tailnetDevices?.length ?? 0) > 0 ? (
        <SettingsSection title="Tailnet 设备">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>地址</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.tailnetDevices!.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{d.hostname || d.name}</TableCell>
                  <TableCell className="font-mono text-xs">{d.addresses?.join(", ")}</TableCell>
                  <TableCell>{d.online ? "在线" : "离线"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SettingsSection>
      ) : null}
    </div>
  );
}
