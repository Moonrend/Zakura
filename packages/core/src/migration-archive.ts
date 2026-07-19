/**
 * Workspace migration export/import: walk + exclude + tar + gzip + manifest.
 * Compression uses gzip (portable zlib) with compression field in manifest.
 * Archive filename convention remains *.tar.zst for pipeline compatibility;
 * body is gzip when zstd CLI is unavailable (Windows/dev hosts).
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable, Writable } from "node:stream";
import {
  DEFAULT_MIGRATION_EXCLUDE_PATTERNS,
  type MigrationManifest,
  type MigrationManifestFile,
} from "@zakura/shared";

const MANIFEST_PATH = "_zakura/manifest.json";

export function matchExcludePattern(relPath: string, pattern: string): boolean {
  const path = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const dirOnly = pattern.replace(/\\/g, "/").endsWith("/");
  const reSrc = globToRegExp(pattern);
  const re = new RegExp(`^${reSrc}$`);
  if (re.test(path)) return true;
  // Match children of an excluded directory (node_modules/foo when pattern is **/node_modules/)
  if (dirOnly || pattern.includes("**/") || pattern.endsWith("/")) {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      if (re.test(prefix)) return true;
    }
  }
  return false;
}

function globToRegExp(pattern: string): string {
  let pat = pattern.replace(/\\/g, "/");
  if (pat.endsWith("/")) pat = pat.slice(0, -1);

  // Escape then restore globs
  let out = "";
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] === "*" && pat[i + 1] === "*") {
      // **/ or **
      if (pat[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
      continue;
    }
    if (pat[i] === "*") {
      out += "[^/]*";
      continue;
    }
    if (pat[i] === "?") {
      out += "[^/]";
      continue;
    }
    const c = pat[i]!;
    if (".+^${}()|[]\\".includes(c)) out += `\\${c}`;
    else out += c;
  }
  return out;
}

export function shouldExcludePath(
  relPath: string,
  excludePatterns: string[],
  includePatterns?: string[],
): boolean {
  const path = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (path === MANIFEST_PATH || path.startsWith("_zakura/")) {
    // Allow packing our own manifest
  }
  if (includePatterns && includePatterns.length > 0) {
    const included = includePatterns.some((p) => matchExcludePattern(path, p));
    if (!included) return true;
  }
  return excludePatterns.some((p) => matchExcludePattern(path, p));
}

export function mergeExcludePatterns(extra?: string[]): string[] {
  const set = new Set<string>([...DEFAULT_MIGRATION_EXCLUDE_PATTERNS, ...(extra ?? [])]);
  return [...set];
}

export type WalkedFile = {
  absPath: string;
  relPath: string;
  size: number;
  mode: number;
  isDir: boolean;
};

export function walkWorkspaceFiles(
  root: string,
  excludePatterns: string[],
  includePatterns?: string[],
): WalkedFile[] {
  const rootResolved = resolve(root);
  const out: WalkedFile[] = [];

  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const rel = relative(rootResolved, abs).replace(/\\/g, "/");
      if (shouldExcludePath(rel, excludePatterns, includePatterns)) {
        continue;
      }
      if (st.isDirectory()) {
        out.push({ absPath: abs, relPath: rel, size: 0, mode: st.mode, isDir: true });
        walk(abs);
      } else if (st.isFile()) {
        out.push({
          absPath: abs,
          relPath: rel,
          size: st.size,
          mode: st.mode,
          isDir: false,
        });
      }
    }
  };

  if (existsSync(rootResolved)) walk(rootResolved);
  return out;
}

function pad512(buf: Buffer): Buffer {
  const rem = buf.length % 512;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(512 - rem)]);
}

function tarHeader(name: string, size: number, mode: number, typeflag: string): Buffer {
  const block = Buffer.alloc(512, 0);
  const nameBuf = Buffer.from(name, "utf8");
  if (nameBuf.length > 100) {
    // ustar prefix split
    const slash = name.lastIndexOf("/", 155);
    if (slash > 0 && name.length - slash - 1 <= 100) {
      Buffer.from(name.slice(slash + 1), "utf8").copy(block, 0);
      Buffer.from(name.slice(0, slash), "utf8").copy(block, 345);
    } else {
      throw new Error(`Path too long for ustar: ${name}`);
    }
  } else {
    nameBuf.copy(block, 0);
  }
  Buffer.from(mode.toString(8).padStart(7, "0") + "\0", "utf8").copy(block, 100);
  Buffer.from("0000000\0", "utf8").copy(block, 108); // uid
  Buffer.from("0000000\0", "utf8").copy(block, 116); // gid
  Buffer.from(size.toString(8).padStart(11, "0") + "\0", "utf8").copy(block, 124);
  Buffer.from(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", "utf8").copy(
    block,
    136,
  );
  Buffer.from("        ", "utf8").copy(block, 148); // checksum placeholder
  block[156] = typeflag.charCodeAt(0);
  Buffer.from("ustar\0", "utf8").copy(block, 257);
  Buffer.from("00", "utf8").copy(block, 263);

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += block[i]!;
  Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ", "utf8").copy(block, 148);
  return block;
}

