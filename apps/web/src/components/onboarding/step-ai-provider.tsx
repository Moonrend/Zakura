"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import {
  MODEL_UPSTREAM_DEFAULT_BASE_URLS,
  type ModelUpstreamProtocol,
} from "@zakura/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { UpstreamModelSetup } from "@/components/models/upstream-model-setup";
import { SettingsHeader } from "@/components/settings-shell";

type ProviderOption = { protocol: string; name: string };

export type OnboardingUpstream = {
  id: string;
  name: string;
  protocol: string;
  config?: Record<string, unknown>;
  resolvedConfig?: { baseUrl?: string };
  meta?: { name?: string };
};

type Props = {
  protocols: ProviderOption[];
  alreadyConfigured: boolean;
  initialUpstream?: OnboardingUpstream | null;
  busy?: boolean;
  onBack: () => void;
  onUpstreamChange?: (upstream: OnboardingUpstream) => void;
  onConfigured: () => void;
};

const SUGGESTED_PROTOCOLS = ["openai", "deepseek", "anthropic", "gemini", "openrouter", "bailian", "custom"];

function initialBaseUrl(upstream?: OnboardingUpstream | null) {
  return String(upstream?.config?.baseUrl ?? upstream?.resolvedConfig?.baseUrl ?? "") ||
    MODEL_UPSTREAM_DEFAULT_BASE_URLS.openai ||
    "https://api.openai.com/v1";
}

export function StepAiProvider({
  protocols,
  alreadyConfigured,
  initialUpstream,
  busy,
  onBack,
  onUpstreamChange,
  onConfigured,
}: Props) {
  const available = useMemo(() => {
    const source = protocols.length
      ? protocols
      : SUGGESTED_PROTOCOLS.map((protocol) => ({ protocol, name: protocol }));
    const suggested = source.filter((item) => SUGGESTED_PROTOCOLS.includes(item.protocol));
    return suggested.length ? suggested : source;
  }, [protocols]);

  const [upstream, setUpstream] = useState<OnboardingUpstream | null>(initialUpstream ?? null);
  const [protocol, setProtocol] = useState(
    initialUpstream?.protocol ?? available.find((item) => item.protocol === "openai")?.protocol ?? available[0]?.protocol ?? "openai",
  );
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl(initialUpstream));
  const [editing, setEditing] = useState(!initialUpstream);
  const [configured, setConfigured] = useState(alreadyConfigured);
  const [saving, setSaving] = useState(false);
  const [syncKey, setSyncKey] = useState(initialUpstream ? 0 : -1);

  const providerItems = available.map((item) => ({ value: item.protocol, label: item.name }));
  const selectedProvider = available.find((item) => item.protocol === protocol);
  const providerLabel = selectedProvider?.name ?? upstream?.meta?.name ?? upstream?.name ?? protocol;

  function changeProtocol(next: string | null) {
    if (!next) return;
    setProtocol(next);
    setBaseUrl(MODEL_UPSTREAM_DEFAULT_BASE_URLS[next as ModelUpstreamProtocol] ?? "");
  }

  async function saveProvider() {
    if (!baseUrl.trim()) {
      toast.error("请填写 API 地址");
      return;
    }
    if (!upstream && protocol !== "custom" && !apiKey.trim()) {
      toast.error("请填写 API Key");
      return;
    }

    setSaving(true);
    try {
      const config = {
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      };
      const saved = upstream
        ? await api<OnboardingUpstream>(`/api/model-upstreams/${upstream.id}`, {
            method: "PATCH",
            json: { name: upstream.name || providerLabel, config },
          })
        : await api<OnboardingUpstream>("/api/model-upstreams", {
            method: "POST",
            json: { name: providerLabel, protocol, config },
          });

      setUpstream(saved);
      setProtocol(saved.protocol);
      setBaseUrl(initialBaseUrl(saved));
      setApiKey("");
      setEditing(false);
      setConfigured(false);
      setSyncKey((value) => value + 1);
      onUpstreamChange?.(saved);
      toast.success(upstream ? "连接已更新，正在重新解析模型" : "提供商已连接，正在解析模型");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" disabled={saving || busy} onClick={onBack}>
        <ArrowLeft />
        返回选择
      </Button>

      <SettingsHeader title="配置云端 Agent" description="连接提供商并选择默认模型" />

      <div className="rounded-lg border border-border/80 bg-card">
        <div className="p-4 sm:p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">AI 提供商</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {upstream && !editing ? `${providerLabel} · ${baseUrl}` : "填写连接信息，密钥会安全保存。"}
              </p>
            </div>
            {upstream && !editing ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" />
                编辑连接
              </Button>
            ) : null}
          </div>

          {editing ? (
            <div className="animate-in fade-in slide-in-from-top-1 mt-5 grid gap-4 duration-200">
              <div className="space-y-2">
                <Label htmlFor="onboarding-provider">提供商</Label>
                <Select value={protocol} onValueChange={changeProtocol} items={providerItems} disabled={Boolean(upstream)}>
                  <SelectTrigger id="onboarding-provider" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {available.map((item) => <SelectItem key={item.protocol} value={item.protocol}>{item.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="onboarding-api-key">API Key</Label>
                <Input
                  id="onboarding-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={upstream ? "留空则保留当前 Key" : protocol === "custom" ? "可选" : "sk-…"}
                  autoComplete="new-password"
                />
              </div>

              <details className="group text-xs" open={protocol === "custom"}>
                <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">API 地址</summary>
                <div className="mt-3 space-y-2">
                  <Label htmlFor="onboarding-base-url">Base URL</Label>
                  <Input id="onboarding-base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://…" autoComplete="url" />
                </div>
              </details>

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                {upstream ? <Button type="button" variant="ghost" onClick={() => setEditing(false)}>取消</Button> : null}
                <Button type="button" disabled={saving || busy} onClick={() => void saveProvider()}>
                  {saving ? <Loader2 className="animate-spin" /> : null}
                  {saving ? "正在连接…" : upstream ? "保存并重新解析" : "连接并解析模型"}
                  {!saving ? <ArrowRight /> : null}
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {upstream ? (
          <div className="animate-in fade-in slide-in-from-top-1 border-t border-border/80 p-4 duration-200 sm:p-5">
            <UpstreamModelSetup
              upstreamId={upstream.id}
              autoSync={syncKey >= 0 && !configured}
              syncKey={syncKey}
              variant="onboarding"
              onReady={() => {
                setConfigured(true);
                onConfigured();
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
