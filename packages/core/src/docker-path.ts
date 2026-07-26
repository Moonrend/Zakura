/**
 * Normalize a host path for Linux Docker Engine bind mounts.
 * Always emits a POSIX path.
 *
 * Windows drive paths are mapped for Docker Desktop's WSL2 VM, where host
 * drives appear under `/mnt/host/<drive>/…`. Mapping to plain `/mnt/<drive>/…`
 * is wrong there: `/mnt` sits on Docker Desktop's tiny (~128MB) user-distro
 * disk, so workspace binds look empty / instantly full.
 *
 * Override with `ZAKURA_DOCKER_HOST_MOUNT_PREFIX` (e.g. `/mnt` for docker-ce
 * inside a normal WSL distro).
 */
export function toDockerHostPath(hostPath: string): string {
  let p = hostPath.replace(/\\/g, "/").replace(/\/+/g, "/");
  const drive = p.match(/^([A-Za-z]):\/(.*)$/);
  if (drive) {
    const letter = drive[1]!.toLowerCase();
    const rest = drive[2];
    const prefix = resolveDockerHostMountPrefix();
    return `${prefix}/${letter}/${rest}`;
  }
  // WSL-style /mnt/<drive>/… passed into Docker Desktop API also needs rewriting
  const wslDrive = p.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (wslDrive && !p.startsWith("/mnt/host/")) {
    const prefix = resolveDockerHostMountPrefix();
    if (prefix !== "/mnt") {
      return `${prefix}/${wslDrive[1]!.toLowerCase()}/${wslDrive[2]}`;
    }
  }
  return p;
}

function resolveDockerHostMountPrefix(): string {
  const fromEnv = process.env.ZAKURA_DOCKER_HOST_MOUNT_PREFIX?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "") || "/mnt/host";
  // win32 Node → Docker Desktop; Linux defaults keep /mnt for native/WSL docker-ce
  return process.platform === "win32" ? "/mnt/host" : "/mnt";
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
