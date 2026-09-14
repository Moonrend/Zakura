import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type AgentBinary = {
  os: string;
  arch: string;
  path: string;
  sha256: string;
  size: number;
  version: string;
  mtimeMs: number;
  fileKey: string;
};

export type AgentUpdateTarget = { url: string; sha256: string; version: string; filename: string };

export class AgentBinaryChangedError extends Error {
  constructor() { super("代理二进制正在发布，请稍后重新发起更新"); }
}

type BinaryMetadata = { sha256: string; platform: { os: string; arch: string } | null };
const shaCache = new Map<string, { key: string; value: Promise<BinaryMetadata> }>();

export function normalizeAgentOs(raw: string | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "linux" || s === "darwin" || s === "windows") return s;
  if (s === "win32") return "windows";
  if (s === "macos" || s === "osx" || s === "mac") return "darwin";
  return null;
}

export function normalizeAgentArch(raw: string | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "amd64" || s === "x64" || s === "x86_64") return "amd64";
  if (s === "arm64" || s === "aarch64") return "arm64";
  return null;
}

export function agentBinaryFileName(os: string, arch: string): string {
  return os === "windows" ? `zakura-agent_windows_${arch}.exe` : `zakura-agent_${os}_${arch}`;
}

export function agentBinaryDownloadUrl(publicBaseUrl: string, os: string, arch: string, sha256?: string): string {
  const base = publicBaseUrl.replace(/\/+$/, "");
  return `${base}/api/runtime-nodes/agent-binaries/${os}/${arch}${sha256 ? `?sha256=${sha256}` : ""}`;
}

export function isHttpUrl(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" || url.protocol === "http:";
  } catch { return false; }
}

function binarySearchDirs(): string[] {
  return [...new Set([
    process.env.ZAKURA_AGENT_BINARIES_DIR?.trim(),
    join(process.cwd(), "go/agent/dist"),
    join(process.cwd(), "../../go/agent/dist"),
  ].filter((p): p is string => Boolean(p)))];
}

async function catalogVersion(dir: string): Promise<string> {
  const env = process.env.ZAKURA_AGENT_VERSION?.trim();
  if (env) return env;
  return (await readFile(join(dir, "VERSION"), "utf8").catch(() => "")).trim() || "dev";
}

// Check the executable header as well as the filename. In particular, a bare
// `zakura-agent` must never be served as every OS/architecture in the catalog.
function binaryPlatform(header: Buffer): BinaryMetadata["platform"] {
  if (header.length < 64) return null;
  let os = "";
  let arch: string | null = null;
  if (header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && header[4] === 2 && header[5] === 1) {
    os = "linux";
    const machine = header.readUInt16LE(18);
    arch = machine === 62 ? "amd64" : machine === 183 ? "arm64" : null;
  } else if (header.readUInt32LE(0) === 0xfeedfacf) {
    os = "darwin";
    const cpu = header.readUInt32LE(4);
    arch = cpu === 0x01000007 ? "amd64" : cpu === 0x0100000c ? "arm64" : null;
  } else if (header.toString("ascii", 0, 2) === "MZ") {
    const offset = header.readUInt32LE(60);
    if (offset + 6 <= header.length && header.toString("ascii", offset, offset + 4) === "PE\0\0") {
      os = "windows";
      const machine = header.readUInt16LE(offset + 4);
      arch = machine === 0x8664 ? "amd64" : machine === 0xaa64 ? "arm64" : null;
    }
  }
  return arch ? { os, arch } : null;
}

function fileMetadata(path: string, key: string): Promise<BinaryMetadata> {
  const hit = shaCache.get(path);
  if (hit?.key === key) return hit.value;
  const value = (async () => {
    const file = await open(path, "r");
    try {
      const header = Buffer.alloc(4096);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
      const after = await file.stat();
      if (statKey(after) !== key) throw new AgentBinaryChangedError();
      return { sha256: hash.digest("hex"), platform: binaryPlatform(header.subarray(0, bytesRead)) };
    } finally { await file.close(); }
  })();
  shaCache.set(path, { key, value });
  void value.catch(() => { if (shaCache.get(path)?.value === value) shaCache.delete(path); });
  return value;
}

function statKey(st: { mtimeMs: number; ctimeMs: number; size: number; ino: number; dev: number }): string {
  return `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}:${st.dev}`;
}

export async function findAgentBinary(osRaw: string, archRaw: string): Promise<AgentBinary | null> {
  const osName = normalizeAgentOs(osRaw);
  const arch = normalizeAgentArch(archRaw);
  if (!osName || !arch) return null;
  const name = agentBinaryFileName(osName, arch);
  const fallback = osName === "windows" ? "zakura-agent.exe" : "zakura-agent";
  for (const dir of binarySearchDirs()) {
    for (const path of [join(dir, name), join(dir, fallback)]) {
      const st = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!st?.isFile()) continue;
      const metadata = await fileMetadata(path, statKey(st));
      if (metadata.platform?.os !== osName || metadata.platform.arch !== arch) continue;
      return { os: osName, arch, path, sha256: metadata.sha256, size: st.size,
        version: await catalogVersion(dir), mtimeMs: st.mtimeMs, fileKey: statKey(st) };
    }
  }
  return null;
}

export async function openAgentBinaryStream(bin: AgentBinary) {
  // Pin the verified inode before sending headers. Reopening the pathname in a
  // lazy stream could serve a newly published binary under the old digest/ETag.
  const file = await open(bin.path, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new AgentBinaryChangedError();
    throw error;
  });
  try {
    if (statKey(await file.stat()) !== bin.fileKey) throw new AgentBinaryChangedError();
    return file.createReadStream();
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function resolveAgentUpdateTarget(opts: {
  publicBaseUrl: string;
  os: string;
  arch: string;
  url?: string;
  image?: string;
  sha256?: string;
  version?: string;
}): Promise<AgentUpdateTarget> {
  const explicit = opts.url?.trim() || opts.image?.trim();
  if (explicit) {
    if (!isHttpUrl(explicit)) throw new Error("Go 代理更新需要 HTTP(S) 二进制下载地址");
    if (!/^[a-f0-9]{64}$/i.test(opts.sha256?.trim() ?? "")) {
      throw new Error("自定义下载地址必须提供对应的 64 位 sha256 摘要");
    }
    return { url: explicit, sha256: opts.sha256!.trim().toLowerCase(), version: opts.version?.trim() || "custom",
      filename: agentBinaryFileName(opts.os, opts.arch) };
  }
  const bin = await findAgentBinary(opts.os, opts.arch);
  if (!bin) {
    throw new Error(`没有 ${opts.os}/${opts.arch} 的 zakura-agent 二进制。请发布到 go/agent/dist 或设置 ZAKURA_AGENT_BINARIES_DIR。`);
  }
  return {
    url: agentBinaryDownloadUrl(opts.publicBaseUrl, bin.os, bin.arch, bin.sha256),
    sha256: bin.sha256, version: bin.version, filename: agentBinaryFileName(bin.os, bin.arch),
  };
}
