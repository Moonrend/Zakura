import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, basename, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import {
  PathJailError,
  resolveInRoot,
  toApiPath,
  toWorkspacePath,
} from "./path-jail.js";
import type {
  ListOpts,
  ListResult,
  ReadOpts,
  WorkspaceFs,
  WorkspaceFsEntry,
} from "./workspace-fs.js";

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_TEXT_EDIT_BYTES = 8 * 1024 * 1024;

export function contentRevision(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

/** 初始化工作区目录并写入默认 README（仅首次）。 */
export function ensureWorkspaceDir(root: string): void {
  mkdirSync(root, { recursive: true });
  const readme = join(root, "README.md");
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      [
        "# Agent Workspace",
        "",
        "This directory is the isolated filesystem for one Zakura agent.",
        "All `fs_*` and `shell_exec` tools share this directory (`/workspace` in the container).",
        "Preinstalled: python3, node/npm, gcc/g++. See /etc/zakura/capabilities.txt.",
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

function runTar(args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("tar", args, { cwd, windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `tar exited with code ${code}`));
    });
  });
}

function modeString(mode: number, isDir: boolean): string {
  const perms = (mode & 0o777).toString(8).padStart(3, "0");
  return `${isDir ? "d" : "-"}${perms}`;
}

function entryFromStat(root: string, abs: string, name?: string): WorkspaceFsEntry {
  const st = statSync(abs);
  const isDir = st.isDirectory();
  const apiPath = toApiPath(root, abs);
  return {
    name: name ?? basename(abs === resolve(root) ? "/" : abs),
    path: apiPath,
    size: st.size,
    mode: modeString(st.mode, isDir),
    modTime: st.mtime.toISOString(),
    isDir,
  };
}

function applyEdit(raw: string, oldText: string, newText: string): string {
  if (!oldText) throw new Error("old_text must not be empty");
  const count = raw.split(oldText).length - 1;
  if (count === 0) {
    throw new Error("old_text not found in file (must match exactly)");
  }
  if (count > 1) {
    throw new Error(`old_text found ${count} times; must be unique`);
  }
  return raw.replace(oldText, newText);
}

/**
 * Local disk WorkspaceFs — used by Server local Runner and apps/runner.
 */
export class LocalWorkspaceFs implements WorkspaceFs {
  constructor(private readonly root: string) {
    ensureWorkspaceDir(root);
  }

  getRoot(): string {
    return this.root;
  }

  async stat(path: string) {
    const abs = resolveInRoot(this.root, path);
    const st = statSync(abs);
    return {
      path: toWorkspacePath(this.root, abs),
      type: (st.isDirectory() ? "dir" : st.isFile() ? "file" : "other") as
        | "file"
        | "dir"
        | "other",
      size: st.size,
      mtime: st.mtime.toISOString(),
    };
  }

  async statDetailed(path: string): Promise<WorkspaceFsEntry> {
    const abs = resolveInRoot(this.root, path || ".");
    return entryFromStat(this.root, abs);
  }

  async list(path: string, opts?: ListOpts): Promise<ListResult> {
    const abs = resolveInRoot(this.root, path || ".");
    const st = statSync(abs);
    if (!st.isDirectory()) throw new Error(`Not a directory: ${path}`);

    const entries: Array<{ name: string; type: "file" | "dir" | "other"; size?: number }> = [];

    const walk = (dir: string, prefix: string) => {
      for (const name of readdirSync(dir)) {
        if (entries.length >= MAX_LIST_ENTRIES * 2) break;
        const child = join(dir, name);
        let type: "file" | "dir" | "other" = "other";
        let size: number | undefined;
        try {
          const cst = statSync(child);
          if (cst.isDirectory()) type = "dir";
          else if (cst.isFile()) {
            type = "file";
            size = cst.size;
          }
        } catch {
          /* skip */
        }
        const relName = prefix ? `${prefix}/${name}` : name;
        entries.push({ name: relName, type, size });
        if (opts?.recursive && type === "dir") {
          walk(child, relName);
        }
      }
    };
    walk(abs, "");

    const offset = Math.max(0, opts?.offset ?? 0);
    const limit = Math.min(MAX_LIST_ENTRIES, Math.max(1, opts?.limit ?? MAX_LIST_ENTRIES));
    const page = entries.slice(offset, offset + limit);
    return {
      path: toWorkspacePath(this.root, abs),
      entries: page,
      truncated: offset + page.length < entries.length,
    };
  }

