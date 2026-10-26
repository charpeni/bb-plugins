import { describe, expect, it } from "vitest";
import {
  clampWindow,
  fitRange,
  formatTick,
  isFull,
  MIN_WINDOW_MS,
  panBy,
  ticksFor,
  zoomAt,
} from "./view.js";

const TOTAL = 600_000;

describe("zoomAt", () => {
  it("keeps the anchor under the pointer", () => {
    const zoomed = zoomAt({ from: 0, to: TOTAL }, TOTAL, 0.25, 0.5);
    expect(zoomed).toEqual({ from: 75_000, to: 375_000 });
  });

  it("never zooms out past the whole turn", () => {
    const zoomed = zoomAt({ from: 100_000, to: 200_000 }, TOTAL, 0.5, 100);
    expect(zoomed).toEqual({ from: 0, to: TOTAL });
    expect(isFull(zoomed, TOTAL)).toBe(true);
  });

  it("stops at the narrowest window", () => {
    const zoomed = zoomAt({ from: 1_000, to: 1_100 }, TOTAL, 0.5, 0.01);
    expect(zoomed.to - zoomed.from).toBe(MIN_WINDOW_MS);
  });
});

describe("panBy", () => {
  it("moves the window and stops at either end", () => {
    expect(panBy({ from: 100_000, to: 200_000 }, TOTAL, 50_000)).toEqual({
      from: 150_000,
      to: 250_000,
    });
    expect(panBy({ from: 100_000, to: 200_000 }, TOTAL, -500_000)).toEqual({
      from: 0,
      to: 100_000,
    });
    expect(panBy({ from: 100_000, to: 200_000 }, TOTAL, 900_000)).toEqual({
      from: 500_000,
      to: TOTAL,
    });
  });
});

describe("fitRange", () => {
  it("frames a span with padding, inside the turn", () => {
    expect(fitRange(100_000, 200_000, TOTAL)).toEqual({ from: 90_000, to: 210_000 });
    expect(clampWindow(fitRange(0, 0, TOTAL), TOTAL)).toEqual({ from: 0, to: MIN_WINDOW_MS });
  });
});

describe("ticks", () => {
  it("picks a round step with at most six ticks", () => {
    expect(ticksFor({ from: 0, to: TOTAL })).toEqual({
      step: 120_000,
      ticks: [0, 120_000, 240_000, 360_000, 480_000],
    });
    expect(ticksFor({ from: 61_250, to: 62_000 }).ticks).toEqual([61_400, 61_600, 61_800]);
  });

  it("labels ticks only as precisely as the step needs", () => {
    expect(formatTick(0, 60_000)).toBe("0s");
    expect(formatTick(300_000, 60_000)).toBe("5m");
    expect(formatTick(90_000, 30_000)).toBe("1m 30s");
    expect(formatTick(45_000, 15_000)).toBe("45s");
    expect(formatTick(61_400, 200)).toBe("1m 1.4s");
    expect(formatTick(1_250, 50)).toBe("1.25s");
    expect(formatTick(5_400_000, 1_800_000)).toBe("1h 30m");
  });
});
