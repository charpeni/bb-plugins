export interface TreemapItem<T> {
  value: number;
  data: T;
}

export interface TreemapRect<T> {
  x: number;
  y: number;
  width: number;
  height: number;
  data: T;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Worst aspect ratio in a row of areas laid along a side of the given length.
function worstRatio(row: number[], side: number): number {
  let sum = 0;
  let max = 0;
  let min = Infinity;
  for (const area of row) {
    sum += area;
    if (area > max) max = area;
    if (area < min) min = area;
  }
  const sideSquared = side * side;
  const sumSquared = sum * sum;
  return Math.max((sideSquared * max) / sumSquared, sumSquared / (sideSquared * min));
}

// Places a finished row along the shorter side of the free space and returns
// the space left over.
function placeRow<T>(
  row: { area: number; data: T }[],
  bounds: Bounds,
  out: TreemapRect<T>[],
): Bounds {
  const rowArea = row.reduce((sum, item) => sum + item.area, 0);

  if (bounds.width >= bounds.height) {
    const columnWidth = rowArea / bounds.height;
    let y = bounds.y;
    for (const item of row) {
      const height = item.area / columnWidth;
      out.push({ x: bounds.x, y, width: columnWidth, height, data: item.data });
      y += height;
    }
    return {
      x: bounds.x + columnWidth,
      y: bounds.y,
      width: bounds.width - columnWidth,
      height: bounds.height,
    };
  }

  const rowHeight = rowArea / bounds.width;
  let x = bounds.x;
  for (const item of row) {
    const width = item.area / rowHeight;
    out.push({ x, y: bounds.y, width, height: rowHeight, data: item.data });
    x += width;
  }
  return {
    x: bounds.x,
    y: bounds.y + rowHeight,
    width: bounds.width,
    height: bounds.height - rowHeight,
  };
}

/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk): tiles a
 * `width × height` box with one rectangle per item, area proportional to its
 * value, keeping rectangles as close to square as the greedy row packing
 * allows. Items with a non-positive value get no rectangle.
 */
export function squarify<T>(
  items: readonly TreemapItem<T>[],
  width: number,
  height: number,
): TreemapRect<T>[] {
  const positive = items.filter((item) => item.value > 0).sort((a, b) => b.value - a.value);
  if (positive.length === 0 || width <= 0 || height <= 0) return [];

  const total = positive.reduce((sum, item) => sum + item.value, 0);
  const scale = (width * height) / total;
  const queue = positive.map((item) => ({ area: item.value * scale, data: item.data }));

  const out: TreemapRect<T>[] = [];
  let bounds: Bounds = { x: 0, y: 0, width, height };
  let row: { area: number; data: T }[] = [];
  let rowAreas: number[] = [];

  for (const item of queue) {
    const side = Math.min(bounds.width, bounds.height);
    const candidate = [...rowAreas, item.area];
    if (row.length === 0 || worstRatio(candidate, side) <= worstRatio(rowAreas, side)) {
      row.push(item);
      rowAreas = candidate;
      continue;
    }
    bounds = placeRow(row, bounds, out);
    row = [item];
    rowAreas = [item.area];
  }
  if (row.length > 0) placeRow(row, bounds, out);

  return out;
}
