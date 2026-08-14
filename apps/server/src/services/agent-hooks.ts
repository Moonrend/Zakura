/**
 * Agent hooks 执行器：读取 agent.configJson.hooks + 项目 extraPackages，
 * 在会话/工具生命周期触发。command 型对齐 Claude：stdin JSON、exit 2 拦截。
 */
import {
  hookIfHits,
  hookStdinToolName,
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

export type HookRunOpts = {
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResultText?: string;
  isError?: boolean;
  userPrompt?: string;
  extraPackages?: AgentHookPackage[];
  workingDir?: string;
  sessionId?: string;
  lastAssistantMessage?: string;
  /** Stop/PreCompact 等：matcher 比的不是工具名 */
  matcherValue?: string;
};

export type HookRunResult = {
  ok: boolean;
  /** PreToolUse / UserPromptSubmit deny */
  deny?: boolean;
  reason?: string;
  /** 注入模型上下文 */
  injectText?: string;
  stdout?: string;
};

function substituteRoot(command: string, pluginRoot?: string, projectDir?: string): string {
  const root = pluginRoot ?? ".";
  const project = projectDir ?? ".";
  return command
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", root)
    .replaceAll("${ZAKURA_PLUGIN_ROOT}", root)
    .replaceAll("${CLAUDE_PROJECT_DIR}", project)
    .replaceAll("${ZAKURA_PROJECT_DIR}", project);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function tryParseJson(raw: string): Record<string, unknown> | null {
  const t = raw.trim();
  if (!t.startsWith("{")) return null;
  try {
    return asRecord(JSON.parse(t));
  } catch {
    return null;
  }
}

export function hookStdinPayload(event: AgentHookEvent, opts?: HookRunOpts): string {
  const cwd = opts?.workingDir || "/workspace";
  const body: Record<string, unknown> = {
    hook_event_name: event,
    cwd,
    permission_mode: "bypassPermissions",
  };
  if (opts?.sessionId) body.session_id = opts.sessionId;
  if (opts?.toolName) {
    body.tool_name = hookStdinToolName(opts.toolName);
    body.tool_input = opts.toolArgs ?? {};
  }
  if (opts?.toolResultText != null) {
    body.tool_response = { result: opts.toolResultText.slice(0, 8000) };
  }
  if (opts?.userPrompt != null) body.user_prompt = opts.userPrompt.slice(0, 4000);
  if (opts?.lastAssistantMessage != null) {
    body.last_assistant_message = opts.lastAssistantMessage.slice(0, 8000);
  }
  return JSON.stringify(body);
}

/** 解析 command hook 的 stdout / exit code（Claude 兼容） */
export function parseHookCommandOutput(
  event: AgentHookEvent,
  stdoutRaw: string,
  stderrRaw: string,
  exitCode: number,
): HookRunResult {
  const stdout = stdoutRaw.trim();
  const stderr = stderrRaw.trim();
  const json = tryParseJson(stdout);
  const specific = asRecord(json?.hookSpecificOutput) ?? json;
  let deny = false;
  let reason: string | undefined;
  let injectText: string | undefined;
  if (json) {
    const decision =
      json.decision ?? json.permissionDecision ?? specific?.permissionDecision ?? specific?.decision;
    if (decision === "deny" || decision === "block") {
      deny = true;
      reason =
        str(json.reason) ??
        str(json.permissionDecisionReason) ??
        str(specific?.permissionDecisionReason) ??
        str(specific?.reason) ??
        "hook denied";
    }
    if (json.continue === false && (event === "Stop" || event === "PreCommit")) {
      deny = true;
      reason = reason ?? str(json.stopReason) ?? str(json.reason) ?? "hook requested continue";
    }
    injectText =
      str(json.additionalContext) ??
      str(specific?.additionalContext) ??
      str(json.systemMessage) ??
      str(specific?.systemMessage);
  }
  if (exitCode === 2) {
    deny =
      event === "PreToolUse" ||
      event === "UserPromptSubmit" ||
      event === "Stop" ||
      event === "PreCommit" ||
      event === "PreCompact";
    reason = reason ?? (stderr || stdout || "hook blocked (exit 2)");
  } else if (
    !json &&
    (event === "SessionStart" || event === "UserPromptSubmit") &&
    stdout
  ) {
    injectText = injectText ?? stdout;
  }
  if (exitCode !== 0 && exitCode !== 2 && !deny) {
    return { ok: false, reason: stderr || stdout || `exit ${exitCode}`, stdout: stdout || undefined, injectText };
  }
  return { ok: true, deny, reason, injectText, stdout: stdout || undefined };
}

export function getAgentHookPackages(agent: Agent): AgentHookPackage[] {
  const cfg = parseAgentConfig(agent);
  return parseAgentHookPackages(cfg.hooks).filter((p) => p.enabled);
}

function matchingActions(
  packages: AgentHookPackage[],
  event: AgentHookEvent,
  toolName?: string,
  toolArgs?: Record<string, unknown>,
  matcherValue?: string,
): Array<{ action: AgentHookAction; pluginRoot?: string; packageName: string }> {
  const out: Array<{ action: AgentHookAction; pluginRoot?: string; packageName: string }> = [];
  const matchAgainst = matcherValue ?? toolName;
  for (const pkg of packages) {
    const groups = pkg.events[event] ?? [];
    for (const group of groups) {
      if (matchAgainst != null && !matcherHits(group.matcher, matchAgainst)) continue;
      for (const action of group.hooks) {
        if (toolName != null && !hookIfHits(action.if, toolName, toolArgs)) continue;
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
    opts?: HookRunOpts,
  ): Promise<HookRunResult[]> {
    const packages = [...getAgentHookPackages(agent), ...(opts?.extraPackages ?? [])];
    const actions = matchingActions(
      packages,
      event,
      opts?.toolName,
      opts?.toolArgs,
      opts?.matcherValue,
    );
    const results: HookRunResult[] = [];
    for (const { action, pluginRoot } of actions) {
      results.push(await this.runAction(agent, event, action, pluginRoot, opts));
    }
    return results;
  }

  private async runAction(
    agent: Agent,
    event: AgentHookEvent,
    action: AgentHookAction,
    pluginRoot: string | undefined,
    opts?: HookRunOpts,
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
    const cmd = substituteRoot(action.command, pluginRoot, opts?.workingDir);
    const timeoutMs = action.timeoutMs ?? 30_000;
    const stdin = hookStdinPayload(event, opts);
    try {
      const exec = await this.workspace.execInWorkspace(
        agent,
        ["bash", "-lc", `printf '%s\\n' "$ZAKURA_HOOK_STDIN" | eval "$ZAKURA_HOOK_CMD"`],
        {
          timeoutMs,
          ...(opts?.workingDir ? { workingDir: opts.workingDir } : {}),
          env: {
            ZAKURA_HOOK_STDIN: stdin,
            ZAKURA_HOOK_CMD: cmd,
            ZAKURA_HOOK_TOOL: opts?.toolName ?? "",
            ZAKURA_HOOK_ARGS: opts?.toolArgs ? JSON.stringify(opts.toolArgs) : "",
            ZAKURA_HOOK_RESULT: opts?.toolResultText?.slice(0, 8000) ?? "",
            ZAKURA_HOOK_ERROR: opts?.isError ? "1" : "0",
            ZAKURA_HOOK_PROMPT: opts?.userPrompt?.slice(0, 4000) ?? "",
            CLAUDE_PROJECT_DIR: opts?.workingDir ?? "",
            ZAKURA_PROJECT_DIR: opts?.workingDir ?? "",
          },
        },
      );
      return parseHookCommandOutput(event, exec.stdout ?? "", exec.stderr ?? "", exec.exitCode);
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
