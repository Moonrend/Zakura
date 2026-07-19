"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { api, setSession } from "@/lib/api";
import {
  OnboardingWizardShell,
  type WizardStepMeta,
} from "@/components/onboarding/wizard-shell";
import {
  StepCreateAgent,
  type OnboardingAgent,
} from "@/components/onboarding/step-agent";
import { StepComputerEnv } from "@/components/onboarding/step-computer";
import { StepMemory } from "@/components/onboarding/step-memory";
import { StepMcpConnect } from "@/components/onboarding/step-mcp";
import { StepConnect } from "@/components/onboarding/step-connect";

type OnboardingState = {
  completed: boolean;
  steps: {
    agentCreated?: boolean;
    computerEnabled?: boolean;
    memoryConfigured?: boolean;
    mcpConnected?: boolean;
    connectReady?: boolean;
  };
};

const WIZARD_STEPS: WizardStepMeta[] = [
  {
    id: "agentCreated",
    title: "创建 Agent",
    description: "后续能力都挂在这个工作单元上。",
  },
  {
    id: "computerEnabled",
    title: "启用电脑环境",
    description: "可选。SaaS 下请注册远程 Runner。",
    optional: true,
  },
  {
    id: "memoryConfigured",
    title: "配置记忆",
    description: "可选。默认 Built-in 即可。",
    optional: true,
  },
  {
    id: "mcpConnected",
    title: "接入 MCP",
    description: "一键授权 Notion、GitHub 等远程工具。",
  },
  {
    id: "connectReady",
    title: "完成接入",
    description: "在客户端用 OAuth 连接 Zakura MCP。",
  },
];

type StepId = keyof OnboardingState["steps"];

export default function TenantOnboardingPage() {
  const router = useRouter();
  const [state, setState] = useState<OnboardingState | null>(null);
  const [agents, setAgents] = useState<OnboardingAgent[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [onboarding, agentList] = await Promise.all([
        api<OnboardingState>("/api/tenant/onboarding"),
        api<OnboardingAgent[]>("/api/agents").catch(() => [] as OnboardingAgent[]),
      ]);
      setState(onboarding);
      setAgents(agentList);
      if (onboarding.completed) {
        router.replace("/dashboard/agents");
        return;
      }
      const steps = {
        ...onboarding.steps,
        ...(agentList.length > 0 ? { agentCreated: true as const } : {}),
      };
      if (agentList.length > 0 && !onboarding.steps.agentCreated) {
        void api<OnboardingState>("/api/tenant/onboarding", {
          method: "PATCH",
          json: { steps: { agentCreated: true } },
        }).then(setState);
      }
      const firstPending = WIZARD_STEPS.findIndex((s) => !steps[s.id as StepId]);
      if (firstPending >= 0) setCurrentIndex(firstPending);
    } catch {
      setSession(null);
      router.replace("/login");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function markStep(step: StepId) {
    try {
      const next = await api<OnboardingState>("/api/tenant/onboarding", {
        method: "PATCH",
        json: { steps: { [step]: true } },
      });
      setState(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function markAndNext(step: StepId) {
    await markStep(step);
    setCurrentIndex((i) => Math.min(WIZARD_STEPS.length - 1, i + 1));
  }

  const doneMap = useMemo(() => {
    const map: Record<string, boolean> = {};
    if (!state) return map;
    for (const s of WIZARD_STEPS) map[s.id] = !!state.steps[s.id as StepId];
    return map;
  }, [state]);

  const stepId = WIZARD_STEPS[currentIndex]?.id as StepId | undefined;
  const firstAgentId = agents[0]?.id ?? null;

  // MCP：装完一个后显示「下一步」；已有 MCP 也可前进
  const showNext =
    stepId === "mcpConnected" && !!state?.steps.mcpConnected;

  if (loading || !state) {
    return (
      <div className="grid min-h-svh place-items-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <OnboardingWizardShell
      steps={WIZARD_STEPS}
      currentIndex={currentIndex}
      doneMap={doneMap}
      busy={busy}
      showNext={showNext}
      onSelectStep={setCurrentIndex}
      onBack={() => setCurrentIndex((i) => Math.max(0, i - 1))}
      onNext={() => {
        if (stepId && WIZARD_STEPS[currentIndex]?.optional) {
          void markAndNext(stepId);
          return;
        }
        setCurrentIndex((i) => Math.min(WIZARD_STEPS.length - 1, i + 1));
      }}
      onSkipAll={() => {
        sessionStorage.setItem("zakura_skip_onboarding", "1");
        router.push("/dashboard/agents");
      }}
      onComplete={() => {
        void (async () => {
          setBusy(true);
          try {
            await api("/api/tenant/onboarding", {
              method: "PATCH",
              json: { steps: { connectReady: true } },
            });
            await api("/api/tenant/onboarding/complete", { method: "POST" });
            sessionStorage.setItem("zakura_skip_onboarding", "1");
            toast.success("引导完成");
            router.push("/dashboard/agents");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      {stepId === "agentCreated" ? (
        <StepCreateAgent
          agents={agents}
          onDone={(agent) => {
            setAgents((prev) =>
              prev.some((a) => a.id === agent.id) ? prev : [agent, ...prev],
            );
            void markAndNext("agentCreated");
          }}
        />
      ) : null}

      {stepId === "computerEnabled" ? (
        <StepComputerEnv
          agentId={firstAgentId}
          onDone={() => void markAndNext("computerEnabled")}
        />
      ) : null}

      {stepId === "memoryConfigured" ? (
        <StepMemory
          agentId={firstAgentId}
          onDone={() => void markAndNext("memoryConfigured")}
        />
      ) : null}

      {stepId === "mcpConnected" ? (
        <StepMcpConnect onDone={() => void markStep("mcpConnected")} />
      ) : null}

      {stepId === "connectReady" ? <StepConnect agentId={firstAgentId} /> : null}
    </OnboardingWizardShell>
  );
}
