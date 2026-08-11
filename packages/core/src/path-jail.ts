import { basename, relative, resolve, sep } from "node:path";

export class PathJailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathJailError";
  }
}

/** 容器内工作区根（与 AGENT_WORKSPACE_ROOT 一致） */
export const CONTAINER_WORKSPACE_ROOT = "/workspace";

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 去掉已知工作区前缀，避免宿主路径 / 容器绝对路径被二次拼接 */
function stripWorkspacePrefixes(rootResolved: string, cleaned: string): string {
  let path = cleaned;
  const rootPosix = toPosix(rootResolved).replace(/\/+$/, "");

  // 模型误用错误信息里的宿主绝对路径：/data/agents/<id>/workspace/...
  if (path === rootPosix || path.startsWith(`${rootPosix}/`)) {
    path = path.slice(rootPosix.length) || "/";
  }

  // 容器绝对路径：/workspace/...
  const container = CONTAINER_WORKSPACE_ROOT.replace(/\/+$/, "");
  if (path === container || path.startsWith(`${container}/`)) {
    path = path.slice(container.length) || "/";
  }

  return path;
}

/** Resolve user path inside workspace root; reject escapes. */
export function resolveInRoot(root: string, userPath: string): string {
  const rootResolved = resolve(root);
  const cleaned = toPosix(userPath || ".");
  const stripped = stripWorkspacePrefixes(rootResolved, cleaned);
  const absoluteHint = stripped.startsWith("/") || /^[A-Za-z]:\//.test(stripped);
  // 其余 leading / 仍按工作区相对路径处理（agent UX）
  const relativeInput = absoluteHint
    ? stripped.replace(/^[A-Za-z]:/, "").replace(/^\/+/, "")
    : stripped;
  const full = resolve(rootResolved, relativeInput || ".");
  const rel = relative(rootResolved, full);
  if (rel.startsWith("..") || rel === ".." || rel.split(sep).includes("..")) {
    throw new PathJailError(`Path escapes workspace: ${userPath}`);
  }
  return full;
}

export function toWorkspacePath(root: string, absPath: string): string {
  const rel = relative(resolve(root), resolve(absPath)).replace(/\\/g, "/");
  return rel === "" ? "." : rel;
}

/** Workspace path: leading slash, never empty. */
export function toApiPath(root: string, absPath: string): string {
  const rel = toWorkspacePath(root, absPath);
  if (rel === "." || rel === "") return "/";
  return `/${rel.replace(/^\/+/, "")}`;
}

export function entryName(root: string, absPath: string): string {
  if (resolve(absPath) === resolve(root)) return "/";
  return basename(absPath);
}

/** 错误信息里的宿主绝对路径改写成 /workspace/...，避免模型把本机路径当沙箱路径重试 */
export function scrubHostPathsInMessage(root: string, message: string): string {
  const rootPosix = toPosix(resolve(root)).replace(/\/+$/, "");
  if (!rootPosix) return message;
  const scrubbed = message.split(rootPosix).join(CONTAINER_WORKSPACE_ROOT);
  // Windows 反斜杠形态
  const rootWin = resolve(root);
  if (rootWin.includes("\\") && message.includes(rootWin)) {
    return message.split(rootWin).join(CONTAINER_WORKSPACE_ROOT);
  }
  return scrubbed;
}
