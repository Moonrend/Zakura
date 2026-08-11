import {
  LocalWorkspaceFs,
  PathJailError,
  scrubHostPathsInMessage,
  textResult,
  unwrapShellCommand,
  type WorkspaceFs,
  type WorkspaceFsProvider,
} from "@zakura/core";
import type { McpToolResult, MemoryProviderKind, McpToolAnnotations } from "@zakura/shared";
import { AGENT_WORKSPACE_ROOT } from "@zakura/shared";
import type { Agent } from "../db/schema.js";
import type { AgentBrowserService } from "./agent-cdp.js";
import { isComputerEnvEnabled } from "./agent-caps.js";
import type { AgentWorkspaceService } from "./agent-workspace.js";
import { MEMORY_LAYERS, type MemoryStore } from "./memory-store.js";
import type { MemoryProvidersService } from "./memory-providers.js";
import { buildMemoryContext, resolveAgentMemory } from "./memory-runtime.js";
import { Mem0Client } from "./mem0-client.js";
import { withEmbedding } from "./memory-embed.js";
import { embedText, parseEmbeddingConfig } from "./embedding-client.js";
import { platformEvents } from "./platform-events.js";

export interface AgentNativeToolDef {
  qualifiedName: string;
  instanceId: null;
  providerId: "zakura-agent";
  localName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  title?: string;
  annotations?: McpToolAnnotations;
  builtin: true;
  agentScoped: true;
}

function tool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  opts?: {
    title?: string;
    annotations?: McpToolAnnotations;
  },
): AgentNativeToolDef {
  return {
    qualifiedName: name.startsWith("re_") ? name : `re_${name}`,
    instanceId: null,
    providerId: "zakura-agent",
    localName: name,
    description,
    inputSchema,
    title: opts?.title,
    annotations: opts?.annotations,
    builtin: true,
    agentScoped: true,
  };
}

const MEMORY_TOOL_NAMES = [
  "search_memory",
  "list_memories",
  "get_memory",
  "add_memory",
  "update_memory",
  "delete_memory",
  "pin_memory",
  "memory_stats",
  "memory_context",
  "link_memories",
  "memory_graph",
] as const;

