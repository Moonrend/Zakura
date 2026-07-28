"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ThemeToggle } from "@/components/theme-toggle";
import { StepReady } from "@/components/onboarding/step-ready";
import { StepAiProvider } from "@/components/onboarding/step-ai-provider";
import { StepMcpSetup } from "@/components/onboarding/step-mcp-setup";
import { StepAgentConnect } from "@/components/onboarding/step-agent-connect";
import { StepProfileName } from "@/components/onboarding/step-profile-name";
import { Button } from "@/components/ui/button";
import { api, setSession } from "@/lib/api";
import { fetchAgentProviders, saveAgentProviders } from "@/lib/agents";
import { cn } from "@/lib/utils";

const START_PROMPT = "请简要介绍你能为我做什么，以及现在已经具备哪些能力。";

type OnboardingSteps = {
  aiProviderConfigured?: boolean;
  mcpConnected?: boolean;
  connectReady?: boolean;
  agentTried?: boolean;
  profileNamed?: boolean;
};

type BootstrapAgent = {
  id: string;
  name: string;
  slug: string;
  enableComputer: boolean;
  enableMemory: boolean;
  mcpAgentUrl: string;
};

type BootstrapResult = {
  agent: BootstrapAgent;
  completed: boolean;
};

type ProtocolMeta = {
  protocol: string;
  name: string;
};

type ModelUpstream = {
  id: string;
  name: string;
  protocol: string;
  config?: Record<string, unknown>;
  resolvedConfig?: { baseUrl?: string };
  meta?: { name?: string };
};

type OnboardingStep = "choose" | "mcp" | "connect" | "provider" | "name";

