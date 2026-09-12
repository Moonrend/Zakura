/**
 * GitHub 风格 identicon：由 id 哈希出 5×5 镜像格子 + 固定色板。
 * 纯函数、无 I/O，前后端和单测共用。
 */

const PALETTE = [
  "#0e7490",
  "#b45309",
  "#4d7c0f",
  "#6d28d9",
  "#b91c1c",
  "#0f766e",
  "#c2410c",
  "#1d4ed8",
] as const;

/** 5×5 格子（行优先），true 为着色块 */
export type IdenticonGrid = {
  cells: boolean[];
  color: string;
};

export function hash32(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(h, 33) + input.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

export function identiconFromId(id: string): IdenticonGrid {
  const seed = id.trim() || "zakura";
  const h = hash32(seed);
  const color = PALETTE[h % PALETTE.length]!;
  const cells = new Array<boolean>(25);
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const filled = ((h >>> (y * 3 + x)) & 1) === 1;
      cells[y * 5 + x] = filled;
      cells[y * 5 + (4 - x)] = filled;
    }
  }
  return { cells, color };
}

/** identicon 色，给协同光标 / caret 复用 */
export function identiconColor(id: string): string {
  return identiconFromId(id).color;
}
