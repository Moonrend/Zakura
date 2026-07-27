/**
 * Zakura Agent platform-owned MCP resources / prompts / resource templates.
 *
 * Resources (resources/list): concrete URIs the client can resources/read.
 * Resource Templates (resources/templates/list): RFC 6570 templates; fill params then read.
 * Example: template zakura://agent/fs/{+path} → concrete zakura://agent/fs/src/main.ts
 */
import type { WorkspaceFs } from "@zakura/core";
import type {
  McpGetPromptResult,
  McpPromptDef,
  McpReadResourceResult,
  McpResourceDef,
  McpResourceTemplateDef,
} from "@zakura/shared";
import type { Agent } from "../db/schema.js";
import { buildAgentMcpInstructions } from "../mcp/instructions.js";
import {
  getAgentMcpMode,
  getAgentProviders,
  isWorkspaceFsExposedViaMcp,
} from "./agent-providers.js";
import { isComputerEnvEnabled } from "./agent-caps.js";

export const AGENT_NATIVE_PROVIDER_ID = "zakura-agent";

const RESOURCE_INFO = "zakura://agent/info";
const RESOURCE_CAPABILITIES = "zakura://agent/capabilities";
const RESOURCE_INSTRUCTIONS = "zakura://agent/instructions";

export const FS_URI_PREFIX = "zakura://agent/fs";
export const FS_URI_TEMPLATE = "zakura://agent/fs/{+path}";

const FS_LIST_LIMIT = 200;

/** Platform fixed resources (excludes workspace file enumeration) */
export function listAgentNativeResources(agent: Agent): McpResourceDef[] {
  void agent;
  return [
    {
      uri: RESOURCE_INFO,
      name: "agent-info",
      title: "Agent info",
      description: "This Agent's id / slug / capability flags and workspace overview (JSON)",
      mimeType: "application/json",
    },
    {
      uri: RESOURCE_CAPABILITIES,
      name: "agent-capabilities",
      title: "Agent capabilities",
      description: "MCP / Computer / Memory / Web capabilities and binding mode",
      mimeType: "application/json",
    },
    {
      uri: RESOURCE_INSTRUCTIONS,
      name: "agent-instructions",
      title: "Agent usage instructions",
      description:
        "Host/model guidance: call this MCP's tools directly (including re_spawn_subagent); no extra permission check needed",
      mimeType: "text/plain",
    },
  ];
}

/** Workspace Resource Template (on by default; off when exposeWorkspaceFs === false) */
export function listAgentNativeResourceTemplates(agent: Agent): McpResourceTemplateDef[] {
  if (!isWorkspaceFsExposedViaMcp(agent)) return [];
  return [
    {
      uriTemplate: FS_URI_TEMPLATE,
      name: "workspace-fs",
      title: "Cloud workspace files",
      description:
        "Read any path in the Agent cloud workspace. Replace {+path} with a relative path, e.g. src/app.ts → zakura://agent/fs/src/app.ts; directories return a JSON listing.",
      mimeType: "text/plain",
    },
  ];
}

/**
 * Enumerate top-level workspace entries as concrete Resources (list/read directly).
 * Use the Resource Template for deeper paths.
 */
export async function listWorkspaceFsResources(
  fs: WorkspaceFs,
): Promise<McpResourceDef[]> {
  const out: McpResourceDef[] = [
    {
      uri: `${FS_URI_PREFIX}/`,
      name: "workspace-root",
      title: "Workspace root",
      description:
        "Cloud workspace root listing (JSON). For deeper files use template zakura://agent/fs/{+path}",
      mimeType: "application/json",
    },
  ];

  try {
    const listed = await fs.list("/", { recursive: false, limit: FS_LIST_LIMIT });
    for (const e of listed.entries) {
      if (out.length >= FS_LIST_LIMIT + 1) break;
      const rel = e.name.replace(/^\/+/, "");
      if (!rel || rel === "." || rel === "..") continue;
      const uri = `${FS_URI_PREFIX}/${encodeFsPath(rel)}`;
      out.push({
        uri,
        name: rel,
        title: rel,
        description:
          e.type === "dir"
            ? `Workspace directory /${rel} (read returns child JSON)`
            : `Workspace file /${rel}`,
        mimeType: e.type === "dir" ? "application/json" : guessMime(rel),
      });
    }
  } catch (err) {
    console.warn(
      `[mcp] listWorkspaceFsResources:`,
      err instanceof Error ? err.message : err,
    );
  }

  return out;
}

