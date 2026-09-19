"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type {
  ToolApprovalAiProvider,
  ToolApprovalConfig,
  ToolApprovalPolicy,
  ToolApprovalRule,
  ToolApprovalRuleAction,
} from "@zakura/shared";
import { parseToolApprovalConfig } from "@zakura/shared";
import { getCloudConfig, saveCloudConfig } from "@/lib/cloud-agent";
import { useAgentDetail } from "@/components/agent-detail-context";
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
import { Switch } from "@/components/ui/switch";
import { PageLoading } from "@/components/ui/progress-linear";
import {
  SettingsHeader,
  SettingsRow,
  SettingsSection,
} from "@/components/settings-shell";

const POLICY_OPTIONS: Array<{ value: ToolApprovalPolicy; label: string; hint: string }> = [
  {
    value: "allow_all",
    label: "自动允许（默认）",
    hint: "Codex「Full Access」式：所有工具调用直接执行，不做拦截。",
  },
  {
    value: "ask",
    label: "每次询问",
    hint: "只读工具自动放行，其余调用等你确认（Claude Code 默认式）。",
  },
  {
    value: "ai",
    label: "AI 审批",
    hint: "AI 门控判定每个调用，置信度不足或建议拒绝时转人工。",
  },
];

const RULE_ACTIONS: Array<{ value: ToolApprovalRuleAction; label: string }> = [
  { value: "allow", label: "允许" },
  { value: "ask", label: "询问" },
  { value: "deny", label: "拒绝" },
];

const CONFIDENCE_OPTIONS = ["0.5", "0.6", "0.7", "0.8", "0.9"] as const;

