import { basename, relative, resolve, sep } from "node:path";

export class PathJailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathJailError";
  }
}

/** Resolve user path inside workspace root; reject escapes. */
export function resolveInRoot(root: string, userPath: string): string {
  const rootResolved = resolve(root);
  const cleaned = (userPath || ".").replace(/\\/g, "/");
  const absoluteHint = cleaned.startsWith("/") || /^[A-Za-z]:\//.test(cleaned);
  // Inside sandbox, treat leading / as workspace-relative for agent UX
  const relativeInput = absoluteHint
    ? cleaned.replace(/^[A-Za-z]:/, "").replace(/^\/+/, "")
    : cleaned;
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
