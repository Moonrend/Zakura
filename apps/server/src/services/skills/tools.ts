/**
 * 技能相关的 Agent 原生工具执行：list_skills / read_skill / search_skills / install_skill。
 * 工具定义在 agent-tools.ts，执行放这里以免 callAgentNativeTool 再吃一个位置参数。
 */
import { textResult, type WorkspaceFsProvider } from "@zakura/core";
import { SKILL_MANIFEST_FILE, type McpToolResult, type SkillStoreId } from "@zakura/shared";
import type { Agent } from "../../db/schema.js";
import { normalizeSkillName } from "./source.js";
import type { SkillsService } from "./service.js";
import { listProjectSkills, readProjectSkillFile } from "../project-config.js";

const SKILL_TOOL_NAMES = new Set(["list_skills", "read_skill", "search_skills", "install_skill"]);

export function isSkillToolName(localName: string): boolean {
  return SKILL_TOOL_NAMES.has(localName);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function loadProjectSkillList(
  fsProvider: WorkspaceFsProvider | null | undefined,
  agent: Agent,
  projectSlug?: string,
) {
  if (!fsProvider || !projectSlug) return [];
  try {
    const fs = await fsProvider.forAgentBinding({
      id: agent.id,
      tenantId: agent.tenantId,
      runtimeNodeId: agent.runtimeNodeId,
    });
    return await listProjectSkills(fs, projectSlug);
  } catch {
    return [];
  }
}

export async function callSkillTool(
  service: SkillsService | null,
  agent: Agent,
  name: string,
  args: Record<string, unknown>,
  extra?: { projectSlug?: string; fsProvider?: WorkspaceFsProvider | null },
): Promise<McpToolResult> {
  if (!service) return textResult("技能系统未启用", true);

  try {
    if (name === "list_skills") {
      const all = await service.listForAgent(agent.tenantId, agent.id);
      const list = args.include_disabled === true ? all : all.filter((s) => s.enabled);
      const projectSkills = await loadProjectSkillList(
        extra?.fsProvider,
        agent,
        extra?.projectSlug,
      );
      if (!list.length && !projectSkills.length) {
        return textResult(
          "当前没有已安装的技能。用 search_skills 查找，再用 install_skill 安装。项目技能可放在 .agents/skills/<名>/SKILL.md。",
        );
      }
      return textResult(
        JSON.stringify(
          [
            ...projectSkills.map((s) => ({
              name: s.name,
              description: s.description,
              path: s.path,
              enabled: true,
              scope: "project",
              status: "installed",
            })),
            ...list.map((s) => ({
              name: s.name,
              description: s.description,
              path: `${s.path}/${SKILL_MANIFEST_FILE}`,
              enabled: s.enabled,
              builtin: s.builtin,
              scope: "agent",
              status: s.status,
            })),
          ],
          null,
          2,
        ),
      );
    }

    if (name === "read_skill") {
      const skillName = str(args.name);
      if (!skillName) return textResult("name is required", true);
      if (extra?.projectSlug && extra.fsProvider) {
        try {
          const fs = await extra.fsProvider.forAgentBinding({
            id: agent.id,
            tenantId: agent.tenantId,
            runtimeNodeId: agent.runtimeNodeId,
          });
          const projectFile = await readProjectSkillFile(
            fs,
            extra.projectSlug,
            skillName,
            str(args.path),
          );
          if (projectFile) return textResult(projectFile.content);
        } catch {
          /* fall through to agent skills */
        }
      }
      const file = await service.readSkillFile(
        agent.tenantId,
        agent,
        skillName,
        str(args.path),
      );
      if (!file) {
        return textResult(
          `未找到技能 ${skillName}${args.path ? ` 的文件 ${String(args.path)}` : ""}。先用 list_skills 确认已安装。`,
          true,
        );
      }
      return textResult(file.content);
    }

    if (name === "search_skills") {
      const query = str(args.query) ?? "";
      const store = (str(args.store) ?? "all") as SkillStoreId | "all";
      const { items, errors } = await service.searchAcross(agent.tenantId, {
        query,
        store,
        limit: 25,
      });
      if (!items.length) {
        return textResult(
          `没有找到与「${query}」相关的技能。${errors.length ? `（${errors.map((e) => `${e.store}: ${e.error}`).join("; ")}）` : ""}`,
        );
      }
      return textResult(
        JSON.stringify(
          {
            results: items.slice(0, 25).map((item) => ({
              name: item.name,
              description: item.description,
              store: item.store,
              source: item.source,
              install_spec: item.installSpec,
              installs: item.installs,
              stars: item.stars,
              installed: item.installed ?? false,
              url: item.homepage,
            })),
            hint: "用 install_skill 传 source=<install_spec>。当前会话在项目里时默认装进该项目；只有用户明确要求全局/所有项目共用时才加 scope=agent。安装前先向用户说明。",
          },
          null,
          2,
        ),
      );
    }

    if (name === "install_skill") {
      const workspacePath = str(args.path);
      const explicitScope = str(args.scope);
      const projectSlug = str(args.project) ?? extra?.projectSlug;
      const scope =
        explicitScope === "agent" || explicitScope === "project"
          ? explicitScope
          : projectSlug
            ? "project"
            : "agent";

      if (scope === "project") {
        if (!projectSlug) {
          return textResult(
            "scope=project 需要当前会话已绑定项目，或显式传 project=<slug>。装到本 Agent 全部项目共用则用 scope=agent。",
            true,
          );
        }
        const result = await service.installToProject(agent, projectSlug, {
          ...(workspacePath ? { path: workspacePath } : {}),
          ...(str(args.source) ? { source: str(args.source) } : {}),
          ...(Array.isArray(args.names)
            ? {
                names: args.names
                  .filter((n): n is string => typeof n === "string")
                  .map(normalizeSkillName),
              }
            : {}),
        });
        return textResult(
          JSON.stringify(
            {
              scope: "project",
              project: projectSlug,
              installed: result.skills,
              warnings: result.warnings,
              note: "已写入当前项目 .agents/skills/，仅绑定该项目的会话能看到。现在用 read_skill 读取并执行。",
            },
            null,
            2,
          ),
        );
      }

      if (workspacePath) {
        const record = await service.registerFromWorkspace(
          agent.tenantId,
          agent,
          workspacePath,
        );
        return textResult(
          JSON.stringify(
            {
              scope: "agent",
              installed: record.name,
              path: `/skills/${record.name}`,
              description: record.description,
              note: "已登记到本 Agent 全局 /skills/，所有会话可用。",
            },
            null,
            2,
          ),
        );
      }

      const source = str(args.source);
      if (!source) return textResult("source 或 path 必填", true);
      const names = Array.isArray(args.names)
        ? args.names.filter((n): n is string => typeof n === "string").map(normalizeSkillName)
        : undefined;

      const result = await service.install(agent.tenantId, {
        source,
        ...(names?.length ? { names } : {}),
        agentIds: [agent.id],
      });
      return textResult(
        JSON.stringify(
          {
            scope: "agent",
            installed: result.skills.map((s) => ({
              name: s.name,
              description: s.description,
              path: `/skills/${s.name}/${SKILL_MANIFEST_FILE}`,
            })),
            warnings: result.warnings,
            note: "已写入本 Agent 全局 /skills/，所有项目的会话都能用。现在用 read_skill 读取内容并按其执行当前任务。",
          },
          null,
          2,
        ),
      );
    }

    return textResult(`Unknown skill tool: ${name}`, true);
  } catch (err) {
    return textResult(err instanceof Error ? err.message : String(err), true);
  }
}
