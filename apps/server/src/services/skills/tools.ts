/**
 * 技能相关的 Agent 原生工具执行：list_skills / read_skill / search_skills / install_skill。
 * 工具定义在 agent-tools.ts，执行放这里以免 callAgentNativeTool 再吃一个位置参数。
 */
import { textResult } from "@zakura/core";
import { SKILL_MANIFEST_FILE, type McpToolResult, type SkillStoreId } from "@zakura/shared";
import type { Agent } from "../../db/schema.js";
import { normalizeSkillName } from "./source.js";
import { searchSkillStores } from "./store.js";
import type { SkillsService } from "./service.js";

const SKILL_TOOL_NAMES = new Set(["list_skills", "read_skill", "search_skills", "install_skill"]);

export function isSkillToolName(localName: string): boolean {
  return SKILL_TOOL_NAMES.has(localName);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function callSkillTool(
  service: SkillsService | null,
  agent: Agent,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  if (!service) return textResult("技能系统未启用", true);

  try {
    if (name === "list_skills") {
      const all = await service.listForAgent(agent.tenantId, agent.id);
      const list = args.include_disabled === true ? all : all.filter((s) => s.enabled);
      if (!list.length) {
        return textResult(
          "当前没有已安装的技能。用 search_skills 查找，再用 install_skill 安装。",
        );
      }
      return textResult(
        JSON.stringify(
          list.map((s) => ({
            name: s.name,
            description: s.description,
            path: `${s.path}/${SKILL_MANIFEST_FILE}`,
            enabled: s.enabled,
            builtin: s.builtin,
            status: s.status,
          })),
          null,
          2,
        ),
      );
    }

    if (name === "read_skill") {
      const skillName = str(args.name);
      if (!skillName) return textResult("name is required", true);
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
      const registered = await service.list(agent.tenantId);
      const installedNames = new Set(registered.map((s) => s.name.toLowerCase()));
      const { items, errors } = await searchSkillStores({
        query,
        store,
        installedNames,
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
            hint: "用 install_skill 传 source=<install_spec> 安装；安装前先向用户说明。",
          },
          null,
          2,
        ),
      );
    }

    if (name === "install_skill") {
      const workspacePath = str(args.path);
      if (workspacePath) {
        const record = await service.registerFromWorkspace(
          agent.tenantId,
          agent,
          workspacePath,
        );
        return textResult(
          JSON.stringify(
            {
              installed: record.name,
              path: `/skills/${record.name}`,
              description: record.description,
              note: "已登记进技能注册表，可安装到其他 Agent。",
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
            installed: result.skills.map((s) => ({
              name: s.name,
              description: s.description,
              path: `/skills/${s.name}/${SKILL_MANIFEST_FILE}`,
            })),
            warnings: result.warnings,
            note: "已写入工作区。现在用 read_skill 读取内容并按其执行当前任务。",
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