export function isAgentNativeResourceUri(uri: string): boolean {
  return uri.startsWith("zakura://agent/");
}

export function isWorkspaceFsResourceUri(uri: string): boolean {
  return uri === FS_URI_PREFIX || uri.startsWith(`${FS_URI_PREFIX}/`);
}

/** zakura://agent/fs[/path] → workspace-relative path (leading /) */
export function parseWorkspaceFsUri(uri: string): string | null {
  if (!isWorkspaceFsResourceUri(uri)) return null;
  if (uri === FS_URI_PREFIX || uri === `${FS_URI_PREFIX}/`) return "/";
  const raw = uri.slice(`${FS_URI_PREFIX}/`.length);
  try {
    const decoded = decodeURIComponent(raw);
    const cleaned = decoded.replace(/^\/+/, "");
    return cleaned ? `/${cleaned}` : "/";
  } catch {
    return null;
  }
}

function encodeFsPath(rel: string): string {
  return rel
    .split("/")
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join("/");
}

function guessMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "text/javascript";
  }
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "text/typescript";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (/\.(png|jpe?g|gif|webp|ico)$/i.test(lower)) return "application/octet-stream";
  return "text/plain";
}

export function readAgentNativeResource(
  agent: Agent,
  uri: string,
): McpReadResourceResult | null {
  if (!isAgentNativeResourceUri(uri) || isWorkspaceFsResourceUri(uri)) return null;

  if (uri === RESOURCE_INFO) {
    const body = {
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      enableComputer: !!agent.enableComputer,
      enableMemory: !!agent.enableMemory,
      mcpMode: getAgentMcpMode(agent),
      providers: getAgentProviders(agent),
      computerEnv: isComputerEnvEnabled(agent),
      exposeWorkspaceFs: isWorkspaceFsExposedViaMcp(agent),
    };
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(body, null, 2),
        },
      ],
    };
  }

  if (uri === RESOURCE_CAPABILITIES) {
    const body = {
      tools: true,
      resources: true,
      resourceTemplates: isWorkspaceFsExposedViaMcp(agent),
      prompts: true,
      completions: true,
      tasks: true,
      ping: true,
      native: {
        resources: listAgentNativeResources(agent).map((r) => r.uri),
        resourceTemplates: listAgentNativeResourceTemplates(agent).map((t) => t.uriTemplate),
        prompts: listAgentNativePrompts(agent).map((p) => p.name),
      },
      mcp: {
        mode: getAgentMcpMode(agent),
        providers: getAgentProviders(agent),
      },
    };
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(body, null, 2),
        },
      ],
    };
  }

  if (uri === RESOURCE_INSTRUCTIONS) {
    const text = buildAgentMcpInstructions({
      pathSlug: agent.slug,
      agentName: agent.name,
      enableComputer: !!agent.enableComputer,
      enableMemory: !!agent.enableMemory,
      mcpMode: getAgentMcpMode(agent),
      exposeWorkspaceFs: isWorkspaceFsExposedViaMcp(agent),
      detail: "full",
    });
    return {
      contents: [{ uri, mimeType: "text/plain", text }],
    };
  }

  return null;
}

/** Read cloud workspace file/directory */
export async function readWorkspaceFsResource(
  fs: WorkspaceFs,
  uri: string,
): Promise<McpReadResourceResult | null> {
  const path = parseWorkspaceFsUri(uri);
  if (path == null) return null;

  try {
    const st = await fs.stat(path);
    if (st.type === "dir") {
      const listed = await fs.list(path, { recursive: false, limit: FS_LIST_LIMIT });
      const body = {
        path: listed.path,
        truncated: listed.truncated,
        entries: listed.entries.map((e) => ({
          name: e.name,
          type: e.type,
          size: e.size,
          uri:
            e.type === "other"
              ? undefined
              : `${FS_URI_PREFIX}/${encodeFsPath(
                  [path.replace(/\/$/, ""), e.name]
                    .filter(Boolean)
                    .join("/")
                    .replace(/^\//, ""),
                )}`,
        })),
      };
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(body, null, 2),
          },
        ],
      };
    }

    const file = await fs.readText(path);
    return {
      contents: [
        {
          uri,
          mimeType: guessMime(path),
          text: file.content,
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(`Failed to read workspace resource ${uri}: ${message}`), {
      code: -32602,
      data: { uri },
    });
  }
}