/** Native tools Zakura implements for one agent (exposed via MCP). */
export function listAgentNativeTools(
  agent: Agent,
  memoryKind?: MemoryProviderKind | null,
): AgentNativeToolDef[] {
  const tools: AgentNativeToolDef[] = [
    tool("agent_info", "Return this agent's id, slug, capabilities, and workspace status.", {
      type: "object",
      properties: {},
    }),
    tool(
      "list_exposers",
      [
        "List tunnel exposers (providers) available for port exposure.",
        "Returns id, name, description, is_default, public_exposure, usable, and reason.",
        "Call this before expose_port when choosing a provider. Prefer usable=true; omit provider to use default.",
      ].join(" "),
      { type: "object", properties: {} },
    ),
    tool(
      "expose_port",
      [
        "Expose a workspace port via a tunnel exposer and return the access URL/address.",
        "provider is an exposer id from list_exposers (optional → tenant default).",
        "Returns exposure_id, url (public or tailnet address), provider, port, expires_at.",
        "Respects security policy (denied ports, TTL, concurrency).",
      ].join(" "),
      {
        type: "object",
        properties: {
          port: { type: "integer", description: "Workspace-internal port to expose" },
          provider: {
            type: "string",
            description:
              "Exposer id from list_exposers (e.g. cloudflare-quick). Defaults to tenant default.",
          },
          name: { type: "string", description: "Optional label for this exposure" },
          ttl_minutes: {
            type: "integer",
            description: "Time-to-live in minutes (clamped by security policy)",
          },
        },
        required: ["port"],
      },
    ),
    tool(
      "unexpose_port",
      "Stop/delete an active port exposure by exposure_id (preferred) or port number. Use list_exposures to find ids.",
      {
        type: "object",
        properties: {
          exposure_id: {
            type: "string",
            description: "Exposure id returned by expose_port / list_exposures",
          },
          port: { type: "integer", description: "Workspace port to unexpose (active only)" },
        },
      },
    ),
    tool(
      "list_exposures",
      "List this agent's port exposures (active and recent). Use to find exposure_id/url or before unexpose_port.",
      { type: "object", properties: {} },
    ),
    tool(
      "list_skills",
      [
        "List Agent Skills installed in this agent's workspace (name, description, path, enabled).",
        "Skills are reusable playbooks stored as SKILL.md files; read one with read_skill before doing the task it covers.",
      ].join(" "),
      {
        type: "object",
        properties: {
          include_disabled: { type: "boolean", default: false },
        },
      },
      { annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
    ),
    tool(
      "read_skill",
      [
        "Read an installed skill's SKILL.md (default) or one of its bundled files.",
        "Do this before executing a task the skill covers — the body holds the actual instructions.",
      ].join(" "),
      {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", description: "Skill name from list_skills" },
          path: {
            type: "string",
            description:
              "Optional file inside the skill directory, e.g. references/api.md. Defaults to SKILL.md",
          },
        },
      },
      { annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
    ),
    tool(
      "search_skills",
      [
        "Search skill stores (curated official repos mirrored on this server, Zakura builtin catalog, skills.sh registry, GitHub) for an installable skill.",
        "Use when the user needs a capability you have no playbook for. Returns install_spec strings to pass to install_skill.",
      ].join(" "),
      {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords, e.g. \"react performance\"" },
          store: {
            type: "string",
            enum: ["all", "curated", "builtin", "skills-sh", "github"],
            default: "all",
            description:
              "curated is served from this platform's local mirror — fastest and always has descriptions.",
          },
        },
      },
      { annotations: { readOnlyHint: true, openWorldHint: true } },
    ),
    tool(
      "install_skill",
      [
        "Install a skill into this agent's workspace so it can be read later.",
        "source accepts owner/repo, owner/repo@skill, a GitHub/GitLab URL, a SKILL.md link, builtin:<name>, or a whole `npx skills add …` command.",
        "Alternatively pass path to register a skill directory you just authored in the workspace.",
        "Tell the user what you are installing before calling this — it persists in their workspace.",
      ].join(" "),
      {
        type: "object",
        properties: {
          source: { type: "string", description: "Install spec / URL / npx command" },
          names: {
            type: "array",
            items: { type: "string" },
            description: "When the source holds several skills, install only these",
          },
          path: {
            type: "string",
            description:
              "Workspace directory containing a SKILL.md to register, e.g. /skills/my-skill",
          },
        },
      },
      { annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false } },
    ),
  ];

  const computerOn = isComputerEnvEnabled(agent);

  if (computerOn) {
    tools.push(
      tool(
        "fs_read",
        "Read a text file from the agent workspace. Paths are relative to the workspace root.",
        {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" },
            line_offset: { type: "integer", minimum: 1, description: "1-indexed start line" },
            n_lines: { type: "integer", minimum: 1 },
          },
        },
      ),
      tool("fs_write", "Write a text file (creates parent dirs). Overwrites existing content.", {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
      }),
      tool("fs_edit", "Replace a unique exact substring in a file.", {
        type: "object",
        required: ["path", "old_text", "new_text"],
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
      }),
      tool("fs_list", "List directory entries in the agent workspace.", {
        type: "object",
        properties: {
          path: { type: "string", default: "." },
          recursive: { type: "boolean", default: false },
          offset: { type: "integer", minimum: 0, default: 0 },
          limit: { type: "integer", minimum: 1, maximum: 500, default: 200 },
        },
      }),
      tool("fs_mkdir", "Create a directory (recursive).", {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
      }),
      tool("fs_delete", "Delete a file or directory inside the workspace.", {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          recursive: { type: "boolean", default: false },
        },
      }),
      tool("fs_stat", "Stat a path in the agent workspace.", {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
      }),
      tool("fs_move", "Move/rename a path inside the workspace.", {
        type: "object",
        required: ["from", "to"],
        properties: {
          from: { type: "string" },
          to: { type: "string" },
        },
      }),
      tool(
        "fs_grep",
        [
          "Search file contents in the agent workspace (ripgrep).",
          "Prefer this over shell_exec + rg for code lookup: structured hits, path jail, size caps.",
          "Returns path, line, and matching text. Binary / huge files are skipped by rg.",
        ].join(" "),
        {
          type: "object",
          required: ["pattern"],
          properties: {
            pattern: { type: "string", description: "Regex or fixed string to search" },
            path: {
              type: "string",
              description: "Subdirectory or file relative to workspace root (default .)",
            },
            glob: {
              type: "string",
              description: "Optional glob filter, e.g. *.ts or **/*.{ts,tsx}",
            },
            case_insensitive: { type: "boolean", default: false },
            fixed_string: {
              type: "boolean",
              default: false,
              description: "Treat pattern as literal string (-F)",
            },
            max_matches: {
              type: "integer",
              minimum: 1,
              maximum: 200,
              default: 50,
              description: "Cap on returned matches",
            },
          },
        },
        { annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
      ),
      tool(
        "apply_patch",
        [
          "Apply multiple exact-substring edits in one call (batch fs_edit).",
          "Each patch requires a unique old_text occurrence in that file.",
          "Stops on first failure unless continue_on_error=true.",
          "Prefer for multi-file or multi-hunk refactors over many fs_edit rounds.",
        ].join(" "),
        {
          type: "object",
          required: ["patches"],
          properties: {
            patches: {
              type: "array",
              minItems: 1,
              maxItems: 40,
              items: {
                type: "object",
                required: ["path", "old_text", "new_text"],
                properties: {
                  path: { type: "string" },
                  old_text: { type: "string" },
                  new_text: { type: "string" },
                },
              },
            },
            continue_on_error: {
              type: "boolean",
              default: false,
              description: "If true, apply remaining patches after a failure",
            },
          },
        },
        {
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: false,
            idempotentHint: false,
          },
        },
      ),
      tool(
        "get_file_url",
        [
          "Create a temporary public HTTPS URL for a workspace file so you can share it with the user or external systems.",
          "Anyone with the link can download until it expires or is revoked.",
          "Returns url, share_id, expires_at, file_name, size_bytes.",
          "Prefer this over embedding large binary content in chat. Max 32MB.",
        ].join(" "),
        {
          type: "object",
          required: ["path"],
          properties: {
            path: {
              type: "string",
              description: "Workspace-relative file path, e.g. /uploads/report.pdf",
            },
            ttl_minutes: {
              type: "integer",
              description: "Link lifetime in minutes (default 60, max 10080 = 7 days)",
            },
            disposition: {
              type: "string",
              enum: ["attachment", "inline"],
              description:
                "attachment (download) or inline (browser preview for images/PDF). Default attachment.",
            },
          },
        },
        {
          annotations: {
            readOnlyHint: false,
            openWorldHint: true,
            idempotentHint: false,
          },
        },
      ),
      tool(
        "revoke_file_url",
        "Revoke a previously created file share URL by share_id from get_file_url / list_file_urls.",
        {
          type: "object",
          required: ["share_id"],
          properties: {
            share_id: {
              type: "string",
              description: "Share id returned by get_file_url",
            },
          },
        },
        {
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: false,
          },
        },
      ),
      tool(
        "list_file_urls",
        "List recent file share links created for this agent (active and revoked). URLs are not re-exported after creation.",
        {
          type: "object",
          properties: {},
        },
        {
          annotations: {
            readOnlyHint: true,
            openWorldHint: false,
            idempotentHint: true,
          },
        },
      ),
    );
  }

  if (computerOn) {
    tools.push(
      tool(
        "shell_exec",
        [
          `Run any shell command in the agent workspace container via bash -lc.`,
          `cwd defaults to ${AGENT_WORKSPACE_ROOT} (bind-mounted host workspace — same files as fs_* tools).`,
          `Preinstalled: python3/pip/venv, node/npm/npx, gcc/g++/make, git, jq, rg, fd, sqlite3, curl/wget.`,
          `Write project files under ${AGENT_WORKSPACE_ROOT} so the console file browser can see them.`,
          `Caches: ${AGENT_WORKSPACE_ROOT}/.cache/{npm,pip}. Requires workspace started.`,
        ].join(" "),
        {
          type: "object",
          required: ["command"],
          properties: {
            command: {
              type: "string",
              description:
                "Arbitrary shell command (no allowlist). Do not wrap the whole command in quotes. Example: python3 main.py",
            },
            working_dir: {
              type: "string",
              description: `Optional cwd relative to ${AGENT_WORKSPACE_ROOT} or absolute under it`,
            },
            timeout: {
              type: "integer",
              minimum: 1,
              maximum: 300,
              default: 300,
              description: "Seconds before the command is terminated (default 300)",
            },
          },
        },
      ),
    );
  }

  if (computerOn) {
    tools.push(
      tool(
        "browser_observe",
        "Inspect the workspace Chromium tab without changing state. Prefer snapshot for interactive element refs (e1, e2…); use get_content for readable text; screenshot saves PNG base64.",
        {
          type: "object",
          required: ["observe"],
          properties: {
            observe: {
              type: "string",
              enum: [
                "snapshot",
                "get_content",
                "screenshot",
                "screenshot_annotate",
                "get_html",
                "evaluate",
                "get_url",
                "get_title",
                "tab_list",
              ],
            },
            ref: { type: "string", description: "Element ref from snapshot" },
            selector: { type: "string", description: "CSS selector fallback" },
            script: { type: "string", description: "JS for evaluate" },
            full_page: { type: "boolean", default: false },
          },
        },
      ),
      tool(
        "browser_action",
        "Operate the workspace browser. Prefer refs from browser_observe snapshot over CSS selectors. After navigation, observe again when the next step depends on new UI.",
        {
          type: "object",
          required: ["action"],
          properties: {
            action: {
              type: "string",
              enum: [
                "navigate",
                "click",
                "double_click",
                "focus",
                "type",
                "fill",
                "press",
                "hover",
                "select",
                "scroll",
                "scroll_into_view",
                "wait",
                "go_back",
                "go_forward",
                "reload",
                "tab_new",
                "tab_select",
                "tab_close",
              ],
            },
            url: { type: "string" },
            ref: { type: "string" },
            selector: { type: "string" },
            text: { type: "string" },
            key: { type: "string" },
            value: { type: "string" },
            direction: {
              type: "string",
              enum: ["up", "down", "left", "right"],
            },
            amount: { type: "integer", minimum: 1, maximum: 5000, default: 500 },
            tab_index: { type: "integer", minimum: 0 },
            timeout: { type: "integer", minimum: 1, maximum: 45000, default: 1000 },
          },
        },
      ),
    );
  }

  if (agent.enableMemory) {
    const kind = memoryKind ?? "builtin";
    if (kind === "traditional") {
      tools.push(
        tool(
          "memory_context",
          "Return ALL traditional memory notes for this agent. Call at the start of a turn so the full notebook is in context.",
          {
            type: "object",
            properties: {},
          },
        ),
        tool(
          "add_memory",
          "Append a plain-text note to traditional memory (returned in full on memory_context).",
          {
            type: "object",
            required: ["content"],
            properties: {
              content: { type: "string" },
              pinned: { type: "boolean", default: false },
            },
          },
        ),
        tool("list_memories", "List traditional memory notes.", {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        }),
        tool("delete_memory", "Delete a traditional memory note by id.", {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        }),
        tool("memory_stats", "Count of traditional memory notes.", {
          type: "object",
          properties: {},
        }),
      );
    } else if (kind === "mem0") {
      tools.push(
        tool(
          "memory_context",
          "Fetch relevant memories from external mem0 via semantic search (embedder+vector DB run inside mem0, not Zakura). Pass query when possible.",
          {
            type: "object",
            properties: {
              query: { type: "string", description: "Focus query for semantic retrieval" },
            },
          },
        ),
        tool(
          "search_memory",
          "Semantic search on external mem0. Requires a deployed mem0 with embedding model + vector store.",
          {
            type: "object",
            required: ["query"],
            properties: {
              query: { type: "string" },
              limit: { type: "integer", minimum: 1, maximum: 50, default: 8 },
            },
          },
        ),
        tool(
          "add_memory",
          "Add a memory through external mem0 (extraction/embedding happens on mem0 side).",
          {
            type: "object",
            required: ["content"],
            properties: {
              content: { type: "string" },
              user_id: { type: "string" },
            },
          },
        ),
        tool("list_memories", "List memories from external mem0 for this agent.", {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
            user_id: { type: "string" },
          },
        }),
        tool("delete_memory", "Delete a memory on external mem0 by id.", {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        }),
      );
    } else {
      tools.push(
        tool(
          "memory_context",
          kind === "builtin"
            ? "Pack memories via hybrid recall: optional embedding semantic seeds + keyword ILIKE + graph neighbors. Pass query for focused recall."
            : "Fetch memory context from the configured provider.",
          {
            type: "object",
            properties: {
              query: { type: "string", description: "Optional focus query for retrieval" },
            },
          },
        ),
        tool(
          "search_memory",
          "Search this agent's long-term memory. Built-in uses hybrid recall (optional embedding + keyword + graph). Prefer before asking the user again.",
          {
            type: "object",
            required: ["query"],
            properties: {
              query: { type: "string" },
              limit: { type: "integer", minimum: 1, maximum: 50, default: 8 },
            },
          },
        ),
        tool("list_memories", "List memories for this agent, optionally filtered by layer.", {
          type: "object",
          properties: {
            layer: { type: "string", enum: [...MEMORY_LAYERS] },
            pinned: { type: "boolean" },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        }),
        tool("get_memory", "Get one memory by id (this agent only).", {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        }),
        tool(
          "add_memory",
          "Store a durable fact/preference for this agent. Use layers: identity, preference, project, fact, episode.",
          {
            type: "object",
            required: ["content"],
            properties: {
              content: { type: "string" },
              layer: { type: "string", enum: [...MEMORY_LAYERS], default: "fact" },
              tags: { type: "array", items: { type: "string" } },
              pinned: { type: "boolean", default: false },
              importance: { type: "integer", minimum: 1, maximum: 5, default: 3 },
              user_id: { type: "string" },
            },
          },
        ),
        tool("update_memory", "Update an existing memory of this agent.", {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            content: { type: "string" },
            layer: { type: "string", enum: [...MEMORY_LAYERS] },
            tags: { type: "array", items: { type: "string" } },
            pinned: { type: "boolean" },
            importance: { type: "integer", minimum: 1, maximum: 5 },
          },
        }),
        tool("delete_memory", "Delete a memory of this agent.", {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        }),
        tool("pin_memory", "Pin or unpin a memory for priority recall.", {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            pinned: { type: "boolean", default: true },
          },
        }),
        tool("memory_stats", "Counts of this agent's memories by layer.", {
          type: "object",
          properties: {},
        }),
      );
      if (kind === "builtin") {
        tools.push(
          tool("link_memories", "Create a graph edge between two memories (relation).", {
            type: "object",
            required: ["from_id", "to_id"],
            properties: {
              from_id: { type: "string" },
              to_id: { type: "string" },
              relation: { type: "string", default: "related" },
            },
          }),
          tool("memory_graph", "Return memory nodes + edges for this agent.", {
            type: "object",
            properties: {},
          }),
        );
      }
    }
  }

  if (computerOn) {
    tools.push(
      tool(
        "desktop_info",
        "Return noVNC URL and desktop/browser endpoint status for the virtual computer.",
        { type: "object", properties: {} },
      ),
      tool(
        "computer_screenshot",
        "Capture the virtual desktop (PNG base64). Requires computer workspace running.",
        {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Optional workspace-relative path to also save the PNG",
            },
          },
        },
      ),
      tool("computer_click", "Click at screen coordinates on the virtual desktop.", {
        type: "object",
        required: ["x", "y"],
        properties: {
          x: { type: "integer" },
          y: { type: "integer" },
          button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
          double: { type: "boolean", default: false },
        },
      }),
      tool("computer_type", "Type text into the focused window (desktop-wide, not only browser).", {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string" },
        },
      }),
      tool("computer_key", "Press a key or key combo (xdotool key syntax, e.g. Return, ctrl+c).", {
        type: "object",
        required: ["key"],
        properties: {
          key: { type: "string" },
        },
      }),
      tool("computer_scroll", "Scroll at coordinates on the desktop.", {
        type: "object",
        required: ["x", "y", "dy"],
        properties: {
          x: { type: "integer" },
          y: { type: "integer" },
          dy: { type: "integer", description: "Positive = down, negative = up" },
        },
      }),
      tool("computer_move", "Move mouse pointer without clicking.", {
        type: "object",
        required: ["x", "y"],
        properties: {
          x: { type: "integer" },
          y: { type: "integer" },
        },
      }),
    );
  }

  return tools;
}

