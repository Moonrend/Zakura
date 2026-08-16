export type ComposerSlashDraft = {
  /** 当前行开头 `/` 的下标 */
  from: number;
  to: number;
  query: string;
};

export type ComposerSlashItem = {
  id: string;
  name: string;
  description?: string;
  kind: "command" | "skill";
};

/** 光标所在行以 `/` 开头、尚未敲空格时，视为斜杠命令草稿 */
export function parseComposerSlash(value: string): ComposerSlashDraft | null {
  const lineStart = value.lastIndexOf("\n") + 1;
  const line = value.slice(lineStart);
  if (!line.startsWith("/")) return null;
  if (line.includes(" ")) return null;
  return {
    from: lineStart,
    to: value.length,
    query: line.slice(1),
  };
}

export function filterComposerSlashItems(
  items: readonly ComposerSlashItem[],
  query: string,
): ComposerSlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((item) => {
    const haystack = `${item.name} ${item.description ?? ""}`.toLowerCase();
    return haystack.includes(q);
  });
}

export function applyComposerSlash(
  value: string,
  draft: ComposerSlashDraft,
  name: string,
): string {
  return `${value.slice(0, draft.from)}/${name} `;
}