function buildTar(files: Array<{ name: string; data?: Buffer; mode: number; isDir: boolean }>): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const name = f.name.replace(/\\/g, "/").replace(/^\//, "");
    if (f.isDir) {
      const dirName = name.endsWith("/") ? name : `${name}/`;
      parts.push(tarHeader(dirName, 0, f.mode & 0o7777 || 0o755, "5"));
    } else {
      const data = f.data ?? Buffer.alloc(0);
      parts.push(tarHeader(name, data.length, f.mode & 0o7777 || 0o644, "0"));
      parts.push(pad512(data));
    }
  }
  parts.push(Buffer.alloc(1024, 0)); // two zero blocks
  return Buffer.concat(parts);
}

function parseTar(buf: Buffer): Array<{ name: string; data: Buffer; isDir: boolean; mode: number }> {
  const out: Array<{ name: string; data: Buffer; isDir: boolean; mode: number }> = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) break;

    const nameRaw = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const name = prefix ? `${prefix}/${nameRaw}` : nameRaw;
    const sizeOct = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = sizeOct ? parseInt(sizeOct, 8) : 0;
    const modeOct = header.subarray(100, 108).toString("utf8").replace(/\0.*$/, "").trim();
    const mode = modeOct ? parseInt(modeOct, 8) : 0o644;
    const typeflag = String.fromCharCode(header[156] ?? 48);
    const isDir = typeflag === "5" || name.endsWith("/");

    if (isDir) {
      out.push({ name: name.replace(/\/$/, ""), data: Buffer.alloc(0), isDir: true, mode });
    } else {
      const data = buf.subarray(offset, offset + size);
      out.push({ name, data: Buffer.from(data), isDir: false, mode });
      offset += Math.ceil(size / 512) * 512;
    }
  }
  return out;
}

async function gzipBuffer(data: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const gzip = createGzip();
  await pipeline(
    Readable.from(data),
    gzip,
    new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    }),
  );
  return Buffer.concat(chunks);
}

async function gunzipBuffer(data: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(
    Readable.from(data),
    createGunzip(),
    new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    }),
  );
  return Buffer.concat(chunks);
}

export type ExportOptions = {
  agentId: string;
  sourceNodeId: string;
  workspaceRoot: string;
  excludePatterns?: string[];
  includePatterns?: string[];
};

export type ExportResult = {
  archive: Buffer;
  manifest: MigrationManifest;
  archiveSha256: string;
};

export async function exportWorkspace(opts: ExportOptions): Promise<ExportResult> {
  const excludePatterns = mergeExcludePatterns(opts.excludePatterns);
  const walked = walkWorkspaceFiles(opts.workspaceRoot, excludePatterns, opts.includePatterns);
  const filesOnly = walked.filter((f) => !f.isDir);

  const manifestFiles: MigrationManifestFile[] = [];
  const tarEntries: Array<{ name: string; data?: Buffer; mode: number; isDir: boolean }> = [];

  // Include directories first
  for (const d of walked.filter((f) => f.isDir)) {
    tarEntries.push({ name: d.relPath, mode: d.mode, isDir: true });
  }

  let totalBytes = 0;
  for (const f of filesOnly) {
    const data = readFileSync(f.absPath);
    const sha256 = createHash("sha256").update(data).digest("hex");
    manifestFiles.push({
      path: f.relPath,
      size: f.size,
      sha256,
      mode: (f.mode & 0o777).toString(8).padStart(3, "0"),
    });
    tarEntries.push({ name: f.relPath, data, mode: f.mode, isDir: false });
    totalBytes += f.size;
  }

  const manifest: MigrationManifest = {
    version: 1,
    agentId: opts.agentId,
    exportedAt: new Date().toISOString(),
    sourceNodeId: opts.sourceNodeId,
    compression: "gzip",
    excludePatterns,
    files: manifestFiles,
    totalBytes,
    fileCount: manifestFiles.length,
  };

  tarEntries.push({
    name: MANIFEST_PATH,
    data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
    mode: 0o644,
    isDir: false,
  });

  const tar = buildTar(tarEntries);
  const archive = await gzipBuffer(tar);
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");
  return { archive, manifest, archiveSha256 };
}