function okJson(data: unknown): McpToolResult {
  return textResult(JSON.stringify(data, null, 2));
}

function errText(err: unknown, workspaceRoot?: string): McpToolResult {
  let msg = err instanceof Error ? err.message : String(err);
  if (workspaceRoot) {
    msg = scrubHostPathsInMessage(workspaceRoot, msg);
  }
  return textResult(msg, true);
}

function trimHeavy(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const o = { ...(data as Record<string, unknown>) };
  if (typeof o.base64Full === "string" && o.base64Full.length > 400) {
    o.base64Preview =
      (o.base64Full as string).slice(0, 120) + `…(${(o.base64Full as string).length} chars)`;
    // Keep full for model if needed but cap for MCP default response size
    if ((o.base64Full as string).length > 120_000) {
      o.base64Full = (o.base64Full as string).slice(0, 120_000);
      o.truncated = true;
    }
  }
  if (typeof o.screenshotBase64Full === "string" && o.screenshotBase64Full.length > 400) {
    o.screenshotBase64Preview =
      (o.screenshotBase64Full as string).slice(0, 120) +
      `…(${(o.screenshotBase64Full as string).length} chars)`;
    if ((o.screenshotBase64Full as string).length > 120_000) {
      o.screenshotBase64Full = (o.screenshotBase64Full as string).slice(0, 120_000);
      o.truncated = true;
    }
  }
  return o;
}

