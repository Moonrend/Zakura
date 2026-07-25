/**
 * Normalize a host path for Linux Docker Engine bind mounts.
 * Always emits a POSIX path. Accidental Windows drive paths (local dev)
 * are mapped to the WSL/Linux convention `/mnt/<drive>/...`.
 */
export function toDockerHostPath(hostPath: string): string {
  let p = hostPath.replace(/\\/g, "/").replace(/\/+/g, "/");
  const drive = p.match(/^([A-Za-z]):\/(.*)$/);
  if (drive) {
    return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]}`;
  }
  return p;
}

/**
 * Strip a single layer of wrapping quotes from a shell command when the entire
 * string is quoted. Common when users paste `command: "..."` from tool UIs.
 * Without this, bash -lc receives `"find … | sort"` and treats the whole
 * pipeline as one command name → exit 127.
 */
export function unwrapShellCommand(command: string): string {
  const t = command.trim();
  if (t.length < 2) return command;
  const q = t[0];
  if ((q !== '"' && q !== "'") || t[t.length - 1] !== q) return command;
  const inner = t.slice(1, -1);
  // Only unwrap when it looks like a multi-token shell line, not a single quoted word
  if (!/[\s|&;<>]/.test(inner)) return command;
  return inner;
}
