/**
 * 技能来源解析：把用户粘贴的任意一句话归一成 SkillSource。
 *
 * 支持的输入（与 vercel-labs/skills CLI 对齐）：
 *   npx skills add vercel-labs/agent-skills --skill frontend-design
 *   npx -y skills@latest add owner/repo -a claude-code -g -y
 *   pnpm dlx skills add https://github.com/owner/repo/tree/main/skills/foo
 *   bunx skills use owner/repo@web-design-guidelines | claude
 *   owner/repo · owner/repo@skill · owner/repo#branch
 *   https://github.com/owner/repo/blob/main/skills/foo/SKILL.md
 *   https://raw.githubusercontent.com/owner/repo/main/skills/foo/SKILL.md
 *   git@github.com:owner/repo.git · https://gitlab.com/org/repo/-/tree/main/skills
 *   https://skills.sh/owner/repo/skill
 *   builtin:find-skills
 */
import type { SkillFrontmatter, SkillSource } from "@zakura/shared";

/** 包管理器执行前缀，解析时整体跳过 */
const RUNNER_TOKENS = new Set(["npx", "bunx", "pnpx", "yarn", "pnpm", "npm", "bun", "deno"]);
const RUNNER_SUBCOMMANDS = new Set(["dlx", "exec", "run", "x"]);
/** CLI 包名（可带版本后缀） */
const CLI_PACKAGE_RE = /^(?:@[\w.-]+\/)?skills(?:@[\w.\-^~*]+)?$/i;
const CLI_SUBCOMMANDS = new Set(["add", "install", "use", "i", "get"]);

/** 取值型 flag（其后紧跟一个或多个值） */
const VALUE_FLAGS: Record<string, "skills" | "ref" | "ignore"> = {
  "-s": "skills",
  "--skill": "skills",
  "--skills": "skills",
  "-a": "ignore",
  "--agent": "ignore",
  "--agents": "ignore",
  "-r": "ref",
  "--ref": "ref",
  "--branch": "ref",
  "--tag": "ref",
};

/** 抓取失败的粗分类，供调用方决定要不要换 token 重试 */
export type SkillSourceErrorCode = "parse" | "not_found" | "forbidden" | "rate_limit" | "http";

export class SkillSourceError extends Error {
  readonly code: SkillSourceErrorCode;

  constructor(message: string, code: SkillSourceErrorCode = "parse") {
    super(message);
    this.name = "SkillSourceError";
    this.code = code;
  }
}

