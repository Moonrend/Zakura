/**
 * Workspace filesystem abstraction — local disk or remote Runner Agent.
 * Server routes fs_* / HTTP FS through WorkspaceFsProvider.
 */

export type WorkspaceFsEntry = {
  name: string;
  path: string;
  size: number;
  mode: string;
  modTime: string;
  isDir: boolean;
};

export type ListOpts = {
  recursive?: boolean;
  offset?: number;
  limit?: number;
};

export type ListResult = {
  path: string;
  entries: Array<{ name: string; type: "file" | "dir" | "other"; size?: number }>;
  truncated: boolean;
};

export type ListDetailedResult = {
  path: string;
  entries: WorkspaceFsEntry[];
};

export type ReadOpts = {
  lineOffset?: number;
  nLines?: number;
};

export type ReadResult = {
  path: string;
  content: string;
  truncated: boolean;
  totalLines: number;
};

export type ReadTextResult = {
  path: string;
  content: string;
  size: number;
  revision: string;
};

export type WriteResult = {
  path: string;
  ok?: true;
  bytes?: number;
  revision?: string;
};

export interface WorkspaceFs {
  stat(path: string): Promise<{
    path: string;
    type: "file" | "dir" | "other";
    size: number;
    mtime: string;
  }>;
  statDetailed(path: string): Promise<WorkspaceFsEntry>;
  list(path: string, opts?: ListOpts): Promise<ListResult>;
  listDetailed(path: string): Promise<ListDetailedResult>;
  read(path: string, opts?: ReadOpts): Promise<ReadResult>;
  readText(path: string): Promise<ReadTextResult>;
  write(path: string, content: string): Promise<{ path: string; bytes: number }>;
  writeText(
    path: string,
    content: string,
    expectedRevision?: string | null,
  ): Promise<{ path: string; ok: true; revision: string }>;
  edit(path: string, oldText: string, newText: string): Promise<{ path: string; ok: true }>;
  mkdir(path: string): Promise<{ path: string }>;
  mkdirApi(path: string): Promise<{ path: string; ok: true }>;
  delete(path: string, recursive?: boolean): Promise<{ path: string; ok: true }>;
  deleteApi(path: string, recursive?: boolean): Promise<{ path: string; ok: true }>;
  move(from: string, to: string): Promise<{ from: string; to: string }>;
  renameApi(oldPath: string, newPath: string): Promise<{ ok: true; path: string }>;
  exists(path: string): Promise<boolean>;
}

export interface WorkspaceFsProvider {
  /** Resolve FS for an agent; tenantId enforces multi-tenant isolation. */
  forAgent(agentId: string, tenantId: string): Promise<WorkspaceFs>;
  /**
   * Prefer when the agent row is already loaded — skips agents 表查询，
   * 直接按 runtimeNodeId 打开本机目录或 Runner 上的文件。
   */
  forAgentBinding(binding: {
    id: string;
    tenantId: string;
    runtimeNodeId?: string | null;
  }): Promise<WorkspaceFs>;
}