/** Platform built-in prompts */
export function listAgentNativePrompts(agent: Agent): McpPromptDef[] {
  void agent;
  return [
    {
      name: "re_agent_briefing",
      title: "Agent briefing",
      description:
        "Briefing of this Agent's capabilities and recommended tool usage; emphasize direct tools/call on this MCP (including re_spawn_subagent)",
      arguments: [
        {
          name: "focus",
          description: "Focus: tools | resources | safety | all",
          required: false,
        },
      ],
    },
    {
      name: "re_tool_plan",
      title: "Tool call plan",
      description:
        "Plan re_* / upstream tool call order for a user goal; include re_spawn_subagent for decomposable subtasks",
      arguments: [
        {
          name: "goal",
          description: "User goal (natural language)",
          required: true,
        },
      ],
    },
    {
      name: "re_safe_exec",
      title: "Safe execution checklist",
      description: "Checklist before running shell / destructive tools",
      arguments: [
        {
          name: "action",
          description: "Summary of the intended action",
          required: true,
        },
      ],
    },
  ];
}

export function isAgentNativePromptName(name: string): boolean {
  const n = name.startsWith("re_") ? name : `re_${name}`;
  return (
    n === "re_agent_briefing" ||
    n === "re_tool_plan" ||
    n === "re_safe_exec"
  );
}

export function getAgentNativePrompt(
  agent: Agent,
  name: string,
  args?: Record<string, string>,
): McpGetPromptResult | null {
  const n = name.startsWith("re_") ? name : `re_${name}`;
  if (!isAgentNativePromptName(n)) return null;

  if (n === "re_agent_briefing") {
    const focus = (args?.focus ?? "all").toLowerCase();
    return {
      description: "Agent capability briefing",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Write a briefing for Agent "${agent.name}" (slug=${agent.slug}).`,
              `Focus: ${focus}`,
              `Computer=${agent.enableComputer ? "on" : "off"}, Memory=${agent.enableMemory ? "on" : "off"}, mcp.mode=${getAgentMcpMode(agent)}`,
              "First read resources zakura://agent/instructions, zakura://agent/info, and zakura://agent/capabilities.",
              "State clearly: this MCP's tools may be called via tools/call directly; use re_spawn_subagent for independent subtasks and integrate the results.",
              "Summarize available tools/resources/prompts and safety notes in a direct, actionable tone.",
            ].join("\n"),
          },
        },
      ],
    };
  }

  if (n === "re_tool_plan") {
    const goal = args?.goal?.trim() || "(goal not provided)";
    return {
      description: "Tool call plan",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Goal: ${goal}`,
              `Agent: ${agent.name} (${agent.slug})`,
              "List recommended tool call order (name + key args). Prefer re_ native tools; use upstream tools when external capability is needed.",
              "For parallelizable or conclusion-only subtasks, explicitly include re_spawn_subagent (task/context/expected_output).",
              "If destructive actions are involved, add a confirmation step. The plan must be executable — do not write \"suggest the user do it manually…\".",
            ].join("\n"),
          },
        },
      ],
    };
  }

  if (n === "re_safe_exec") {
    const action = args?.action?.trim() || "(action not provided)";
    return {
      description: "Safe execution checklist",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Intended action: ${action}`,
              "Check: 1) reversible? 2) blast radius 3) needs tasks/update confirmation? 4) rollback plan on failure.",
              "If risk is high, require explicit user confirmation before calling tools.",
            ].join("\n"),
          },
        },
      ],
    };
  }

  return null;
}