export default function AgentApprovalsPage() {
  const { id } = useAgentDetail();
  const params = useParams<{ id: string }>();
  const agentId = id ?? params?.id;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<ToolApprovalConfig>({});
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyStored, setApiKeyStored] = useState("");

  useEffect(() => {
    if (!agentId) return;
    let alive = true;
    (async () => {
      try {
        const result = await getCloudConfig(agentId);
        if (!alive) return;
        const approvals = parseToolApprovalConfig(result.cloud.approvals);
        setConfig(approvals);
        setApiKeyStored(approvals.aiGate?.jevApiKey ?? "");
      } catch (err) {
        if (alive) toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [agentId]);

  async function persist(next: ToolApprovalConfig) {
    if (!agentId) return;
    setSaving(true);
    try {
      await saveCloudConfig(agentId, { approvals: next });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function update(patch: (prev: ToolApprovalConfig) => ToolApprovalConfig) {
    setConfig((prev) => {
      const next = patch(prev);
      void persist(next);
      return next;
    });
  }

  if (loading) return <PageLoading />;

  const policy = config.policy ?? "allow_all";
  const policyHint = POLICY_OPTIONS.find((p) => p.value === policy)?.hint ?? "";
  const gate = config.aiGate ?? {};
  const provider: ToolApprovalAiProvider = gate.provider ?? (gate.llmModel ? "llm" : "jev");
  const threshold = String(gate.confidenceThreshold ?? 0.7);
  const rules = config.rules ?? [];
  const alwaysAllow = config.alwaysAllow ?? [];
  const alwaysDeny = config.alwaysDeny ?? [];

  function patchGate(patch: Partial<NonNullable<ToolApprovalConfig["aiGate"]>>) {
    update((prev) => ({
      ...prev,
      aiGate: { ...prev.aiGate, ...patch },
    }));
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="工具审批"
        description="Codex / Claude Code 式工具调用审批：策略、AI 门控与规则"
      />

      <SettingsSection title="审批策略" description={policyHint}>
        <SettingsRow label="策略" description={policyHint}>
          <Select
            value={policy}
            onValueChange={(v) => {
              if (v !== "allow_all" && v !== "ask" && v !== "ai") return;
              update((prev) => ({ ...prev, policy: v }));
            }}
            items={POLICY_OPTIONS.map((p) => ({ value: p.value, label: p.label }))}
          >
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {POLICY_OPTIONS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="人工审批超时"
          description="等待用户确认的最长时间，超时自动拒绝；0 表示不限时"
        >
          <Input
            type="number"
            min={0}
            defaultValue={String(config.askTimeoutSeconds ?? 300)}
            className="w-28"
            onBlur={(e) => {
              const n = Number(e.target.value);
              const seconds = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
              update((prev) => ({ ...prev, askTimeoutSeconds: seconds || undefined }));
            }}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="AI 审批门控"
        description="策略为「AI 审批」时生效。JEV 是 TypeSafe 的 System One 决策模型（毫秒级、返回概率）；传统模型走模型路由由 LLM 判断。"
      >
        <SettingsRow label="审批模型" description="决定由谁评估工具调用">
          <Select
            value={provider}
            onValueChange={(v) => {
              if (v !== "jev" && v !== "llm") return;
              patchGate({ provider: v });
            }}
            items={[
              { value: "jev", label: "JEV（System One）" },
              { value: "llm", label: "传统模型（LLM）" },
            ]}
          >
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="jev">JEV（System One）</SelectItem>
              <SelectItem value="llm">传统模型（LLM）</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        {provider === "jev" ? (
          <>
            <SettingsRow label="评估路由 alias" description="优先级最高：在「模型路由」为 typesafe 上游建 evaluation 路由后填 alias；留空则按 API Key → 路由默认 → 环境变量 TYPESAFE_API_KEY">
              <Input
                defaultValue={gate.routeAlias ?? ""}
                placeholder="例如 jev-latest"
                className="w-52 font-mono text-xs"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  patchGate(v ? { routeAlias: v } : { routeAlias: undefined });
                }}
              />
            </SettingsRow>
            <SettingsRow label="JEV 模型" description="默认 jev-latest">
              <Input
                defaultValue={gate.jevModel ?? ""}
                placeholder="jev-latest"
                className="w-52 font-mono text-xs"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  patchGate(v ? { jevModel: v } : { jevModel: undefined });
                }}
              />
            </SettingsRow>
            <SettingsRow label="API Base" description="默认 https://api.typesafe.ai">
              <Input
                defaultValue={gate.jevBaseUrl ?? ""}
                placeholder="https://api.typesafe.ai"
                className="w-64 font-mono text-xs"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  patchGate(v ? { jevBaseUrl: v } : { jevBaseUrl: undefined });
                }}
              />
            </SettingsRow>
            <SettingsRow label="API Key" description="直连 Key（优先于模型路由）；留空则按 路由 → 环境变量 TYPESAFE_API_KEY">
              <Input
                type="password"
                autoComplete="new-password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder={apiKeyStored ? "••••••••（保持不变）" : "粘贴 TypeSafe API Key"}
                className="w-64 font-mono text-xs"
                onBlur={() => {
                  if (!apiKeyInput.trim()) return;
                  patchGate({ jevApiKey: apiKeyInput.trim() });
                  setApiKeyStored(apiKeyInput.trim());
                  setApiKeyInput("");
                  toast.success("JEV API Key 已保存");
                }}
              />
            </SettingsRow>
          </>
        ) : (
          <SettingsRow label="模型 alias" description="用于审批判断的模型路由 alias（在 AI Gateway 页配置）">
            <Input
              defaultValue={gate.llmModel ?? ""}
              placeholder="例如 gpt-5-mini"
              className="w-52 font-mono text-xs"
              onBlur={(e) => {
                const v = e.target.value.trim();
                patchGate(v ? { llmModel: v } : { llmModel: undefined });
              }}
            />
          </SettingsRow>
        )}
        <SettingsRow
          label="置信度阈值"
          description="低于该值时升级人工审批（TypeSafe 推荐的低置信度路由模式）"
        >
          <Select
            value={threshold}
            onValueChange={(v) => {
              const n = Number(v);
              if (!Number.isFinite(n)) return;
              patchGate({ confidenceThreshold: n });
            }}
            items={CONFIDENCE_OPTIONS.map((v) => ({ value: v, label: `${Math.round(Number(v) * 100)}%` }))}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONFIDENCE_OPTIONS.map((v) => (
                <SelectItem key={v} value={v}>
                  {Math.round(Number(v) * 100)}%
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label="拒绝时转人工" description="关闭后 AI 高置信度拒绝会直接拒绝，不再询问用户">
          <Switch
            checked={gate.escalateOnDeny !== false}
            onCheckedChange={(v) => patchGate({ escalateOnDeny: v })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="匹配规则"
        description="优先级高于策略。匹配语法与 Claude 钩子一致：Bash(git push*)、web_*、*；按顺序取第一个命中的规则。"
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const rule: ToolApprovalRule = {
                id: `r${Date.now()}`,
                matcher: "",
                action: "ask",
              };
              update((prev) => ({ ...prev, rules: [...(prev.rules ?? []), rule] }));
            }}
          >
            <Plus className="size-4" />
            添加规则
          </Button>
        }
      >
        {rules.length === 0 ? (
          <p className="text-xs text-muted-foreground">还没有规则，全部由策略决定。</p>
        ) : (
          <div className="space-y-2">
            {rules.map((rule, index) => (
              <div key={rule.id} className="flex flex-wrap items-center gap-2">
                <span className="w-5 text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                <Input
                  defaultValue={rule.matcher}
                  placeholder="Bash(git push*)"
                  className="w-56 font-mono text-xs"
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    update((prev) => ({
                      ...prev,
                      rules: (prev.rules ?? []).map((r) =>
                        r.id === rule.id ? { ...r, matcher: v || "*" } : r,
                      ),
                    }));
                  }}
                />
                <Select
                  value={rule.action}
                  onValueChange={(v) => {
                    if (v !== "allow" && v !== "ask" && v !== "deny") return;
                    update((prev) => ({
                      ...prev,
                      rules: (prev.rules ?? []).map((r) =>
                        r.id === rule.id ? { ...r, action: v } : r,
                      ),
                    }));
                  }}
                  items={RULE_ACTIONS}
                >
                  <SelectTrigger className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RULE_ACTIONS.map((a) => (
                      <SelectItem key={a.value} value={a.value}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() =>
                    update((prev) => ({
                      ...prev,
                      rules: (prev.rules ?? []).filter((r) => r.id !== rule.id),
                    }))
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="记住的允许 / 拒绝" description="审批卡上点「总是允许」会累积在这里">
        <div className="space-y-2">
          <MatcherChips
            label="总是允许"
            matchers={alwaysAllow}
            onRemove={(matcher) =>
              update((prev) => ({
                ...prev,
                alwaysAllow: (prev.alwaysAllow ?? []).filter((m) => m !== matcher),
              }))
            }
            onClear={() => update((prev) => ({ ...prev, alwaysAllow: [] }))}
          />
          <MatcherChips
            label="总是拒绝"
            matchers={alwaysDeny}
            onRemove={(matcher) =>
              update((prev) => ({
                ...prev,
                alwaysDeny: (prev.alwaysDeny ?? []).filter((m) => m !== matcher),
              }))
            }
            onClear={() => update((prev) => ({ ...prev, alwaysDeny: [] }))}
          />
        </div>
      </SettingsSection>

      <p className="text-xs text-muted-foreground">
        {saving ? "保存中…" : "更改即时保存"}
      </p>
    </div>
  );
}

function MatcherChips({
  label,
  matchers,
  onRemove,
  onClear,
}: {
  label: string;
  matchers: string[];
  onRemove: (matcher: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label className="text-xs">{label}</Label>
        {matchers.length > 0 ? (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onClear}>
            清空全部
          </Button>
        ) : null}
      </div>
      {matchers.length === 0 ? (
        <p className="text-xs text-muted-foreground">暂无</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {matchers.map((matcher) => (
            <span
              key={matcher}
              className="inline-flex items-center gap-1 rounded-full border bg-muted/40 py-0.5 pr-1 pl-2.5 font-mono text-xs"
            >
              {matcher}
              <button
                type="button"
                onClick={() => onRemove(matcher)}
                className="rounded-full px-1 text-muted-foreground transition-colors duration-150 ease-fluid hover:text-destructive"
                aria-label={`移除 ${matcher}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