/** 命令行切词：支持单双引号，遇到 `|`、`&&`、`;` 截断（管道给 claude 的写法） */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "\\" && input[i + 1] === "\n") {
      i += 1;
      continue;
    }
    if (ch === "|" || ch === ";" || (ch === "&" && input[i + 1] === "&")) break;
    if (/\s/.test(ch)) {
      if (cur) tokens.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function stripRunnerPrefix(tokens: string[]): string[] {
  let i = 0;
  // npx / pnpm dlx / yarn dlx / bunx …
  while (i < tokens.length) {
    const t = tokens[i]!.toLowerCase();
    if (RUNNER_TOKENS.has(t)) {
      i += 1;
      while (i < tokens.length && tokens[i]!.startsWith("-")) i += 1;
      if (i < tokens.length && RUNNER_SUBCOMMANDS.has(tokens[i]!.toLowerCase())) i += 1;
      continue;
    }
    break;
  }
  // 跳过 CLI 包名与子命令
  if (i < tokens.length && CLI_PACKAGE_RE.test(tokens[i]!)) i += 1;
  while (i < tokens.length && tokens[i]!.startsWith("-")) i += 1;
  if (i < tokens.length && CLI_SUBCOMMANDS.has(tokens[i]!.toLowerCase())) i += 1;
  return tokens.slice(i);
}

function looksLikeSource(token: string): boolean {
  if (token.startsWith("-")) return false;
  return (
    token.includes("://") ||
    token.includes(":") ||
    /^[\w.-]+\/[\w.-]+/.test(token) ||
    token.startsWith(".") ||
    token.startsWith("/")
  );
}

/** 拆分 `spec@skill` / `spec#ref`（URL 中的 @ # 不算） */
function splitSelectors(spec: string): { base: string; skill?: string; ref?: string } {
  let base = spec;
  let skill: string | undefined;
  let ref: string | undefined;

  const hash = base.lastIndexOf("#");
  if (hash > 0 && !base.slice(hash).includes("/")) {
    ref = base.slice(hash + 1) || undefined;
    base = base.slice(0, hash);
  }
  // `owner/repo@skill`：技能名前必须有 `/`，才不会误伤 git@host:owner/repo.git
  const at = base.lastIndexOf("@");
  if (at > 0 && base.slice(0, at).includes("/") && !base.slice(at).includes("/")) {
    skill = base.slice(at + 1) || undefined;
    base = base.slice(0, at);
  }
  return { base, skill, ref };
}

/** 从 owner/repo 之后的路径段里解析 ref 与子路径 */
function parseGithubTail(
  segments: string[],
): { ref?: string; path?: string } {
  if (!segments.length) return {};
  const [head, ...rest] = segments;
  if ((head === "tree" || head === "blob") && rest.length) {
    const ref = rest[0];
    const path = rest.slice(1).join("/");
    return { ...(ref ? { ref } : {}), ...(path ? { path } : {}) };
  }
  return { path: segments.join("/") };
}

/** SKILL.md 直链 → 技能目录 */
function stripManifest(path?: string): string | undefined {
  if (!path) return undefined;
  const cleaned = path.replace(/^\/+|\/+$/g, "");
  if (/\/SKILL\.md$/i.test(cleaned)) return cleaned.replace(/\/SKILL\.md$/i, "");
  if (/^SKILL\.md$/i.test(cleaned)) return "";
  return cleaned;
}

function githubSource(
  owner: string,
  repo: string,
  extra: { ref?: string; path?: string; skills?: string[]; raw: string },
): SkillSource {
  const path = stripManifest(extra.path);
  return {
    kind: "github",
    owner,
    repo: repo.replace(/\.git$/i, ""),
    ...(extra.ref ? { ref: extra.ref } : {}),
    ...(path ? { path } : {}),
    ...(extra.skills?.length ? { skills: extra.skills } : {}),
    raw: extra.raw,
    store: "github",
  };
}

function parseSpec(spec: string, raw: string, flagSkills: string[], flagRef?: string): SkillSource {
  const { base, skill, ref: selectorRef } = splitSelectors(spec.trim());
  const skills = [...flagSkills, ...(skill ? [skill] : [])];
  const ref = flagRef ?? selectorRef;

  if (!base) throw new SkillSourceError("来源为空");

  if (/^builtin:/i.test(base)) {
    return {
      kind: "builtin",
      builtinId: base.slice("builtin:".length),
      raw,
      store: "builtin",
    };
  }

  // git@github.com:owner/repo.git
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(.+)$/.exec(base);
  if (scp && !base.includes("://")) {
    const host = scp[1]!.toLowerCase();
    const parts = scp[2]!.replace(/^\/+/, "").split("/").filter(Boolean);
    if (host.includes("github.com") && parts.length >= 2) {
      return githubSource(parts[0]!, parts[1]!, {
        ...(ref ? { ref } : {}),
        ...(parts.length > 2 ? { path: parts.slice(2).join("/") } : {}),
        skills,
        raw,
      });
    }
    if (parts.length >= 2) {
      return {
        kind: "git",
        url: base,
        ...(ref ? { ref } : {}),
        ...(skills.length ? { skills } : {}),
        raw,
      };
    }
  }

  if (/^https?:\/\//i.test(base) || base.startsWith("www.")) {
    const normalized = base.startsWith("www.") ? `https://${base}` : base;
    let url: URL;
    try {
      url = new URL(normalized);
    } catch {
      throw new SkillSourceError(`无法解析 URL：${base}`);
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const segments = url.pathname.split("/").filter(Boolean);

    if (host === "github.com" && segments.length >= 2) {
      const tail = parseGithubTail(segments.slice(2));
      return githubSource(segments[0]!, segments[1]!, {
        ...(ref ?? tail.ref ? { ref: ref ?? tail.ref } : {}),
        ...(tail.path ? { path: tail.path } : {}),
        skills,
        raw,
      });
    }
    if (host === "raw.githubusercontent.com" && segments.length >= 3) {
      // /owner/repo/<ref>/<path...>
      return githubSource(segments[0]!, segments[1]!, {
        ref: ref ?? segments[2]!,
        path: segments.slice(3).join("/"),
        skills,
        raw,
      });
    }
    if (host === "skills.sh" && segments.length >= 2) {
      // /owner/repo[/skill]
      const picked = segments.length > 2 ? [segments.slice(2).join("/")] : [];
      return {
        ...githubSource(segments[0]!, segments[1]!, {
          ...(ref ? { ref } : {}),
          skills: [...skills, ...picked],
          raw,
        }),
        store: "skills-sh",
      };
    }
    if (host === "gitlab.com" && segments.length >= 2) {
      // 形如 /group/sub/repo/-/tree/<ref>/<path>
      const idx = segments.indexOf("-");
      const nsParts = idx >= 0 ? segments.slice(0, idx) : segments;
      const tail = idx >= 0 ? parseGithubTail(segments.slice(idx + 1)) : {};
      const gitlabRef = ref ?? tail.ref;
      const path = stripManifest(tail.path);
      return {
        kind: "gitlab",
        owner: nsParts.slice(0, -1).join("/"),
        repo: nsParts[nsParts.length - 1]!,
        ...(gitlabRef ? { ref: gitlabRef } : {}),
        ...(path ? { path } : {}),
        ...(skills.length ? { skills } : {}),
        raw,
      };
    }
    if (/\.git$/i.test(url.pathname)) {
      return {
        kind: "git",
        url: normalized,
        ...(ref ? { ref } : {}),
        ...(skills.length ? { skills } : {}),
        raw,
      };
    }
    return {
      kind: "url",
      url: normalized,
      ...(skills.length ? { skills } : {}),
      raw,
    };
  }

  // owner/repo[/sub/path]
  const parts = base.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length >= 2 && /^[\w.-]+$/.test(parts[0]!) && /^[\w.-]+$/.test(parts[1]!)) {
    return githubSource(parts[0]!, parts[1]!, {
      ...(ref ? { ref } : {}),
      ...(parts.length > 2 ? { path: parts.slice(2).join("/") } : {}),
      skills,
      raw,
    });
  }

  // 形如 example.com / example.com@skill 的域名托管技能：
  // skills.sh 上有这类条目，但没有可公开抓取的地址
  const host = base.split("@")[0]!;
  if (!host.includes("/") && /^[\w-]+(\.[\w-]+)+$/.test(host)) {
    throw new SkillSourceError(
      `暂不支持域名托管的技能：${host}。请改用 GitHub 仓库（owner/repo）或 SKILL.md 直链`,
    );
  }

  throw new SkillSourceError(
    `无法识别的技能来源：${spec}。支持 owner/repo、GitHub 链接、npx skills add … 等格式`,
  );
}

/**
 * 把任意输入解析成 SkillSource。
 * 多行输入取第一条非空、非注释行（用户常整段粘贴带说明的安装指引）。
 */
export function parseSkillSource(input: string): SkillSource {
  const raw = input.trim();
  if (!raw) throw new SkillSourceError("请输入技能来源");

  const line =
    raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"))
      .map((l) => l.replace(/^[$>]\s+/, ""))
      .find((l) => l) ?? raw;

  const rest = stripRunnerPrefix(tokenize(line));
  if (!rest.length) throw new SkillSourceError("未找到技能来源");

  const skills: string[] = [];
  const positionals: string[] = [];
  let ref: string | undefined;
  let wantAll = false;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token === "--all") {
      wantAll = true;
      continue;
    }
    // --skill=a 形式
    const eq = token.indexOf("=");
    if (eq > 0) {
      const kind = VALUE_FLAGS[token.slice(0, eq)];
      const value = token.slice(eq + 1);
      if (kind === "skills" && value) skills.push(value);
      else if (kind === "ref" && value) ref = value;
      continue;
    }
    const kind = VALUE_FLAGS[token];
    if (!kind) continue; // 布尔 flag（-g/-y/--copy/…）忽略
    const values: string[] = [];
    while (i + 1 < rest.length && !rest[i + 1]!.startsWith("-")) {
      values.push(rest[++i]!);
    }
    // 变长 flag 可能吞掉唯一的来源（`--skill a owner/repo`）
    if (!positionals.length && values.length > 1 && looksLikeSource(values[values.length - 1]!)) {
      positionals.push(values.pop()!);
    }
    if (kind === "skills") skills.push(...values);
    else if (kind === "ref" && values[0]) ref = values[0];
  }

  const spec = positionals.find(looksLikeSource) ?? positionals[0];
  if (!spec) throw new SkillSourceError("未找到技能来源");

  const source = parseSpec(spec, raw, wantAll ? ["*"] : skills, ref);
  return source;
}

