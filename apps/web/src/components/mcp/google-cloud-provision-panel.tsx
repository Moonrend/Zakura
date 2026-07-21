"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { api } from "@/lib/api";
import { SettingsSection } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type ProvisionCopyable = {
  label: string;
  value: string;
  multiline?: boolean;
};

type ProvisionWizardStep = {
  id: "project" | "enable-apis" | "chat-app" | "oauth-consent" | "oauth-client" | "save";
  title: string;
  description: string;
  mode: "api" | "manual" | "hybrid";
  consoleUrl?: string;
  copyables: ProvisionCopyable[];
};

type ProvisionGuide = {
  projectId: string;
  redirectUri: string;
  wizardSteps?: ProvisionWizardStep[];
  enabled?: string[];
  alreadyEnabled?: string[];
  failed?: Array<{ service: string; error: string }>;
  projectInfo?: {
    projectId: string;
    name?: string;
    state?: string;
    error?: string;
  };
};

type Props = {
  onClientReady?: (client: { clientId: string; clientSecret: string }) => void;
  defaultScope?: "tenant" | "platform";
};

const STEP_IDS: ProvisionWizardStep["id"][] = [
  "project",
  "enable-apis",
  "chat-app",
  "oauth-consent",
  "oauth-client",
  "save",
];

async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}