export type ImportOptions = {
  archive: Buffer;
  targetWorkspaceRoot: string;
  /** When true, write to workspace.incoming then atomic rename */
  atomic?: boolean;
  expectedSha256?: string;
};

export type ImportResult = {
  manifest: MigrationManifest;
  workspaceRoot: string;
  fileCount: number;
};

export async function importWorkspace(opts: ImportOptions): Promise<ImportResult> {
  if (opts.expectedSha256) {
    const actual = createHash("sha256").update(opts.archive).digest("hex");
    if (actual !== opts.expectedSha256) {
      throw new Error(`Archive sha256 mismatch: expected ${opts.expectedSha256}, got ${actual}`);
    }
  }

  // Detect gzip magic
  let tarBuf: Buffer;
  if (opts.archive[0] === 0x1f && opts.archive[1] === 0x8b) {
    tarBuf = await gunzipBuffer(opts.archive);
  } else {
    tarBuf = opts.archive;
  }

  const entries = parseTar(tarBuf);
  const manifestEntry = entries.find(
    (e) => e.name === MANIFEST_PATH || e.name.replace(/\\/g, "/") === MANIFEST_PATH,
  );
  if (!manifestEntry) {
    throw new Error("Archive missing _zakura/manifest.json");
  }
  const manifest = JSON.parse(manifestEntry.data.toString("utf8")) as MigrationManifest;

  // Verify file hashes
  for (const mf of manifest.files) {
    const ent = entries.find((e) => e.name === mf.path || e.name.replace(/\\/g, "/") === mf.path);
    if (!ent || ent.isDir) {
      throw new Error(`Manifest file missing in archive: ${mf.path}`);
    }
    const hash = createHash("sha256").update(ent.data).digest("hex");
    if (hash !== mf.sha256) {
      throw new Error(`Hash mismatch for ${mf.path}`);
    }
  }

  const finalRoot = resolve(opts.targetWorkspaceRoot);
  const writeRoot =
    opts.atomic !== false
      ? `${finalRoot}.incoming`
      : finalRoot;

  if (existsSync(writeRoot)) {
    rmSync(writeRoot, { recursive: true, force: true });
  }
  mkdirSync(writeRoot, { recursive: true });

  for (const ent of entries) {
    if (ent.name === MANIFEST_PATH) continue;
    const dest = join(writeRoot, ent.name);
    // path jail: ensure under writeRoot
    const rel = relative(resolve(writeRoot), resolve(dest));
    if (rel.startsWith("..") || rel === "..") {
      throw new Error(`Archive path escapes target: ${ent.name}`);
    }
    if (ent.isDir) {
      mkdirSync(dest, { recursive: true });
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, ent.data);
    }
  }

  if (opts.atomic !== false) {
    if (existsSync(finalRoot)) {
      const bak = `${finalRoot}.bak.${Date.now()}`;
      renameSync(finalRoot, bak);
    }
    renameSync(writeRoot, finalRoot);
  }

  return {
    manifest,
    workspaceRoot: finalRoot,
    fileCount: manifest.fileCount,
  };
}

export function writeArchiveFile(path: string, archive: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, archive);
}

export function readArchiveFile(path: string): Buffer {
  return readFileSync(path);
}

export async function exportWorkspaceToFile(
  opts: ExportOptions & { outPath: string },
): Promise<ExportResult & { outPath: string }> {
  const result = await exportWorkspace(opts);
  writeArchiveFile(opts.outPath, result.archive);
  return { ...result, outPath: opts.outPath };
}

export async function importWorkspaceFromFile(
  opts: Omit<ImportOptions, "archive"> & { archivePath: string },
): Promise<ImportResult> {
  const archive = readArchiveFile(opts.archivePath);
  return importWorkspace({ ...opts, archive });
}

/** Stream helpers for HTTP */
export function archiveToStream(archive: Buffer): Readable {
  return Readable.from(archive);
}

export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export { MANIFEST_PATH };