  async listDetailed(path: string) {
    const abs = resolveInRoot(this.root, path || ".");
    const st = statSync(abs);
    if (!st.isDirectory()) throw new Error(`Not a directory: ${path}`);

    const names = readdirSync(abs);
    const entries: WorkspaceFsEntry[] = [];
    for (const name of names) {
      try {
        entries.push(entryFromStat(this.root, join(abs, name), name));
      } catch {
        /* skip */
      }
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { path: toApiPath(this.root, abs), entries };
  }

  async read(path: string, opts?: ReadOpts) {
    const abs = resolveInRoot(this.root, path);
    const st = statSync(abs);
    if (!st.isFile()) throw new Error(`Not a file: ${path}`);
    if (st.size > MAX_READ_BYTES) {
      throw new Error(`File too large (${st.size} bytes). Max ${MAX_READ_BYTES} for fs_read.`);
    }
    const raw = readFileSync(abs, "utf8");
    const lines = raw.split("\n");
    const offset = Math.max(1, opts?.lineOffset ?? 1);
    const start = offset - 1;
    let slice = lines.slice(start);
    let truncated = false;
    if (opts?.nLines && opts.nLines > 0) {
      slice = slice.slice(0, opts.nLines);
      truncated = start + opts.nLines < lines.length;
    }
    return {
      path: toWorkspacePath(this.root, abs),
      content: slice.join("\n"),
      truncated,
      totalLines: lines.length,
    };
  }

  async readText(path: string) {
    const abs = resolveInRoot(this.root, path);
    const st = statSync(abs);
    if (!st.isFile()) throw new Error(`Not a file: ${path}`);
    if (st.size > MAX_TEXT_EDIT_BYTES) {
      throw new Error(`File too large for text editor (${st.size} bytes)`);
    }
    const data = readFileSync(abs);
    return {
      path: toApiPath(this.root, abs),
      content: data.toString("utf8"),
      size: data.length,
      revision: contentRevision(data),
    };
  }

  async write(path: string, content: string) {
    const abs = resolveInRoot(this.root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return { path: toWorkspacePath(this.root, abs), bytes: Buffer.byteLength(content, "utf8") };
  }

  async writeText(path: string, content: string, expectedRevision?: string | null) {
    const abs = resolveInRoot(this.root, path);
    if (expectedRevision !== undefined && expectedRevision !== null) {
      if (expectedRevision === "") {
        throw new Error("expectedRevision must be non-empty; omit the field for an unconditional write");
      }
      if (!existsSync(abs)) {
        throw Object.assign(new Error("file changed on disk"), { status: 409 });
      }
      const current = contentRevision(readFileSync(abs));
      if (current !== expectedRevision) {
        throw Object.assign(new Error("file changed on disk"), { status: 409 });
      }
    }
    mkdirSync(dirname(abs), { recursive: true });
    const buf = Buffer.from(content, "utf8");
    writeFileSync(abs, buf);
    return { path: toApiPath(this.root, abs), ok: true as const, revision: contentRevision(buf) };
  }

  async edit(path: string, oldText: string, newText: string) {
    const abs = resolveInRoot(this.root, path);
    const raw = readFileSync(abs, "utf8");
    const updated = applyEdit(raw, oldText, newText);
    writeFileSync(abs, updated, "utf8");
    return { path: toWorkspacePath(this.root, abs), ok: true as const };
  }

  async mkdir(path: string) {
    const abs = resolveInRoot(this.root, path);
    mkdirSync(abs, { recursive: true });
    return { path: toWorkspacePath(this.root, abs) };
  }

  async mkdirApi(path: string) {
    const abs = resolveInRoot(this.root, path);
    mkdirSync(abs, { recursive: true });
    return { path: toApiPath(this.root, abs), ok: true as const };
  }

  async delete(path: string, recursive = false) {
    const abs = resolveInRoot(this.root, path);
    if (resolve(abs) === resolve(this.root)) {
      throw new Error("Refusing to delete workspace root");
    }
    rmSync(abs, { recursive, force: false });
    return { path: toWorkspacePath(this.root, abs), ok: true as const };
  }

  async deleteApi(path: string, recursive = false) {
    const abs = resolveInRoot(this.root, path);
    if (resolve(abs) === resolve(this.root)) {
      throw new Error("Refusing to delete workspace root");
    }
    const st = statSync(abs);
    if (st.isDirectory() && !recursive) {
      const kids = readdirSync(abs);
      if (kids.length > 0) throw new Error("Directory not empty (pass recursive=true)");
    }
    rmSync(abs, { recursive: st.isDirectory() ? true : recursive, force: false });
    return { path: toApiPath(this.root, abs), ok: true as const };
  }

  async move(from: string, to: string) {
    const absFrom = resolveInRoot(this.root, from);
    const absTo = resolveInRoot(this.root, to);
    mkdirSync(dirname(absTo), { recursive: true });
    renameSync(absFrom, absTo);
    return {
      from: toWorkspacePath(this.root, absFrom),
      to: toWorkspacePath(this.root, absTo),
    };
  }

  async renameApi(oldPath: string, newPath: string) {
    const absFrom = resolveInRoot(this.root, oldPath);
    const absTo = resolveInRoot(this.root, newPath);
    if (resolve(absFrom) === resolve(this.root)) {
      throw new Error("Refusing to rename workspace root");
    }
    mkdirSync(dirname(absTo), { recursive: true });
    renameSync(absFrom, absTo);
    return { ok: true as const, path: toApiPath(this.root, absTo) };
  }

  async exists(path: string): Promise<boolean> {
    try {
      const abs = resolveInRoot(this.root, path);
      accessSync(abs, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async readBytes(path: string) {
    const abs = resolveInRoot(this.root, path);
    const st = statSync(abs);
    if (!st.isFile()) throw new Error(`Not a file: ${path}`);
    const data = readFileSync(abs);
    return {
      path: toApiPath(this.root, abs),
      data,
      size: data.length,
      name: basename(abs),
    };
  }

  async writeBytes(path: string, data: Buffer) {
    const abs = resolveInRoot(this.root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
    return { path: toApiPath(this.root, abs), size: data.length };
  }

  async archive(paths: string[]) {
    const cleaned = paths
      .map((p) => (p || ".").replace(/\\/g, "/").replace(/^\/+/, "") || ".")
      .filter((p, i, arr) => arr.indexOf(p) === i);
    if (cleaned.length === 0) throw new Error("paths are required");

    for (const p of cleaned) {
      resolveInRoot(this.root, p);
    }

    const tmpName = `.zakura-archive-${Date.now()}.tar.gz`;
    const tmpAbs = join(this.root, tmpName);
    try {
      const args = ["-czf", tmpName, ...cleaned.map((p) => (p === "." ? "." : p))];
      await runTar(args, this.root);
      const buffer = readFileSync(tmpAbs);
      const base =
        cleaned.length === 1 && cleaned[0] !== "."
          ? basename(cleaned[0]).replace(/[^\w.-]+/g, "_") || "archive"
          : "workspace";
      return { filename: `${base}.tar.gz`, buffer };
    } finally {
      try {
        rmSync(tmpAbs, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  async extract(archivePath: string, destPath?: string) {
    const abs = resolveInRoot(this.root, archivePath);
    const st = statSync(abs);
    if (!st.isFile()) throw new Error(`Not a file: ${archivePath}`);

    const lower = abs.toLowerCase();
    let destRel = destPath;
    if (!destRel) {
      const base = basename(abs);
      let stem = base;
      if (stem.toLowerCase().endsWith(".tar.gz")) stem = stem.slice(0, -7);
      else if (stem.toLowerCase().endsWith(".tgz")) stem = stem.slice(0, -4);
      else if (stem.toLowerCase().endsWith(".zip")) stem = stem.slice(0, -4);
      else if (stem.toLowerCase().endsWith(".gz")) stem = stem.slice(0, -3);
      destRel = join(dirname(toWorkspacePath(this.root, abs)), stem).replace(/\\/g, "/");
    }
    const destAbs = resolveInRoot(this.root, destRel);
    mkdirSync(destAbs, { recursive: true });

    if (lower.endsWith(".zip")) {
      await runTar(["-xf", abs, "-C", destAbs], this.root);
    } else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz") || lower.endsWith(".tar")) {
      const compressed = lower.endsWith(".tar.gz") || lower.endsWith(".tgz");
      await runTar(
        compressed ? ["-xzf", abs, "-C", destAbs] : ["-xf", abs, "-C", destAbs],
        this.root,
      );
    } else if (lower.endsWith(".gz")) {
      const outFile = join(destAbs, basename(abs).replace(/\.gz$/i, ""));
      await pipeline(createReadStream(abs), createGunzip(), createWriteStream(outFile));
    } else {
      throw new Error("Unsupported archive type (use .tar.gz, .tgz, .tar, or .zip)");
    }

    return { destination: toApiPath(this.root, destAbs), ok: true as const };
  }
}

export { PathJailError };
