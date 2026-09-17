"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

type Device = { id: string; name: string; bindingIds: string[]; expiresAt: string; revokedAt: string | null };

export function ZakurabotDevices({ bindingId, onChange }: { bindingId: string; onChange: () => Promise<void> }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [baseUrl, setBaseUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issued, setIssued] = useState<{ id: string; token: string } | null>(null);
  const load = useCallback(async () => {
    const result = await api<{ devices: Device[]; baseUrl: string }>("/api/zakurabot/devices");
    setDevices(result.devices.filter((d) => d.bindingIds.includes(bindingId)));
    setBaseUrl(result.baseUrl);
    setError("");
  }, [bindingId]);
  useEffect(() => {
    setIssued(null);
    void load().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [load]);

  async function issue() {
    setBusy(true);
    try {
      const result = await api<{ device: Device; token: string; baseUrl: string }>("/api/zakurabot/devices",
        { method: "POST", json: { name: name.trim(), bindingIds: [bindingId] } });
      setIssued({ id: result.device.id, token: result.token });
      setBaseUrl(result.baseUrl);
      setName("");
      await load();
      await onChange();
    } catch (err) { toast.error(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      await api(`/api/zakurabot/devices/${id}`, { method: "DELETE" });
      if (issued?.id === id) setIssued(null);
      await load();
      toast.success("设备已撤销");
    } catch (err) { toast.error(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); toast.success("已复制"); }
    catch { toast.error("复制失败，请手动复制"); }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">Zakura Bot 设备</p>
      <p className="text-xs text-muted-foreground">在 App 设置中填写 Base URL 和设备 Token，然后关闭 Mock Channel。新设备有效期为 90 天。</p>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {baseUrl ? (
        <div className="space-y-1">
          <Label htmlFor="zakurabot-base-url">Base URL</Label>
          <div className="flex gap-1">
            <Input id="zakurabot-base-url" readOnly value={baseUrl} />
            <Button size="icon" variant="outline" aria-label="复制 Base URL" onClick={() => void copy(baseUrl)}><Copy /></Button>
          </div>
        </div>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor="zakurabot-device-name">设备名称</Label>
        <div className="flex gap-2">
          <Input id="zakurabot-device-name" value={name} maxLength={128} placeholder="例如：我的 iPhone" onChange={(e) => setName(e.target.value)} />
          <Button disabled={busy || !name.trim()} onClick={() => void issue()}>
            {busy ? <Loader2 className="animate-spin" /> : null}创建设备
          </Button>
        </div>
      </div>
      {issued ? (
        <div className="space-y-1">
          <Label htmlFor="zakurabot-device-token">设备 Token（仅显示一次）</Label>
          <div className="flex gap-1">
            <Input id="zakurabot-device-token" readOnly value={issued.token} autoComplete="off" />
            <Button size="icon" variant="outline" aria-label="复制设备 Token" onClick={() => void copy(issued.token)}><Copy /></Button>
          </div>
          <p className="text-xs text-muted-foreground">请复制到 App 的 Auth Token 设置中。</p>
        </div>
      ) : null}
      <ul className="divide-y divide-border">
        {devices.map((device) => (
          <li key={device.id} className="flex items-center justify-between gap-2 py-2 text-xs">
            <div className="min-w-0">
              <p className="truncate font-medium">{device.name}</p>
              <p className="text-muted-foreground">{device.revokedAt ? "已撤销" : `有效期至 ${new Date(device.expiresAt).toLocaleDateString()}`}</p>
            </div>
            {!device.revokedAt ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revoke(device.id)}>撤销</Button> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