/** 归一化技能名：小写、非字母数字转连字符，用作目录名 */
export function normalizeSkillName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  return cleaned || "skill";
}

/** 来源的人类可读标识，如 `vercel-labs/agent-skills` */
export function describeSkillSource(source: SkillSource): string {
  if (source.kind === "builtin") return "Zakura 内置";
  if (source.owner && source.repo) {
    const base = `${source.owner}/${source.repo}`;
    return source.path ? `${base}/${source.path}` : base;
  }
  return source.url ?? source.raw ?? source.kind;
}

/** 可再次粘贴安装的规范串（`@skill` 在前、`#ref` 在后，与解析顺序一致） */
export function skillSourceToSpec(source: SkillSource, skillName?: string): string {
  if (source.kind === "builtin") return `builtin:${source.builtinId ?? skillName ?? ""}`;
  if (source.owner && source.repo) {
    let spec = `${source.owner}/${source.repo}`;
    if (source.path) spec += `/${source.path}`;
    if (skillName) spec += `@${skillName}`;
    if (source.ref) spec += `#${source.ref}`;
    return spec;
  }
  return source.url ?? source.raw ?? "";
}

// —— SKILL.md frontmatter ——

const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (!value) return "";
  if (/^(true|yes)$/i.test(value)) return true;
  if (/^(false|no)$/i.test(value)) return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((s) => String(parseScalar(s)))
      .filter(Boolean);
  }
  return value;
}