export default function TenantOnboardingPage() {
  const router = useRouter();
  const bootstrapOnce = useRef(false);
  const [agent, setAgent] = useState<BootstrapAgent | null>(null);
  const [protocols, setProtocols] = useState<ProtocolMeta[]>([]);
  const [configuredUpstream, setConfiguredUpstream] = useState<ModelUpstream | null>(null);
  const [hasChatModel, setHasChatModel] = useState(false);
  const [step, setStep] = useState<OnboardingStep>("choose");
  const [aiBackStep, setAiBackStep] = useState<"choose" | "connect">("choose");
  const [stepDirection, setStepDirection] = useState<"forward" | "back">("forward");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completionSaved, setCompletionSaved] = useState(false);

  const runBootstrap = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [boot, upstreams, routes] = await Promise.all([
        api<BootstrapResult>("/api/tenant/onboarding/bootstrap", {
          method: "POST",
        }),
        api<{ upstreams: ModelUpstream[]; protocols?: ProtocolMeta[] }>(
          "/api/model-upstreams",
        ).catch(() => ({
          upstreams: [] as ModelUpstream[],
          protocols: [] as ProtocolMeta[],
        })),
        api<{ routes: Array<{ enabled?: boolean; upstream?: ModelUpstream | null }> }>(
          "/api/model-routes?capability=chat",
        ).catch(() => ({
          routes: [] as Array<{ enabled?: boolean; upstream?: ModelUpstream | null }>,
        })),
      ]);

      if (boot.completed) {
        router.replace("/dashboard/agents");
        return;
      }

      setAgent(boot.agent);
      setProtocols(upstreams.protocols ?? []);
      const chatRoute = routes.routes.find((route) => route.enabled !== false);
      setHasChatModel(Boolean(chatRoute));
      setConfiguredUpstream(chatRoute?.upstream ?? null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes("unauthorized") || message.includes("401")) {
        setSession(null);
        router.replace("/login");
        return;
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    if (bootstrapOnce.current) return;
    bootstrapOnce.current = true;
    void runBootstrap();
  }, [runBootstrap]);

  useEffect(() => {
    router.prefetch("/chat");
  }, [router]);

  function moveTo(next: OnboardingStep, direction: "forward" | "back" = "forward") {
    setStepDirection(direction);
    setStep(next);
  }

  const finishOnboarding = useCallback(
    async (steps: OnboardingSteps, destination?: string) => {
      setBusy(true);
      try {
        if (!completionSaved) {
          await api("/api/tenant/onboarding", {
            method: "PATCH",
            json: { steps, complete: true },
          });
          setCompletionSaved(true);
        }
        sessionStorage.setItem("zakura_skip_onboarding", "1");
        if (destination) router.push(destination);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [completionSaved, router],
  );

  const markProgress = useCallback(async (steps: OnboardingSteps) => {
    try {
      await api("/api/tenant/onboarding", {
        method: "PATCH",
        json: { steps },
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <div className="min-h-svh bg-background">
      <header className="mx-auto flex h-10 w-full max-w-5xl items-center justify-between px-5 sm:px-8">
        <span className="text-sm font-semibold tracking-tight">Zakura</span>
        <ThemeToggle />
      </header>

      <main
        className={cn(
          "px-5 pb-6 pt-2 sm:px-8 sm:pt-3",
          !loading && !error && agent && (step === "choose" || step === "name") &&
            "flex min-h-[calc(100svh-2.5rem)] items-center",
        )}
      >
        {loading ? (
          <div className="mx-auto flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            正在准备你的 Agent…
          </div>
        ) : error || !agent ? (
          <div className="mx-auto max-w-sm space-y-4 text-center">
            <div>
              <p className="text-sm font-medium">环境准备失败</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {error ?? "未能获取 Agent 信息"}
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => {
                bootstrapOnce.current = false;
                void runBootstrap();
              }}
            >
              重试
            </Button>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-2xl">
            <div
              key={step}
              className={cn(
                "onboarding-step-enter",
                stepDirection === "back"
                  ? "onboarding-step-enter-back"
                  : "onboarding-step-enter-forward",
              )}
            >
              {step === "choose" ? (
                <StepReady
                  agent={agent}
                  hasChatModel={hasChatModel}
                  busy={busy}
                  onAddMcp={() => moveTo("mcp")}
                  onUseCloudAgent={() => {
                    setAiBackStep("choose");
                    moveTo(hasChatModel ? "name" : "provider");
                  }}
                  onSkip={() => {
                    void finishOnboarding({}, "/dashboard/agents");
                  }}
                />
              ) : step === "mcp" ? (
                <StepMcpSetup
                  busy={busy}
                  onBack={() => moveTo("choose", "back")}
                  onContinue={() => moveTo("connect")}
                  onInstalled={async (instanceIds) => {
                    const options = await fetchAgentProviders(agent.id);
                    const selected = options.mcp.instances
                      .filter((instance) => instance.bound)
                      .map((instance) => instance.id);
                    await saveAgentProviders(agent.id, {
                      mcp: {
                        mode: "selected",
                        instanceIds: [...new Set([...selected, ...instanceIds])],
                      },
                    });
                    await markProgress({ mcpConnected: true });
                  }}
                />
              ) : step === "connect" ? (
                <StepAgentConnect
                  agent={agent}
                  busy={busy}
                  onBack={() => moveTo("mcp", "back")}
                  onConfigured={() => {
                    void markProgress({ connectReady: true });
                  }}
                  nextLabel={hasChatModel ? "下一步：开始对话" : "下一步：配置 AI"}
                  onContinue={() => {
                    void markProgress({ connectReady: true });
                    setAiBackStep("connect");
                    moveTo(hasChatModel ? "name" : "provider");
                  }}
                />
              ) : step === "provider" ? (
                <StepAiProvider
                  protocols={protocols}
                  alreadyConfigured={hasChatModel}
                  initialUpstream={configuredUpstream}
                  busy={busy}
                  onBack={() => moveTo(aiBackStep, "back")}
                  onUpstreamChange={setConfiguredUpstream}
                  onConfigured={() => {
                    setHasChatModel(true);
                    void markProgress({ aiProviderConfigured: true });
                    moveTo("name");
                  }}
                />
              ) : (
                <StepProfileName
                  busy={busy}
                  onBack={() => moveTo("provider", "back")}
                  onContinue={(name) => {
                    const query = new URLSearchParams({
                      agent: agent.id,
                      prompt: `我叫${name}，${START_PROMPT}`,
                    });
                    return finishOnboarding(
                      { profileNamed: true, agentTried: true },
                      `/chat?${query.toString()}`,
                    );
                  }}
                />
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
