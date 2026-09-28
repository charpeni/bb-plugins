import { describe, expect, it } from "vitest";
import { squarify, type TreemapRect } from "./treemap.js";

const WIDTH = 800;
const HEIGHT = 420;

function items(values: number[]) {
  return values.map((value, index) => ({ value, data: `item-${index}` }));
}

function overlaps(a: TreemapRect<string>, b: TreemapRect<string>): boolean {
  const epsilon = 1e-6;
  return (
    a.x < b.x + b.width - epsilon &&
    b.x < a.x + a.width - epsilon &&
    a.y < b.y + b.height - epsilon &&
    b.y < a.y + a.height - epsilon
  );
}

describe("squarify", () => {
  it("gives each rectangle an area proportional to its value", () => {
    const values = [500, 250, 120, 80, 30, 15, 5];
    const rects = squarify(items(values), WIDTH, HEIGHT);
    const total = values.reduce((sum, value) => sum + value, 0);

    expect(rects).toHaveLength(values.length);
    for (const rect of rects) {
      const value = values[Number(rect.data.split("-")[1])]!;
      expect(rect.width * rect.height).toBeCloseTo((value / total) * WIDTH * HEIGHT, 6);
    }
  });

  it("tiles the whole box without overlaps or overflow", () => {
    const rects = squarify(items([90, 60, 40, 33, 20, 12, 7, 4, 2, 1]), WIDTH, HEIGHT);
    const covered = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0);

    expect(covered).toBeCloseTo(WIDTH * HEIGHT, 6);
    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(-1e-6);
      expect(rect.y).toBeGreaterThanOrEqual(-1e-6);
      expect(rect.x + rect.width).toBeLessThanOrEqual(WIDTH + 1e-6);
      expect(rect.y + rect.height).toBeLessThanOrEqual(HEIGHT + 1e-6);
    }
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
      }
    }
  });

  it("keeps equal values close to square", () => {
    const rects = squarify(items(Array.from({ length: 16 }, () => 1)), 400, 400);
    for (const rect of rects) {
      const ratio = Math.max(rect.width / rect.height, rect.height / rect.width);
      expect(ratio).toBeLessThan(1.5);
    }
  });

  it("orders rectangles largest-first regardless of input order", () => {
    const rects = squarify(items([1, 10, 5]), WIDTH, HEIGHT);
    expect(rects.map((rect) => rect.data)).toEqual(["item-1", "item-2", "item-0"]);
  });

  it("skips non-positive values and degenerate boxes", () => {
    expect(squarify(items([0, 3, 0]), WIDTH, HEIGHT).map((rect) => rect.data)).toEqual(["item-1"]);
    expect(squarify(items([0, 0]), WIDTH, HEIGHT)).toEqual([]);
    expect(squarify(items([1, 2]), 0, HEIGHT)).toEqual([]);
  });
});
