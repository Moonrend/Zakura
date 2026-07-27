/**
 * Agent MCP instructions for Host / model context.
 * Makes it explicit that this MCP may and should be called,
 * including re_spawn_subagent for decomposable work.
 *
 * Used by:
 * - initialize / server/discover `instructions`
 * - resources/read zakura://agent/instructions
 */
export type AgentMcpInstructionsOpts = {
  /** Agent slug (path /mcp/agents/:slug) */
  pathSlug: string;
  /** Display name; defaults to slug */
  agentName?: string;
  enableComputer?: boolean;
  enableMemory?: boolean;
  mcpMode?: string;
  /** Whether cloud workspace is exposed via MCP Resources */
  exposeWorkspaceFs?: boolean;
  /**
   * brief: initialize / discover (keep short)
   * full: resource (includes capability flags and FS details)
   */
  detail?: "brief" | "full";
};

/**
 * Build MCP instructions for the AI Host (plain text).
 * Direct and actionable; no marketing fluff.
 */
export function buildAgentMcpInstructions(opts: AgentMcpInstructionsOpts): string {
  const slug = opts.pathSlug || "agent";
  const name = opts.agentName?.trim() || slug;
  const detail = opts.detail ?? "brief";
  const fsOn = opts.exposeWorkspaceFs !== false;

  const lines: string[] = [
    `# Zakura Agent MCP — ${name} (${slug})`,
    "",
    "You are connected to this MCP server. You **may call** its tools / resources / prompts directly. Do not ask the user whether you have permission to use Zakura, and do not claim you cannot access this MCP — you already can.",
    "",
    "## When you must call tools",
    "- Need cloud workspace I/O, shell, browser/computer control, web search/fetch, memory, or bound upstream MCP capabilities: **call tools/call immediately**. Do not pretend you ran something or invent results.",
    "- Independent, parallelizable subtasks that only need a conclusion: **call `re_spawn_subagent`** (multiple calls in the same turn run in parallel).",
    "- Simple chit-chat or questions that need no external environment can be answered directly; otherwise prefer tools for facts.",
    "",
    "## Tool naming",
    "- Platform native tools: `re_*` (e.g. `re_shell_exec`, `re_fs_read`, `re_agent_info`, `re_spawn_subagent`).",
    "- Upstream bound tools: `{instanceSlug}__{toolName}`.",
    "- List tools with `tools/list`, then call by the exact name exposed on this endpoint.",
    "",
    "## Subagent `re_spawn_subagent` (preferred for decomposable subtasks)",
    "- **Purpose**: Spawn an isolated cloud subagent that shares this Agent's workspace and tool surface, and returns only the final result to you.",
    "- **Parameters**:",
    "  - `task` (required): Self-contained goal, scope, and acceptance criteria. The subagent cannot see the current conversation.",
    "  - `context` (optional): Required background, paths, constraints, prior conclusions — the subagent has no memory or chat history.",
    "  - `expected_output` (optional): Desired output format (JSON / bullet list / artifact paths, etc.).",
    "- **Use for**: Parallel research, large exploration, work whose intermediate steps would pollute the main context.",
    "- **Do not use for**: Tasks that need back-and-forth with the user, or that depend on implicit conversational state.",
    "- **After completion**: Integrate the tool result into your reply to the user. Do not ask the user to open another Agent themselves.",
    "- Subagents may spawn further subagents within the nesting depth limit; do not nest for trivial tasks.",
    "",
    "## Resources / Prompts",
    "- Capability overview: `zakura://agent/info`, `zakura://agent/capabilities`, `zakura://agent/instructions` (this document).",
    fsOn
      ? "- Cloud workspace: `zakura://agent/fs/{+path}` (e.g. `zakura://agent/fs/README.md`); reading a directory returns a JSON listing."
      : "- Cloud workspace: not exposed via MCP Resources (enable under Console → Agent → MCP).",
    "- Built-in prompts: `re_agent_briefing`, `re_tool_plan`, `re_safe_exec` (fetch via prompts/get).",
    "",
    "## Async tasks and confirmation",
    "- Long-running or destructive tools may return a **CreateTaskResult** (with a task id).",
    "- Poll with `tasks/get`; when status is `input_required`, submit confirmation/input via `tasks/update`.",
    "- Extensions: `io.modelcontextprotocol/tasks`, `io.modelcontextprotocol/apps`.",
    "",
    "## Safety",
    "- Before irreversible actions (delete, overwrite, send externally), confirm with the user (or use hosted confirm / tasks).",
    "- On tool errors, read the error and adjust; do not silently ignore failures.",
  ];

  if (detail === "full") {
    lines.push(
      "",
      "## This Agent's capability flags",
      `- Computer / FS / Shell: ${opts.enableComputer ? "on" : "off"}`,
      `- Memory: ${opts.enableMemory ? "on" : "off"}`,
      `- MCP binding mode: ${opts.mcpMode ?? "default"}`,
      `- Workspace FS Resources: ${fsOn ? "on" : "off"}`,
    );
  }

  lines.push(
    "",
    "## Bottom line",
    "When you need external capability, call this MCP's tools. For decomposable subtasks, use `re_spawn_subagent` and integrate the result — do not only talk about what you *could* do without calling.",
  );

  return lines.join("\n");
}
