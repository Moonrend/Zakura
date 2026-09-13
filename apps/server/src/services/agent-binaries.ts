import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type AgentBinary = {
  os: string;
  arch: string;
  path: string;
  sha256: string;
  size: number;
  version: string;
  mtimeMs: number;
};

const shaCache = new Map<string, { mtimeMs: number; size: number; sha256: string }>();

export function normalizeAgentOs(raw: string | undefined): string | null {
  const s = (raw ?? "").toLowerCase();
  if (s === "linux" || s === "darwin" || s === "windows") return s;
  if (s === "win32") return "windows";
  if (s === "macos" || s === "osx" || s === "mac") return "darwin";
  return null;
}

export function normalizeAgentArch(raw: string | undefined): string | null {
  const s = (raw ?? "").toLowerCase();
  if (s === "amd64" || s === "x64" || s === "x86_64") return "amd64";
  if (s === "arm64" || s === "aarch64") return "arm64";
  return null;
}

export function agentBinaryFileName(os: string, arch: string): string {
  return os === "windows" ? `zakura-agent_windows_${arch}.exe` : `zakura-agent_${os}_${arch}`;
}

export function agentBinaryDownloadUrl(publicBaseUrl: string, os: string, arch: string): string {
  const base = publicBaseUrl.replace(/\/$/, "");
  return `${base}/api/runtime-nodes/agent-binaries/${os}/${arch}`;
}

export function isHttpUrl(value: string | undefined): boolean {
  return Boolean(value && /^https?:\/\//i.test(value));
}

function binarySearchDirs(): string[] {
  const dir = process.env.ZAKURA_AGENT_BINARIES_DIR?.trim();
  return [
    dir,
    join(process.cwd(), "go/agent/dist"),
    join(process.cwd(), "../../go/agent/dist"),
  ].filter((p): p is string => Boolean(p));
}

function catalogVersion(): string {
  const env = process.env.ZAKURA_AGENT_VERSION?.trim();
  if (env) return env;
  for (const dir of binarySearchDirs()) {
    const f = join(dir, "VERSION");
    if (existsSync(f)) {
      const v = readFileSync(f, "utf8").trim();
      if (v) return v;
    }
  }
  return "dev";
}

function fileSha256(path: string, mtimeMs: number, size: number): string {
  const hit = shaCache.get(path);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.sha256;
  const sum = createHash("sha256").update(readFileSync(path)).digest("hex");
  shaCache.set(path, { mtimeMs, size, sha256: sum });
  return sum;
}

export function findAgentBinary(osRaw: string, archRaw: string): AgentBinary | null {
  const osName = normalizeAgentOs(osRaw);
  const arch = normalizeAgentArch(archRaw);
  if (!osName || !arch) return null;
  const name = agentBinaryFileName(osName, arch);
  const fallback = osName === "windows" ? "zakura-agent.exe" : "zakura-agent";
  for (const dir of binarySearchDirs()) {
    const candidates = [join(dir, name), join(dir, fallback)];
    const file = candidates.find((p) => existsSync(p));
    if (!file) continue;
    const st = statSync(file);
    return {
      os: osName,
      arch,
      path: file,
      sha256: fileSha256(file, st.mtimeMs, st.size),
      size: st.size,
      version: catalogVersion(),
      mtimeMs: st.mtimeMs,
    };
  }
  return null;
}

export function openAgentBinaryStream(bin: AgentBinary) {
  return createReadStream(bin.path);
}

export function resolveAgentUpdateTarget(opts: {
  publicBaseUrl: string;
  os: string;
  arch: string;
  url?: string;
  image?: string;
  sha256?: string;
  version?: string;
}): { url: string; sha256: string; version: string; filename: string } {
  if (isHttpUrl(opts.url) || isHttpUrl(opts.image)) {
    const url = (isHttpUrl(opts.url) ? opts.url : opts.image) as string;
    const bin = findAgentBinary(opts.os, opts.arch);
    return {
      url,
      sha256: opts.sha256 || bin?.sha256 || "",
      version: opts.version || bin?.version || catalogVersion(),
      filename: bin ? agentBinaryFileName(bin.os, bin.arch) : "zakura-agent",
    };
  }
  const bin = findAgentBinary(opts.os, opts.arch);
  if (!bin) {
    throw new Error(
      `没有 ${opts.os}/${opts.arch} 的 zakura-agent 二进制。请发布到 go/agent/dist 或设置 ZAKURA_AGENT_BINARIES_DIR。`,
    );
  }
  return {
    url: agentBinaryDownloadUrl(opts.publicBaseUrl, bin.os, bin.arch),
    sha256: bin.sha256,
    version: bin.version,
    filename: agentBinaryFileName(bin.os, bin.arch),
  };
}
