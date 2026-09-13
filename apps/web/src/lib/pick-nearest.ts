export interface ItemRect {
  top: number;
  height: number;
  left: number;
  width: number;
}

export interface PickNearestInput {
  axis: "x" | "y" | "xy";
  point: { x: number; y: number };
  rects: readonly (ItemRect | undefined)[];
  containerRect: { left: number; top: number; width: number; height: number };
  scroll: { x: number; y: number };
  border: { x: number; y: number };
  layoutSize: { width: number; height: number };
  isDisabled?: (index: number) => boolean;
}

/** 指针落在某项内则选它，否则选中心最近的一项。 */
export function pickNearest({
  axis,
  point,
  rects,
  containerRect,
  scroll,
  border,
  layoutSize,
  isDisabled,
}: PickNearestInput): number | null {
  const scaleX = layoutSize.width > 0 ? containerRect.width / layoutSize.width : 1;
  const scaleY = layoutSize.height > 0 ? containerRect.height / layoutSize.height : 1;
  let closestIndex: number | null = null;
  let closestDistance = Infinity;
  let containingIndex: number | null = null;
  let containingSize = Infinity;

  for (let index = 0; index < rects.length; index++) {
    const r = rects[index];
    if (!r) continue;
    if (isDisabled?.(index)) continue;

    if (axis === "xy") {
      const left = containerRect.left + (border.x + r.left - scroll.x) * scaleX;
      const top = containerRect.top + (border.y + r.top - scroll.y) * scaleY;
      const width = r.width * scaleX;
      const height = r.height * scaleY;
      if (
        point.x >= left &&
        point.x <= left + width &&
        point.y >= top &&
        point.y <= top + height
      ) {
        const area = width * height;
        if (area < containingSize) {
          containingSize = area;
          containingIndex = index;
        }
      }
      const distance = Math.hypot(
        point.x - (left + width / 2),
        point.y - (top + height / 2),
      );
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
      continue;
    }

    const horizontal = axis === "x";
    const mousePos = horizontal ? point.x : point.y;
    const scale = horizontal ? scaleX : scaleY;
    const itemStart =
      (horizontal ? containerRect.left : containerRect.top) +
      ((horizontal ? border.x : border.y) +
        (horizontal ? r.left : r.top) -
        (horizontal ? scroll.x : scroll.y)) *
        scale;
    const itemSize = (horizontal ? r.width : r.height) * scale;
    if (mousePos >= itemStart && mousePos <= itemStart + itemSize) {
      if (itemSize < containingSize) {
        containingSize = itemSize;
        containingIndex = index;
      }
    }
    const distance = Math.abs(mousePos - (itemStart + itemSize / 2));
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  }

  return containingIndex ?? closestIndex;
}