function CopyRow({ label, value, multiline }: ProvisionCopyable) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/80 bg-background px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <code
          className={cn(
            "mt-0.5 block break-all font-mono text-[10px]",
            multiline && "max-h-24 overflow-auto whitespace-pre-wrap",
          )}
        >
          {value}
        </code>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 shrink-0 px-2 text-[11px]"
        onClick={() => {
          void copyText(value).then(() => {
            setCopied(true);
            toast.success("已复制");
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </Button>
    </div>
  );
}

export function GoogleCloudProvisionPanel({
  onClientReady,
  defaultScope = "tenant",
}: Props) {
  const [stepIndex, setStepIndex] = useState(0);
  const [projectId, setProjectId] = useState("");
  const [saJson, setSaJson] = useState("");
  const [guide, setGuide] = useState<ProvisionGuide | null>(null);
  const [busy, setBusy] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [doneMap, setDoneMap] = useState<
    Partial<Record<ProvisionWizardStep["id"], boolean>>
  >({});

  const loadGuide = useCallback(async (pid: string) => {
    const q = encodeURIComponent(pid.trim() || "YOUR_PROJECT_ID");
    const res = await api<ProvisionGuide>(
      `/api/mcp/google/provision-guide?projectId=${q}&products=gmail,drive,calendar,people,chat`,
    );
    setGuide(res);
    return res;
  }, []);

  useEffect(() => {
    void loadGuide("YOUR_PROJECT_ID").catch(() => undefined);
  }, [loadGuide]);

  const steps = useMemo(() => {
    if (guide?.wizardSteps?.length) return guide.wizardSteps;
    return STEP_IDS.map((id) => ({
      id,
      title: id,
      description: "",
      mode: "manual" as const,
      copyables: [],
    }));
  }, [guide]);

  const step = steps[stepIndex] ?? steps[0];
  const isLast = stepIndex >= steps.length - 1;

  function markDone(id: ProvisionWizardStep["id"]) {
    setDoneMap((prev) => ({ ...prev, [id]: true }));
  }

  async function refreshGuideWithProject() {
    const pid = projectId.trim() || "YOUR_PROJECT_ID";
    try {
      await loadGuide(pid);
      if (pid !== "YOUR_PROJECT_ID") markDone("project");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function runProvision() {
    if (!saJson.trim()) {
      toast.error("请粘贴 Service Account JSON");
      return;
    }
    setBusy(true);
    try {
      let parsed: unknown = saJson;
      try {
        parsed = JSON.parse(saJson);
      } catch {
        /* 后端也会 parse */
      }
      const res = await api<ProvisionGuide>("/api/mcp/google/provision", {
        method: "POST",
        json: {
          serviceAccountJson: parsed,
          projectId: projectId.trim() || undefined,
          products: ["gmail", "drive", "calendar", "people", "chat"],
        },
      });
      setGuide(res);
      if (res.projectId) setProjectId(res.projectId);
      const ok = (res.enabled?.length ?? 0) + (res.alreadyEnabled?.length ?? 0);
      if (res.failed?.length) {
        toast.error(`${res.failed.length} 个 API 启用失败`);
      } else {
        toast.success(`已启用 ${ok} 个 API`);
        markDone("enable-apis");
      }
      if (res.projectInfo && !res.projectInfo.error) markDone("project");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveClient() {
    if (!clientId.trim() || !clientSecret.trim()) {
      toast.error("请填写 Client ID 与 Secret");
      return;
    }
    setSaving(true);
    try {
      await api(`/api/mcp/oauth-apps/google?scope=${defaultScope}`, {
        method: "PUT",
        json: {
          enabled: true,
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        },
      });
      toast.success("已保存");
      markDone("save");
      onClientReady?.({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function goNext() {
    if (step?.id === "project" && projectId.trim()) markDone("project");
    if (step?.id === "chat-app") markDone("chat-app");
    if (step?.id === "oauth-consent") markDone("oauth-consent");
    if (step?.id === "oauth-client") markDone("oauth-client");
    setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  }

  return (
    <SettingsSection title="Google Cloud 供应">
      <nav className="mb-3 flex flex-wrap gap-1" aria-label="步骤">
        {steps.map((s, i) => {
          const done = !!doneMap[s.id];
          const active = i === stepIndex;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setStepIndex(i)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                active
                  ? "border-foreground bg-foreground text-background"
                  : done
                    ? "border-foreground/30"
                    : "border-border text-muted-foreground",
              )}
            >
              {done && !active ? <Check className="mr-1 inline size-3" /> : null}
              {i + 1}. {s.title}
            </button>
          );
        })}
      </nav>

      {step ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            {step.description ? (
              <p className="text-xs text-muted-foreground">{step.description}</p>
            ) : (
              <span />
            )}
            {step.consoleUrl ? (
              <a
                href={step.consoleUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
              >
                打开 Console
                <ExternalLink className="size-3" />
              </a>
            ) : null}
          </div>

          {step.id === "project" ? (
            <div className="flex flex-wrap gap-2">
              <Input
                className="max-w-xs"
                value={projectId}
                placeholder="Project ID"
                onChange={(e) => setProjectId(e.target.value)}
                autoComplete="off"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void refreshGuideWithProject()}
              >
                应用
              </Button>
            </div>
          ) : null}

          {step.id === "enable-apis" ? (
            <div className="space-y-2">
              <textarea
                className="min-h-24 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-[11px]"
                placeholder="Service Account JSON"
                value={saJson}
                onChange={(e) => setSaJson(e.target.value)}
                spellCheck={false}
              />
              <Button disabled={busy} size="sm" onClick={() => void runProvision()}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                自动启用 API
              </Button>
              {(guide?.enabled?.length ||
                guide?.alreadyEnabled?.length ||
                guide?.failed?.length) && (
                <p className="text-[11px] text-muted-foreground">
                  {guide.enabled?.length
                    ? `新启用 ${guide.enabled.length}`
                    : null}
                  {guide.alreadyEnabled?.length
                    ? ` · 已有 ${guide.alreadyEnabled.length}`
                    : null}
                  {guide.failed?.length
                    ? ` · 失败 ${guide.failed.length}`
                    : null}
                </p>
              )}
            </div>
          ) : null}

          {step.id === "save" ? (
            <div className="space-y-2">
              <div className="space-y-1">
                <Label className="text-xs">Client ID</Label>
                <Input
                  value={clientId}
                  placeholder="*.apps.googleusercontent.com"
                  onChange={(e) => setClientId(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Client Secret</Label>
                <Input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <Button disabled={saving} size="sm" onClick={() => void saveClient()}>
                {saving ? <Loader2 className="animate-spin" /> : null}
                保存并启用
              </Button>
            </div>
          ) : null}

          {step.copyables.length ? (
            <div className="space-y-1.5">
              {step.copyables.map((c) => (
                <CopyRow key={c.label} {...c} />
              ))}
            </div>
          ) : null}

          <div className="flex items-center justify-between border-t border-border pt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={stepIndex === 0}
              onClick={() => setStepIndex((i) => Math.max(i - 1, 0))}
            >
              <ChevronLeft className="size-3.5" />
              上一步
            </Button>
            {!isLast ? (
              <Button type="button" size="sm" onClick={goNext}>
                下一步
                <ChevronRight className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </SettingsSection>
  );
}
