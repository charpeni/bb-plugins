import { describe, expect, it } from "vitest";
import { approach, easeLevel, FLOOD_MS } from "./underwater";

describe("flood level", () => {
  it("rises and drains at a constant rate without overshooting", () => {
    expect(approach(0, 1, FLOOD_MS / 2)).toBeCloseTo(0.5);
    expect(approach(0.9, 1, FLOOD_MS)).toBe(1);
    expect(approach(0.5, 0, FLOOD_MS / 4)).toBeCloseTo(0.25);
    expect(approach(0.1, 0, FLOOD_MS)).toBe(0);
  });

  it("eases in and out between empty and full", () => {
    expect(easeLevel(0)).toBe(0);
    expect(easeLevel(1)).toBe(1);
    expect(easeLevel(0.5)).toBe(0.5);
    expect(easeLevel(0.1)).toBeLessThan(0.1);
  });
});