export async function callAgentNativeTool(
  agent: Agent,
  workspace: AgentWorkspaceService,
  name: string,
  args: Record<string, unknown>,
  browser?: AgentBrowserService | null,
  memory?: MemoryStore | null,
  memoryProviders?: MemoryProvidersService | null,
  workspaceFsProvider?: WorkspaceFsProvider | null,
  exposures?: import("./port-exposures.js").ExposureService | null,
  fileShares?: import("./file-shares.js").FileShareService | null,
): Promise<McpToolResult> {
  // 提升到 try 外，catch 里才能 scrub 宿主路径
  let fsOnce: WorkspaceFs | null = null;
  try {
    // 仅 fs_* / get_file_url 时打开磁盘/Runner；避免 shell/browser 等工具每次都查节点、建 FS
    const getFs = async (): Promise<WorkspaceFs> => {
      if (fsOnce) return fsOnce;
      fsOnce = workspaceFsProvider
        ? await workspaceFsProvider.forAgentBinding({
            id: agent.id,
            tenantId: agent.tenantId,
            runtimeNodeId: agent.runtimeNodeId,
          })
        : new LocalWorkspaceFs(workspace.ensureLocal(agent));
      return fsOnce;
    };
    /** 工作区文件变更事件：前端文件面板据此免轮询刷新 */
    const notifyFsChanged = (path: string) => {
      platformEvents.publish(agent.tenantId, {
        type: "agent_fs_changed",
        agentId: agent.id,
        path,
      });
    };

    if (name === "agent_info") {
      const container = await workspace.getWorkspaceContainer(agent.id);
      const desktop = await workspace.getDesktopInfo(agent);
      let memoryProvider: { id: string; name: string; kind: string } | null = null;
      if (memoryProviders && agent.enableMemory) {
        const resolved = await resolveAgentMemory(memoryProviders, agent);
        if (resolved) {
          memoryProvider = {
            id: resolved.provider.id,
            name: resolved.provider.name,
            kind: resolved.kind,
          };
        }
      }
      return okJson({
        id: agent.id,
        name: agent.name,
        slug: agent.slug,
        enableComputer: isComputerEnvEnabled(agent),
        enableMemory: agent.enableMemory,
        memoryProvider,
        runtimeNodeId: agent.runtimeNodeId ?? null,
        workspaceStatus: agent.workspaceStatus ?? "ready",
        workspaceRoot: AGENT_WORKSPACE_ROOT,
        hostDataNote: "Host path is managed by Zakura; tools only see the sandbox.",
        desktop,
        workspace: container
          ? {
              id: container.id,
              dockerId: container.dockerId,
              status: container.status,
              image: container.image,
            }
          : null,
        lastError: agent.lastError,
      });
    }

    if (
      name === "list_exposers" ||
      name === "expose_port" ||
      name === "unexpose_port" ||
      name === "list_exposures"
    ) {
      if (!exposures) return textResult("Port exposure service unavailable", true);
      if (name === "list_exposers") {
        const catalog = await exposures.listExposers(agent.tenantId);
        return okJson({
          default_provider: catalog.defaultProvider,
          exposure_enabled: catalog.exposureEnabled,
          agents_can_expose: catalog.agentsCanExpose,
          exposers: catalog.exposers.map((e) => ({
            id: e.id,
            name: e.name,
            description: e.description,
            is_default: e.isDefault,
            public_exposure: e.publicExposure,
            requires_config: e.requiresConfig,
            enabled: e.enabled,
            ready: e.ready,
            usable: e.usable,
            reason: e.reason,
          })),
          hint: "Call expose_port with port and optional provider=exposer.id. Prefer usable=true.",
        });
      }
      if (name === "list_exposures") {
        const items = await exposures.listForAgent(agent.tenantId, agent.id);
        return okJson({
          exposures: items.map((e) => ({
            exposure_id: e.id,
            port: e.port,
            provider: e.provider,
            status: e.status,
            url: e.publicUrl,
            name: e.name,
            expires_at: e.expiresAt,
            last_error: e.lastError,
          })),
        });
      }
      if (name === "expose_port") {
        const port = Number(args.port);
        try {
          const exposure = await exposures.create(
            agent.tenantId,
            agent.id,
            {
              port,
              provider: typeof args.provider === "string" ? args.provider : undefined,
              name: typeof args.name === "string" ? args.name : undefined,
              ttlMinutes:
                typeof args.ttl_minutes === "number" ? args.ttl_minutes : undefined,
            },
            { type: "agent", id: agent.id },
          );
          return okJson({
            exposure_id: exposure.id,
            port: exposure.port,
            provider: exposure.provider,
            status: exposure.status,
            url: exposure.publicUrl,
            address: exposure.publicUrl,
            expires_at: exposure.expiresAt,
            name: exposure.name,
            note:
              exposure.provider === "cloudflare-quick"
                ? "Quick Tunnel URL is publicly reachable by anyone who knows the link."
                : exposure.provider === "tailscale-serve"
                  ? "URL is reachable only inside your Tailscale tailnet (not the public internet)."
                  : undefined,
          });
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true);
        }
      }
      // unexpose_port
      try {
        if (typeof args.exposure_id === "string" && args.exposure_id) {
          const owned = await exposures.listForAgent(agent.tenantId, agent.id);
          if (!owned.some((e) => e.id === args.exposure_id)) {
            return textResult("Exposure not found for this agent", true);
          }
          const stopped = await exposures.stop(agent.tenantId, args.exposure_id, {
            type: "agent",
            id: agent.id,
          });
          if (!stopped) return textResult("Exposure not found", true);
          return okJson({
            ok: true,
            exposure_id: stopped.id,
            port: stopped.port,
            status: stopped.status,
            url: stopped.publicUrl,
          });
        }
        if (typeof args.port === "number" || typeof args.port === "string") {
          const stopped = await exposures.stopByPort(
            agent.tenantId,
            agent.id,
            Number(args.port),
            { type: "agent", id: agent.id },
          );
          if (!stopped) return textResult("No active exposure for that port", true);
          return okJson({
            ok: true,
            exposure_id: stopped.id,
            port: stopped.port,
            status: stopped.status,
            url: stopped.publicUrl,
          });
        }
        return textResult("Provide exposure_id or port", true);
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    }

    if (
      !isComputerEnvEnabled(agent) &&
      (name.startsWith("fs_") ||
        name === "apply_patch" ||
        name === "shell_exec" ||
        name.startsWith("computer_") ||
        name === "desktop_info" ||
        name.startsWith("browser_") ||
        name === "get_file_url" ||
        name === "revoke_file_url" ||
        name === "list_file_urls")
    ) {
      return textResult("Computer environment is not enabled", true);
    }
    if (!agent.enableMemory && (MEMORY_TOOL_NAMES as readonly string[]).includes(name)) {
      return textResult("Memory disabled for this agent", true);
    }

    const resolved =
      memoryProviders && agent.enableMemory
        ? await resolveAgentMemory(memoryProviders, agent)
        : null;
    const providerId = resolved?.provider.id ?? null;
    const kind = resolved?.kind ?? "builtin";

    switch (name) {
      case "get_file_url": {
        if (!fileShares) return textResult("File share service unavailable", true);
        try {
          const share = await fileShares.create(agent.tenantId, agent.id, await getFs(), {
            path: String(args.path ?? ""),
            ttlMinutes:
              typeof args.ttl_minutes === "number" ? args.ttl_minutes : undefined,
            disposition:
              args.disposition === "inline"
                ? "inline"
                : args.disposition === "attachment"
                  ? "attachment"
                  : undefined,
          });
          return okJson({
            share_id: share.id,
            url: share.url,
            path: share.path,
            file_name: share.fileName,
            mime_type: share.mimeType,
            size_bytes: share.sizeBytes,
            expires_at: share.expiresAt,
            ttl_minutes: share.ttlMinutes,
            disposition: share.disposition,
            note: "Anyone with this URL can download the file until it expires or is revoked. Send the url to the user.",
          });
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true);
        }
      }
      case "revoke_file_url": {
        if (!fileShares) return textResult("File share service unavailable", true);
        const shareId = String(args.share_id ?? "").trim();
        if (!shareId) return textResult("share_id is required", true);
        const revoked = await fileShares.revoke(agent.tenantId, agent.id, shareId);
        if (!revoked) return textResult("Share not found", true);
        return okJson({
          ok: true,
          share_id: revoked.id,
          status: revoked.status,
          path: revoked.path,
        });
      }
      case "list_file_urls": {
        if (!fileShares) return textResult("File share service unavailable", true);
        const items = await fileShares.listForAgent(agent.tenantId, agent.id);
        return okJson({
          shares: items.map((s) => ({
            share_id: s.id,
            path: s.path,
            file_name: s.fileName,
            status: s.status,
            expires_at: s.expiresAt,
            size_bytes: s.sizeBytes,
            download_count: s.downloadCount,
            disposition: s.disposition,
          })),
          note: "Raw download URLs are only returned once by get_file_url.",
        });
      }
      case "fs_read":
        return okJson(
          await (await getFs()).read(String(args.path), {
            lineOffset: typeof args.line_offset === "number" ? args.line_offset : undefined,
            nLines: typeof args.n_lines === "number" ? args.n_lines : undefined,
          }),
        );
      case "fs_write": {
        const res = await (await getFs()).write(String(args.path), String(args.content ?? ""));
        notifyFsChanged(String(args.path));
        return okJson(res);
      }
      case "fs_edit": {
        const res = await (
          await getFs()
        ).edit(
          String(args.path),
          String(args.old_text ?? ""),
          String(args.new_text ?? ""),
        );
        notifyFsChanged(String(args.path));
        return okJson(res);
      }
      case "fs_list":
        return okJson(
          await (await getFs()).list(typeof args.path === "string" ? args.path : ".", {
            recursive: Boolean(args.recursive),
            offset: typeof args.offset === "number" ? args.offset : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
          }),
        );
      case "fs_mkdir": {
        const res = await (await getFs()).mkdir(String(args.path));
        notifyFsChanged(String(args.path));
        return okJson(res);
      }
      case "fs_delete": {
        const res = await (await getFs()).delete(String(args.path), Boolean(args.recursive));
        notifyFsChanged(String(args.path));
        return okJson(res);
      }
      case "fs_stat":
        return okJson(await (await getFs()).stat(String(args.path)));
      case "fs_move": {
        const res = await (await getFs()).move(String(args.from), String(args.to));
        notifyFsChanged(String(args.from));
        notifyFsChanged(String(args.to));
        return okJson(res);
      }
      case "fs_grep": {
        const pattern = String(args.pattern ?? "");
        if (!pattern.trim()) return textResult("pattern is required", true);
        const maxMatches =
          typeof args.max_matches === "number"
            ? Math.min(Math.max(Math.floor(args.max_matches), 1), 200)
            : 50;
        const searchPath =
          typeof args.path === "string" && args.path.trim() ? args.path.trim() : ".";
        const flags = [
          "rg",
          "--line-number",
          "--no-heading",
          "--color",
          "never",
          "--max-columns",
          "240",
          "--max-columns-preview",
          ...(args.case_insensitive ? ["-i"] : []),
          ...(args.fixed_string ? ["-F"] : []),
          ...(typeof args.glob === "string" && args.glob.trim()
            ? ["--glob", args.glob.trim()]
            : []),
          "--",
          pattern,
          searchPath,
        ];
        // escape for bash -lc single-quoted argv is painful; pass via env + python-free bash array
        const quoted = flags
          .map((p) => `'${String(p).replace(/'/g, `'\\''`)}'`)
          .join(" ");
        const command = `${quoted} 2>/dev/null | head -n ${maxMatches * 2}`;
        try {
          const result = await workspace.execInWorkspace(
            agent,
            ["bash", "-lc", command],
            { timeoutMs: 30_000 },
          );
          const stdout = result.stdout ?? "";
          // rg: 0=matches, 1=no match, ≥2=error
          if (result.exitCode >= 2 && !stdout.trim()) {
            return textResult(result.stderr?.trim() || "rg failed", true);
          }
          const matches: Array<{ path: string; line: number; text: string }> = [];
          for (const raw of stdout.split(/\r?\n/)) {
            if (!raw.trim()) continue;
            const m = raw.match(/^([^:]+):(\d+):(.*)$/);
            if (!m) continue;
            matches.push({
              path: m[1]!,
              line: Number(m[2]),
              text: m[3] ?? "",
            });
            if (matches.length >= maxMatches) break;
          }
          return okJson({
            pattern,
            path: searchPath,
            match_count: matches.length,
            truncated: matches.length >= maxMatches,
            matches,
            note:
              matches.length === 0
                ? "No matches (or path outside workspace / binary-only)."
                : undefined,
          });
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true);
        }
      }
      case "apply_patch": {
        const rawPatches = Array.isArray(args.patches) ? args.patches : [];
        if (rawPatches.length === 0) return textResult("patches is required", true);
        const continueOnError = Boolean(args.continue_on_error);
        const fs = await getFs();
        const results: Array<{
          path: string;
          ok: boolean;
          error?: string;
        }> = [];
        const touched = new Set<string>();
        for (const item of rawPatches.slice(0, 40)) {
          if (!item || typeof item !== "object") {
            results.push({ path: "?", ok: false, error: "invalid patch entry" });
            if (!continueOnError) break;
            continue;
          }
          const p = item as Record<string, unknown>;
          const path = String(p.path ?? "");
          const oldText = String(p.old_text ?? "");
          const newText = String(p.new_text ?? "");
          if (!path || !oldText) {
            results.push({ path: path || "?", ok: false, error: "path and old_text required" });
            if (!continueOnError) break;
            continue;
          }
          try {
            await fs.edit(path, oldText, newText);
            results.push({ path, ok: true });
            touched.add(path);
          } catch (err) {
            results.push({
              path,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
            if (!continueOnError) break;
          }
        }
        for (const path of touched) notifyFsChanged(path);
        const okCount = results.filter((r) => r.ok).length;
        return okJson({
          applied: okCount,
          failed: results.length - okCount,
          results,
        });
      }
      case "shell_exec": {
        const command = unwrapShellCommand(String(args.command ?? ""));
        if (!command.trim()) return textResult("command is required", true);
        const timeoutSeconds =
          typeof args.timeout === "number" && args.timeout > 0
            ? Math.min(Math.ceil(args.timeout), 300)
            : 300;
        const result = await workspace.execInWorkspace(
          agent,
          ["timeout", "--signal=TERM", "--kill-after=5s", `${timeoutSeconds}s`, "bash", "-lc", command],
          {
          workingDir: typeof args.working_dir === "string" ? args.working_dir : undefined,
          timeoutMs: timeoutSeconds * 1000,
          },
        );
        return okJson(result);
      }
      case "browser_observe": {
        if (!browser) return textResult("Browser service not configured", true);
        const result = await browser.observe(agent.id, {
          observe: String(args.observe ?? "snapshot"),
          ref: typeof args.ref === "string" ? args.ref : undefined,
          selector: typeof args.selector === "string" ? args.selector : undefined,
          script: typeof args.script === "string" ? args.script : undefined,
          full_page: Boolean(args.full_page),
        });
        return okJson(trimHeavy(result));
      }
      case "browser_action": {
        if (!browser) return textResult("Browser service not configured", true);
        const result = await browser.action(agent.id, {
          action: String(args.action ?? ""),
          url: typeof args.url === "string" ? args.url : undefined,
          ref: typeof args.ref === "string" ? args.ref : undefined,
          selector: typeof args.selector === "string" ? args.selector : undefined,
          text: typeof args.text === "string" ? args.text : undefined,
          key: typeof args.key === "string" ? args.key : undefined,
          value: typeof args.value === "string" ? args.value : undefined,
          direction: typeof args.direction === "string" ? args.direction : undefined,
          amount: typeof args.amount === "number" ? args.amount : undefined,
          tab_index: typeof args.tab_index === "number" ? args.tab_index : undefined,
          timeout: typeof args.timeout === "number" ? args.timeout : undefined,
        });
        return okJson(result);
      }
      case "search_memory": {
        if (kind === "mem0") {
          if (!resolved) return textResult("Memory provider not resolved", true);
          try {
            const client = Mem0Client.fromConfig(resolved.config);
            const out = await client.search({
              query: String(args.query ?? ""),
              agentId: agent.id,
              userId:
                typeof args.user_id === "string"
                  ? args.user_id
                  : typeof resolved.config.defaultUserId === "string"
                    ? resolved.config.defaultUserId
                    : "default",
              limit: typeof args.limit === "number" ? args.limit : 8,
            });
            return okJson(out);
          } catch (err) {
            return textResult(err instanceof Error ? err.message : String(err), true);
          }
        }
        if (!memory) return textResult("Memory store not configured", true);
        if (kind === "openviking") {
          return textResult(
            "OpenViking does not use local search_memory; browse context with OpenViking's own tools.",
            true,
          );
        }
        if (kind === "builtin") {
          let queryEmbedding: number[] | null = null;
          const embCfg = resolved ? parseEmbeddingConfig(resolved.config) : null;
          if (embCfg) {
            try {
              queryEmbedding = await embedText(embCfg, String(args.query ?? ""));
            } catch {
              /* degrade to keyword */
            }
          }
          const packed = await memory.hybridSearch(
            agent.tenantId,
            agent.id,
            String(args.query ?? ""),
            {
              limit: typeof args.limit === "number" ? args.limit : 8,
              queryEmbedding,
            },
          );
          return okJson({
            ...packed,
            note:
              packed.retrievalMode === "hybrid"
                ? "retrieval=hybrid (semantic seeds + keyword + graph)"
                : "retrieval=keyword_graph",
          });
        }
        const results = await memory.search(
          agent.tenantId,
          agent.id,
          String(args.query ?? ""),
          typeof args.limit === "number" ? args.limit : 8,
        );
        return okJson({ results, note: "retrieval=keyword_ilike" });
      }
      case "list_memories": {
        if (kind === "mem0") {
          if (!resolved) return textResult("Memory provider not resolved", true);
          try {
            const client = Mem0Client.fromConfig(resolved.config);
            return okJson(
              await client.list({
                agentId: agent.id,
                userId:
                  typeof args.user_id === "string"
                    ? args.user_id
                    : typeof resolved.config.defaultUserId === "string"
                      ? resolved.config.defaultUserId
                      : "default",
                limit: typeof args.limit === "number" ? args.limit : 30,
              }),
            );
          } catch (err) {
            return textResult(err instanceof Error ? err.message : String(err), true);
          }
        }
        if (!memory) return textResult("Memory store not configured", true);
        const items = await memory.list(agent.tenantId, agent.id, {
          layer: typeof args.layer === "string" ? args.layer : undefined,
          pinned: typeof args.pinned === "boolean" ? args.pinned : undefined,
          limit: typeof args.limit === "number" ? args.limit : 30,
          offset: typeof args.offset === "number" ? args.offset : 0,
        });
        return okJson({ memories: items });
      }
      case "get_memory": {
        if (kind === "mem0") {
          return textResult(
            "For mem0 use list_memories / search_memory; fetch a single item via the mem0 console or API",
            true,
          );
        }
        if (!memory) return textResult("Memory store not configured", true);
        const item = await memory.get(agent.tenantId, agent.id, String(args.id ?? ""));
        if (!item) return textResult("Memory not found", true);
        return okJson(item);
      }
      case "add_memory": {
        if (kind === "mem0") {
          if (!resolved) return textResult("Memory provider not resolved", true);
          try {
            const client = Mem0Client.fromConfig(resolved.config);
            const item = await client.add({
              content: String(args.content ?? ""),
              agentId: agent.id,
              userId:
                typeof args.user_id === "string"
                  ? args.user_id
                  : typeof resolved.config.defaultUserId === "string"
                    ? resolved.config.defaultUserId
                    : "default",
            });
            return okJson(item);
          } catch (err) {
            return textResult(err instanceof Error ? err.message : String(err), true);
          }
        }
        if (!memory) return textResult("Memory store not configured", true);
        const baseInput = {
          content: String(args.content ?? ""),
          layer:
            kind === "traditional"
              ? "note"
              : typeof args.layer === "string"
                ? args.layer
                : "fact",
          tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
          pinned: Boolean(args.pinned),
          importance: typeof args.importance === "number" ? args.importance : 3,
          userId: typeof args.user_id === "string" ? args.user_id : "default",
          source: "tool",
          providerId,
        };
        const { input: toWrite, embeddingError } = await withEmbedding(
          baseInput,
          kind === "builtin" ? resolved?.config : null,
        );
        const item = await memory.add(agent.tenantId, agent.id, toWrite);
        return okJson({
          ...item,
          ...(embeddingError ? { embeddingWarning: embeddingError } : {}),
        });
      }
      case "update_memory": {
        if (kind === "mem0") {
          return textResult("Update mem0 memories via the mem0 API / console", true);
        }
        if (!memory) return textResult("Memory store not configured", true);
        const patchBase: {
          content?: string;
          layer?: string;
          tags?: string[];
          pinned?: boolean;
          importance?: number;
          embedding?: number[] | null;
          embeddingModel?: string | null;
        } = {
          content: typeof args.content === "string" ? args.content : undefined,
          layer: typeof args.layer === "string" ? args.layer : undefined,
          tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
          pinned: typeof args.pinned === "boolean" ? args.pinned : undefined,
          importance: typeof args.importance === "number" ? args.importance : undefined,
        };
        if (typeof args.content === "string" && kind === "builtin" && resolved) {
          const { input: embIn, embeddingError } = await withEmbedding(
            { content: args.content },
            resolved.config,
          );
          if (embIn.embedding) {
            patchBase.embedding = embIn.embedding;
            patchBase.embeddingModel = embIn.embeddingModel;
          }
          const item = await memory.update(
            agent.tenantId,
            agent.id,
            String(args.id ?? ""),
            patchBase,
          );
          return okJson({
            ...item,
            ...(embeddingError ? { embeddingWarning: embeddingError } : {}),
          });
        }
        const item = await memory.update(agent.tenantId, agent.id, String(args.id ?? ""), patchBase);
        return okJson(item);
      }
      case "delete_memory": {
        if (kind === "mem0") {
          if (!resolved) return textResult("Memory provider not resolved", true);
          try {
            const client = Mem0Client.fromConfig(resolved.config);
            await client.delete(String(args.id ?? ""));
            return okJson({ ok: true });
          } catch (err) {
            return textResult(err instanceof Error ? err.message : String(err), true);
          }
        }
        if (!memory) return textResult("Memory store not configured", true);
        await memory.remove(agent.tenantId, agent.id, String(args.id ?? ""));
        return okJson({ ok: true });
      }
      case "pin_memory": {
        if (kind === "mem0") {
          return textResult("mem0 does not support local pin; manage pins on the mem0 side", true);
        }
        if (!memory) return textResult("Memory store not configured", true);
        const item = await memory.update(agent.tenantId, agent.id, String(args.id ?? ""), {
          pinned: args.pinned !== false,
        });
        return okJson(item);
      }
      case "memory_stats": {
        if (kind === "mem0") {
          if (!resolved) return textResult("Memory provider not resolved", true);
          try {
            const client = Mem0Client.fromConfig(resolved.config);
            const listed = await client.list({ agentId: agent.id, limit: 200 });
            return okJson({
              total: listed.memories.length,
              provider: "mem0",
              note: "Counts from mem0 list (capped at 200)",
            });
          } catch (err) {
            return textResult(err instanceof Error ? err.message : String(err), true);
          }
        }
        if (!memory) return textResult("Memory store not configured", true);
        return okJson(await memory.stats(agent.tenantId, agent.id));
      }
      case "memory_context": {
        if (!resolved) {
          return textResult("Memory provider not resolved", true);
        }
        const packed = await buildMemoryContext(
          memory ?? null,
          resolved,
          agent,
          typeof args.query === "string" ? args.query : undefined,
        );
        return okJson(packed);
      }
      case "link_memories": {
        if (!memory) return textResult("Memory store not configured", true);
        const edge = await memory.link(
          agent.tenantId,
          agent.id,
          String(args.from_id ?? ""),
          String(args.to_id ?? ""),
          typeof args.relation === "string" ? args.relation : "related",
        );
        return okJson(edge);
      }
      case "memory_graph": {
        if (!memory) return textResult("Memory store not configured", true);
        return okJson(await memory.graph(agent.tenantId, agent.id));
      }
      case "desktop_info":
        return okJson(await workspace.getDesktopInfo(agent));
      case "computer_screenshot": {
        const outPath =
          typeof args.path === "string" && args.path
            ? `${AGENT_WORKSPACE_ROOT}/${args.path.replace(/^\/+/, "")}`
            : "/tmp/zakura-shot.png";
        const shot = await workspace.execInWorkspace(
          agent,
          [
            "bash",
            "-lc",
            `export DISPLAY=:99; mkdir -p "$(dirname '${outPath}')"; (command -v scrot >/dev/null && scrot -o '${outPath}') || (command -v import >/dev/null && import -window root '${outPath}') || (command -v xwd >/dev/null && xwd -root -out /tmp/r.xwd && convert /tmp/r.xwd '${outPath}'); base64 -w0 '${outPath}' 2>/dev/null || base64 '${outPath}'`,
          ],
          { env: { DISPLAY: ":99" } },
        );
        if (shot.exitCode !== 0) {
          return textResult(
            `Screenshot failed (exit ${shot.exitCode}). Is computer workspace running?\n${shot.stdout}${shot.stderr ? `\n${shot.stderr}` : ""}`,
            true,
          );
        }
        const b64 = shot.stdout.replace(/\s+/g, "").trim();
        return okJson(
          trimHeavy({
            format: "png",
            base64Full: b64,
            savedPath: typeof args.path === "string" ? args.path : null,
          }),
        );
      }
      case "computer_click": {
        const x = Number(args.x);
        const y = Number(args.y);
        const button = String(args.button ?? "left");
        const map: Record<string, number> = { left: 1, middle: 2, right: 3 };
        const btn = map[button] ?? 1;
        const click = args.double ? "dblclick" : "click";
        const result = await workspace.execInWorkspace(
          agent,
          ["bash", "-lc", `export DISPLAY=:99; xdotool mousemove ${x} ${y} ${click} ${btn}`],
          { env: { DISPLAY: ":99" } },
        );
        return okJson(result);
      }
      case "computer_type": {
        const text = String(args.text ?? "");
        const result = await workspace.execInWorkspace(
          agent,
          ["bash", "-lc", `export DISPLAY=:99; xdotool type --delay 12 -- ${JSON.stringify(text)}`],
          { env: { DISPLAY: ":99" } },
        );
        return okJson(result);
      }
      case "computer_key": {
        const key = String(args.key ?? "");
        const result = await workspace.execInWorkspace(
          agent,
          ["bash", "-lc", `export DISPLAY=:99; xdotool key ${JSON.stringify(key)}`],
          { env: { DISPLAY: ":99" } },
        );
        return okJson(result);
      }
      case "computer_scroll": {
        const x = Number(args.x);
        const y = Number(args.y);
        const dy = Number(args.dy);
        const button = dy >= 0 ? 5 : 4;
        const times = Math.min(20, Math.abs(dy) || 1);
        const result = await workspace.execInWorkspace(
          agent,
          [
            "bash",
            "-lc",
            `export DISPLAY=:99; xdotool mousemove ${x} ${y}; for i in $(seq 1 ${times}); do xdotool click ${button}; done`,
          ],
          { env: { DISPLAY: ":99" } },
        );
        return okJson(result);
      }
      case "computer_move": {
        const x = Number(args.x);
        const y = Number(args.y);
        const result = await workspace.execInWorkspace(
          agent,
          ["bash", "-lc", `export DISPLAY=:99; xdotool mousemove ${x} ${y}`],
          { env: { DISPLAY: ":99" } },
        );
        return okJson(result);
      }
      default:
        return textResult(`Unknown agent tool: ${name}`, true);
    }
  } catch (err) {
    if (err instanceof PathJailError) return textResult(err.message, true);
    const root =
      fsOnce && typeof (fsOnce as LocalWorkspaceFs).getRoot === "function"
        ? (fsOnce as LocalWorkspaceFs).getRoot()
        : undefined;
    return errText(err, root);
  }
}
