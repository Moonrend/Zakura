"use client";

import { api } from "@/lib/api";
import type {
  AgentSkillRecord,
  SkillAutoUpdateStatus,
  SkillCacheStatus,
  SkillRecord,
  SkillRepoSummary,
  SkillResolveResult,
  SkillSearchItem,
  SkillSearchPage,
  SkillStoreId,
  SkillStoreMeta,
  SkillTokenInfo,
  SkillTokenProvider,
  SkillTokenScope,
  SkillUpdateSummary,
} from "@zakura/shared";

export { DEFAULT_SKILL_STORE, SKILL_STORES } from "@zakura/shared";

export type {
  AgentSkillRecord,
  SkillAutoUpdateStatus,
  SkillCacheStatus,
  SkillRecord,
  SkillRepoSummary,
  SkillResolveResult,
  SkillSearchItem,
  SkillSearchPage,
  SkillStoreId,
  SkillStoreMeta,
  SkillTokenInfo,
  SkillTokenProvider,
  SkillTokenScope,
  SkillUpdateSummary,
};

export type BuiltinSkillMeta = {
  name: string;
  title: string;
  description: string;
  recommended: boolean;
  requires: Array<"computer" | "browser" | "memory" | "web">;
  tags: string[];
};

export type SkillFileContent = {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  size: number;
};

export const SKILL_STORE_LABEL: Record<SkillStoreId, string> = {
  builtin: "内置技能",
  curated: "官方仓库",
  "skills-sh": "skills.sh",
  github: "GitHub",
};

export async function fetchSkillStores(): Promise<{
  stores: SkillStoreMeta[];
  builtin: BuiltinSkillMeta[];
}> {
  return api("/api/skills/stores", { cacheTtlMs: 60_000 });
}

/** 单商店检索：分页与总数都属于该商店 */
export async function searchSkills(
  query: string,
  store: SkillStoreId,
  opts: { repo?: string; offset?: number; limit?: number } = {},
): Promise<SkillSearchPage> {
  const params = new URLSearchParams({ q: query, store });
  if (opts.repo) params.set("repo", opts.repo);
  if (opts.offset) params.set("offset", String(opts.offset));
  if (opts.limit) params.set("limit", String(opts.limit));
  return api(`/api/skills/search?${params.toString()}`, { cacheTtlMs: 15_000 });
}

/** 服务端已同步的技能仓库（商店入口） */
export async function listSkillRepos(): Promise<SkillRepoSummary[]> {
  const res = await api<{ repos: SkillRepoSummary[] }>("/api/skills/repos", {
    cacheTtlMs: 30_000,
  });
  return res.repos;
}

export async function syncSkillRepo(slug: string): Promise<SkillRepoSummary> {
  const res = await api<{ repo: SkillRepoSummary }>(
    `/api/skills/repos/${slug}/sync`,
    { method: "POST" },
  );
  return res.repo;
}

export async function fetchSkillCacheStatus(): Promise<SkillCacheStatus> {
  return api("/api/skills/cache");
}

export async function fetchSkillAutoUpdate(): Promise<SkillAutoUpdateStatus> {
  return api("/api/skills/auto-update");
}

/** @deprecated 全局开关已废弃；请用 setSkillItemAutoUpdate */
export async function setSkillAutoUpdate(enabled: boolean): Promise<SkillAutoUpdateStatus> {
  return api("/api/skills/auto-update", { method: "PUT", json: { enabled } });
}

/** 单个第三方技能的自动更新开关 */
export async function setSkillItemAutoUpdate(
  skillId: string,
  enabled: boolean,
): Promise<SkillRecord> {
  const res = await api<{ skill: SkillRecord }>(`/api/skills/${encodeURIComponent(skillId)}/auto-update`, {
    method: "PATCH",
    json: { enabled },
  });
  return res.skill;
}

