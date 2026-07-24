/**
 * Zakura Agent 平台自有 MCP resources / prompts / resource templates。
 *
 * Resources（resources/list）：可直接枚举的具体 URI，客户端 resources/read 即可读。
 * Resource Templates（resources/templates/list）：RFC 6570 模板，客户端填参后再 read。
 * 例：模板 zakura://agent/fs/{+path} → 具体 zakura://agent/fs/src/main.ts
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

/** 平台内置固定资源（不含工作区文件枚举） */
export function listAgentNativeResources(agent: Agent): McpResourceDef[] {
  void agent;
  return [
    {
      uri: RESOURCE_INFO,
      name: "agent-info",
      title: "Agent 信息",
      description: "当前 Agent 的 id / slug / 能力开关与工作区概况（JSON）",
      mimeType: "application/json",
    },
    {
      uri: RESOURCE_CAPABILITIES,
      name: "agent-capabilities",
      title: "Agent 能力声明",
      description: "MCP / Computer / Memory / Web 等能力与绑定模式",
      mimeType: "application/json",
    },
    {
      uri: RESOURCE_INSTRUCTIONS,
      name: "agent-instructions",
      title: "Agent 使用说明",
      description: "给 Host / 模型的简短操作指引（纯文本）",
      mimeType: "text/plain",
    },
  ];
}

/** 工作区 Resource Template（默认开启；exposeWorkspaceFs === false 时关闭） */
export function listAgentNativeResourceTemplates(agent: Agent): McpResourceTemplateDef[] {
  if (!isWorkspaceFsExposedViaMcp(agent)) return [];
  return [
    {
      uriTemplate: FS_URI_TEMPLATE,
      name: "workspace-fs",
      title: "云端工作区文件",
      description:
        "读取 Agent 云端工作区任意路径。将 {+path} 换成相对路径，如 src/app.ts → zakura://agent/fs/src/app.ts；目录返回 JSON 列表。",
      mimeType: "text/plain",
    },
  ];
}

/**
 * 枚举工作区顶层条目为具体 Resources（可直接 list/read）。
 * 深层路径请用 Resource Template。
 */
export async function listWorkspaceFsResources(
  fs: WorkspaceFs,
): Promise<McpResourceDef[]> {
  const out: McpResourceDef[] = [
    {
      uri: `${FS_URI_PREFIX}/`,
      name: "workspace-root",
      title: "工作区根目录",
      description: "云端工作区根目录列表（JSON）。深层文件请用模板 zakura://agent/fs/{+path}",
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
            ? `工作区目录 /${rel}（read 返回子项 JSON）`
            : `工作区文件 /${rel}`,
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

/** zakura://agent/fs[/path] → 工作区相对路径（以 / 开头） */
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
    const fsHint = isWorkspaceFsExposedViaMcp(agent)
      ? [
          "- 工作区 FS：Resources 列出顶层文件；深层路径用模板 zakura://agent/fs/{+path}",
          "  例：zakura://agent/fs/README.md",
        ].join("\n")
      : "- 工作区 FS：未通过 MCP Resources 暴露（可在 Agent → MCP 开启「暴露云端文件系统」）";
    const text = [
      `# Zakura Agent: ${agent.name} (${agent.slug})`,
      "",
      "这是 Zakura 聚合网关暴露的 Agent MCP 端点。",
      "- tools：原生工具（re_*）+ 已绑定上游 MCP 工具",
      "- resources：具体可枚举 URI（平台 + 上游 + 可选工作区顶层文件）",
      "- resource templates：URI 模板，填参后再 resources/read",
      "- prompts：平台提示词 + 上游 prompts",
      "- ping：存活探测（空结果）",
      "- 长耗时 / 破坏性工具可带 task 参数异步执行；input_required 时用 tasks/update 确认",
      fsHint,
      "",
      `Computer: ${agent.enableComputer ? "on" : "off"}`,
      `Memory: ${agent.enableMemory ? "on" : "off"}`,
      `MCP mode: ${getAgentMcpMode(agent)}`,
    ].join("\n");
    return {
      contents: [{ uri, mimeType: "text/plain", text }],
    };
  }

  return null;
}

/** 读取云端工作区文件/目录 */
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
    throw Object.assign(new Error(`无法读取工作区资源 ${uri}: ${message}`), {
      code: -32602,
      data: { uri },
    });
  }
}

/** 平台内置 prompts */
export function listAgentNativePrompts(agent: Agent): McpPromptDef[] {
  void agent;
  return [
    {
      name: "re_agent_briefing",
      title: "Agent 简报",
      description: "生成当前 Agent 能力与推荐工具用法的简报",
      arguments: [
        {
          name: "focus",
          description: "关注点：tools | resources | safety | all",
          required: false,
        },
      ],
    },
    {
      name: "re_tool_plan",
      title: "工具调用计划",
      description: "根据用户目标，规划应调用的 re_* / 上游工具顺序",
      arguments: [
        {
          name: "goal",
          description: "用户目标（自然语言）",
          required: true,
        },
      ],
    },
    {
      name: "re_safe_exec",
      title: "安全执行检查清单",
      description: "在执行 shell / 破坏性工具前的确认清单",
      arguments: [
        {
          name: "action",
          description: "拟执行的操作摘要",
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
      description: "Agent 能力简报",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `请基于 Agent「${agent.name}」(slug=${agent.slug}) 写一份简报。`,
              `关注点: ${focus}`,
              `Computer=${agent.enableComputer ? "on" : "off"}, Memory=${agent.enableMemory ? "on" : "off"}, mcp.mode=${getAgentMcpMode(agent)}`,
              "先读取资源 zakura://agent/info 与 zakura://agent/capabilities，再总结可用 tools/resources/prompts 与注意事项。",
            ].join("\n"),
          },
        },
      ],
    };
  }

  if (n === "re_tool_plan") {
    const goal = args?.goal?.trim() || "（未提供 goal）";
    return {
      description: "工具调用计划",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `目标：${goal}`,
              `Agent：${agent.name} (${agent.slug})`,
              "请列出推荐工具调用顺序（名称 + 关键参数），优先使用 re_ 前缀原生工具；需要外部能力时再选上游工具。",
              "若涉及破坏性操作，在计划中加入确认步骤。",
            ].join("\n"),
          },
        },
      ],
    };
  }

  if (n === "re_safe_exec") {
    const action = args?.action?.trim() || "（未提供 action）";
    return {
      description: "安全执行检查清单",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `拟执行：${action}`,
              "请按清单检查：1) 是否可逆 2) 影响范围 3) 是否需要 tasks/update 确认 4) 失败回滚方案。",
              "若风险高，明确要求用户确认后再调用工具。",
            ].join("\n"),
          },
        },
      ],
    };
  }

  return null;
}
