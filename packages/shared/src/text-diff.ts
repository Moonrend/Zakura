/** 公共前后缀 diff，输入框 CRDT 局部更新用。 */
export function textDiff(
  prev: string,
  next: string,
): { start: number; deleted: number; inserted: string } {
  let start = 0;
  const min = Math.min(prev.length, next.length);
  while (start < min && prev.charCodeAt(start) === next.charCodeAt(start)) start += 1;
  let endPrev = prev.length;
  let endNext = next.length;
  while (
    endPrev > start &&
    endNext > start &&
    prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)
  ) {
    endPrev -= 1;
    endNext -= 1;
  }
  return { start, deleted: endPrev - start, inserted: next.slice(start, endNext) };
}