/** 立即探一遍上游并把有新版本的技能更新掉 */
export async function checkSkillUpdates(): Promise<{
  result: SkillUpdateSummary;
  status: SkillAutoUpdateStatus;
}> {
  return api("/api/skills/check-updates", { method: "POST" });
}

export async function listSkillTokens(): Promise<{
  tokens: SkillTokenInfo[];
  canManagePlatform: boolean;
}> {
  return api("/api/skills/tokens");
}

export async function saveSkillToken(body: {
  provider: SkillTokenProvider;
  token: string;
  scope: SkillTokenScope;
  label?: string;
}): Promise<SkillTokenInfo> {
  const res = await api<{ token: SkillTokenInfo }>(
    `/api/skills/tokens/${body.provider}`,
    { method: "PUT", json: body },
  );
  return res.token;
}

export async function deleteSkillToken(
  provider: SkillTokenProvider,
  scope: SkillTokenScope,
): Promise<void> {
  await api(`/api/skills/tokens/${provider}?scope=${scope}`, { method: "DELETE" });
}

export async function resolveSkillSource(source: string): Promise<SkillResolveResult> {
  return api("/api/skills/resolve", { method: "POST", json: { source } });
}

export async function listSkills(): Promise<SkillRecord[]> {
  const res = await api<{ skills: SkillRecord[] }>("/api/skills");
  return res.skills;
}

export async function getSkill(
  id: string,
): Promise<{ skill: SkillRecord; files: SkillFileContent[] }> {
  return api(`/api/skills/${encodeURIComponent(id)}`);
}

export async function installSkill(body: {
  source?: string;
  skillId?: string;
  names?: string[];
  agentIds?: string[];
  all?: boolean;
}): Promise<{
  skills: SkillRecord[];
  installs: AgentSkillRecord[];
  warnings: string[];
}> {
  const target = body.all || body.agentIds?.length ? body : { ...body, all: true };
  return api("/api/skills/install", { method: "POST", json: target });
}

export async function updateSkill(id: string): Promise<SkillRecord> {
  const res = await api<{ skill: SkillRecord }>(
    `/api/skills/${encodeURIComponent(id)}/update`,
    { method: "POST" },
  );
  return res.skill;
}

export async function deleteSkill(id: string): Promise<void> {
  await api(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function listAgentSkills(
  agentId: string,
): Promise<{ skills: AgentSkillRecord[]; unregistered: string[] }> {
  return api(`/api/agents/${encodeURIComponent(agentId)}/skills`);
}

export async function installToAgent(
  agentId: string,
  body: { source?: string; skillId?: string; names?: string[]; workspacePath?: string },
): Promise<{ skills: SkillRecord[]; installs: AgentSkillRecord[]; warnings: string[] }> {
  return api(`/api/agents/${encodeURIComponent(agentId)}/skills`, {
    method: "POST",
    json: body,
  });
}

export async function setAgentSkillEnabled(
  agentId: string,
  name: string,
  enabled: boolean,
): Promise<AgentSkillRecord> {
  const res = await api<{ skill: AgentSkillRecord }>(
    `/api/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(name)}`,
    { method: "PATCH", json: { enabled } },
  );
  return res.skill;
}

export async function uninstallAgentSkill(agentId: string, name: string): Promise<void> {
  await api(
    `/api/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
}

export async function readAgentSkillFile(
  agentId: string,
  name: string,
  path?: string,
): Promise<{ path: string; content: string }> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  return api(
    `/api/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(name)}/file${qs}`,
  );
}

/** 数字缩写：1234 → 1.2k */
export function formatCount(n?: number): string | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 2 天前 */
export function formatRelative(iso: string | null | undefined, fallback = "从未"): string {
  if (!iso) return fallback;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return fallback;
  if (ms < 60_000) return "刚刚";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

/** 去掉 SKILL.md 的 YAML frontmatter，只保留正文用于渲染 */
export function parseSkillBody(markdown: string): string {
  const match = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  return match ? markdown.slice(match[0].length).replace(/^\s*\n/, "") : markdown;
}
