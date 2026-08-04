/**
 * Agent hooks 执行器：读取 agent.configJson.hooks，在会话/工具生命周期触发。
 * command 型需 Agent 开启电脑；prompt 型直接注入上下文。
 */
import {
  matcherHits,
  parseAgentHookPackages,
  type AgentHookAction,
  type AgentHookEvent,
  type AgentHookPackage,
  type AgentHooksByEvent,
} from "@zakura/shared";
import type { Agent } from "../db/schema.js";
import { parseAgentConfig } from "./agent-providers.js";
import type { AgentWorkspaceService } from "./agent-workspace.js";

export type HookRunResult = {
  ok: boolean;
  /** PreToolUse deny */
  deny?: boolean;
  reason?: string;
  /** SessionStart / UserPromptSubmit 注入文本 */
  injectText?: string;
  stdout?: string;
};

function substituteRoot(command: string, pluginRoot?: string): string {
  const root = pluginRoot ?? ".";
  return command
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", root)
    .replaceAll("${ZAKURA_PLUGIN_ROOT}", root)
    .replaceAll("${CLAUDE_PROJECT_DIR}", ".");
}

export function getAgentHookPackages(agent: Agent): AgentHookPackage[] {
  const cfg = parseAgentConfig(agent);
  return parseAgentHookPackages(cfg.hooks).filter((p) => p.enabled);
}

function matchingActions(
  packages: AgentHookPackage[],
  event: AgentHookEvent,
  toolName?: string,
): Array<{ action: AgentHookAction; pluginRoot?: string; packageName: string }> {
  const out: Array<{ action: AgentHookAction; pluginRoot?: string; packageName: string }> = [];
  for (const pkg of packages) {
    const groups = pkg.events[event] ?? [];
    for (const group of groups) {
      if (toolName != null && !matcherHits(group.matcher, toolName)) continue;
      for (const action of group.hooks) {
        out.push({ action, pluginRoot: pkg.pluginRoot, packageName: pkg.name });
      }
    }
  }
  return out;
}

export class AgentHooksService {
  constructor(private readonly workspace?: AgentWorkspaceService | null) {}

  async runEvent(
    agent: Agent,
    event: AgentHookEvent,
    opts?: {
      toolName?: string;
      toolArgs?: Record<string, unknown>;
      toolResultText?: string;
      isError?: boolean;
      userPrompt?: string;
    },
  ): Promise<HookRunResult[]> {
    const packages = getAgentHookPackages(agent);
    const actions = matchingActions(packages, event, opts?.toolName);
    const results: HookRunResult[] = [];
    for (const { action, pluginRoot } of actions) {
      results.push(await this.runAction(agent, action, pluginRoot, opts));
    }
    return results;
  }

  private async runAction(
    agent: Agent,
    action: AgentHookAction,
    pluginRoot: string | undefined,
    opts?: {
      toolName?: string;
      toolArgs?: Record<string, unknown>;
      toolResultText?: string;
      isError?: boolean;
      userPrompt?: string;
    },
  ): Promise<HookRunResult> {
    if (action.type === "prompt" && action.prompt?.trim()) {
      return { ok: true, injectText: action.prompt.trim() };
    }
    if (action.type !== "command" || !action.command?.trim()) {
      return { ok: true };
    }
    if (!agent.enableComputer || !this.workspace) {
      return {
        ok: false,
        reason: "command hook 需要 Agent 开启电脑环境",
      };
    }
    const cmd = substituteRoot(action.command, pluginRoot);
    const timeoutMs = action.timeoutMs ?? 30_000;
    try {
      const exec = await this.workspace.execInWorkspace(
        agent,
        ["bash", "-lc", cmd],
        {
          timeoutMs,
          env: {
            ZAKURA_HOOK_TOOL: opts?.toolName ?? "",
            ZAKURA_HOOK_ARGS: opts?.toolArgs ? JSON.stringify(opts.toolArgs) : "",
            ZAKURA_HOOK_RESULT: opts?.toolResultText?.slice(0, 8000) ?? "",
            ZAKURA_HOOK_ERROR: opts?.isError ? "1" : "0",
            ZAKURA_HOOK_PROMPT: opts?.userPrompt?.slice(0, 4000) ?? "",
          },
        },
      );
      const stdout = `${exec.stdout ?? ""}${exec.stderr ?? ""}`.trim();
      // Claude PreToolUse：stdout JSON { decision: "deny"|"allow", reason }
      let deny = false;
      let reason: string | undefined;
      let injectText: string | undefined;
      if (stdout.startsWith("{")) {
        try {
          const parsed = JSON.parse(stdout) as Record<string, unknown>;
          if (parsed.decision === "deny" || parsed.permissionDecision === "deny") {
            deny = true;
            reason = typeof parsed.reason === "string" ? parsed.reason : "hook denied";
          }
          if (typeof parsed.additionalContext === "string") injectText = parsed.additionalContext;
          if (typeof parsed.systemMessage === "string") injectText = parsed.systemMessage;
        } catch {
          /* plain stdout */
        }
      }
      if (exec.exitCode !== 0 && !deny) {
        return { ok: false, reason: stdout || `exit ${exec.exitCode}`, stdout };
      }
      return { ok: true, deny, reason, injectText, stdout: stdout || undefined };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export function collectInjectText(results: HookRunResult[]): string {
  return results
    .map((r) => r.injectText)
    .filter((t): t is string => !!t?.trim())
    .join("\n\n");
}

export function firstDeny(results: HookRunResult[]): HookRunResult | undefined {
  return results.find((r) => r.deny);
}

export function hooksPackageFromPlugin(input: {
  pluginName: string;
  source: string;
  events: AgentHooksByEvent;
  pluginRoot?: string;
}): AgentHookPackage {
  return {
    id: `plugin:${input.pluginName}`,
    name: input.pluginName,
    source: input.source,
    enabled: true,
    events: input.events,
    pluginRoot: input.pluginRoot,
  };
}