/** YAML 折叠标量（`>`）：同段内换行折成空格，空行才是真正的段落分隔 */
function foldLines(lines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (!line) {
      if (current.length) paragraphs.push(current.join(" "));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) paragraphs.push(current.join(" "));
  return paragraphs.join("\n\n");
}

/**
 * 极简 YAML frontmatter 解析：标量、块标量（| 与 >）、块级列表、单层嵌套对象。
 * 覆盖 Agent Skills 规范用到的全部字段；解析失败按无 frontmatter 处理。
 */
export function parseSkillMarkdown(text: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return { frontmatter: {}, body: text.replace(/^﻿/, "") };

  const frontmatter: Record<string, unknown> = {};
  const lines = match[1]!.split(/\r?\n/);
  const KV_RE = /^([\w.$-]+)\s*:\s*(.*)$/;
  const indentOf = (line: string) => line.length - line.trimStart().length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (indentOf(line) > 0) continue; // 已被上一轮的块收集消费

    const kv = KV_RE.exec(trimmed);
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2]!;

    // YAML 块标量：`|` 保留换行、`>` 折叠成空格，后缀 -/+ 控制结尾换行。
    // 技能仓库里长 description 基本都是这么写的，不解开会得到字面量 "|-"。
    const block = /^([|>])([+-]?)(\d*)$/.exec(value);
    if (block) {
      const folded = block[1] === ">";
      const collected: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const next = lines[j]!;
        if (!next.trim()) {
          collected.push("");
          continue;
        }
        if (indentOf(next) === 0) break;
        collected.push(next.trimStart());
      }
      i = j - 1;
      while (collected.length && collected[collected.length - 1] === "") collected.pop();
      frontmatter[key] = folded ? foldLines(collected) : collected.join("\n");
      continue;
    }

    if (value !== "") {
      frontmatter[key] = parseScalar(value);
      continue;
    }

    // 空值：向下收集缩进更深的行，判定为块级列表还是嵌套对象
    const items: string[] = [];
    const obj: Record<string, unknown> = {};
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = lines[j]!;
      if (!next.trim()) continue;
      const nextIndent = indentOf(next);
      if (nextIndent === 0) break;
      const t = next.trim();
      if (t.startsWith("- ")) {
        items.push(String(parseScalar(t.slice(2))));
        continue;
      }
      const nkv = KV_RE.exec(t);
      if (!nkv) continue;
      const nestedKey = nkv[1]!;
      const nestedValue = nkv[2]!;
      if (nestedValue !== "") {
        obj[nestedKey] = parseScalar(nestedValue);
        continue;
      }
      // 嵌套对象里的块级列表
      const sub: string[] = [];
      let k = j + 1;
      for (; k < lines.length; k++) {
        const subLine = lines[k]!;
        if (!subLine.trim()) continue;
        if (indentOf(subLine) <= nextIndent) break;
        const st = subLine.trim();
        if (st.startsWith("- ")) sub.push(String(parseScalar(st.slice(2))));
      }
      obj[nestedKey] = sub;
      j = k - 1;
    }
    i = j - 1;

    if (items.length) frontmatter[key] = items;
    else if (Object.keys(obj).length) frontmatter[key] = obj;
    else frontmatter[key] = "";
  }

  return {
    frontmatter,
    body: text.slice(match[0].length).replace(/^\s*\n/, ""),
  };
}

/** frontmatter → 强类型；name/description 缺失时由调用方兜底 */
export function toSkillFrontmatter(
  raw: Record<string, unknown>,
  fallbackName: string,
): SkillFrontmatter {
  const name =
    typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : fallbackName;
  const description =
    typeof raw.description === "string" ? raw.description.trim() : "";
  return { ...raw, name, description };
}

/** 生成 SKILL.md 文本（内置技能与技能创建器共用） */
export function buildSkillMarkdown(
  frontmatter: { name: string; description: string; [key: string]: unknown },
  body: string,
): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
      continue;
    }
    if (typeof value === "object") {
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`  ${k}: ${v}`);
      }
      continue;
    }
    const str = String(value);
    lines.push(`${key}: ${/[:#]/.test(str) ? JSON.stringify(str) : str}`);
  }
  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}
