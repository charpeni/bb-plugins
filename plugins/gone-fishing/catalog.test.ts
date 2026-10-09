import { describe, expect, it } from "vitest";
import {
  findSpecies,
  MAPS,
  rollCatch,
  seasonOf,
  SPECIES,
  sizeTier,
  timeOfDay,
  type TimeOfDay,
} from "./catalog";
import { mulberry32 } from "./game";

const TIMES = ["dawn", "day", "dusk", "night"] as const satisfies TimeOfDay[];

describe("rollCatch", () => {
  it("only rolls fish that live on the map and swim now, within their size range", () => {
    for (const map of MAPS) {
      for (const time of TIMES) {
        const rng = mulberry32(7);
        for (let i = 0; i < 1_000; i++) {
          const caught = rollCatch(rng, time, map.id);
          const species = findSpecies(caught.speciesId)!;
          expect(species.homes).toContain(map.id);
          expect(species.times === undefined || species.times.includes(time)).toBe(true);
          expect(caught.lengthCm).toBeGreaterThanOrEqual(species.minCm);
          expect(caught.lengthCm).toBeLessThanOrEqual(species.maxCm);
          expect(caught.tier).toBe(sizeTier(species, caught.lengthCm));
        }
      }
    }
  });

  it("keeps legendaries rare and commons common", () => {
    const rng = mulberry32(11);
    const counts = { common: 0, uncommon: 0, rare: 0, legendary: 0 };
    for (let i = 0; i < 10_000; i++) {
      counts[findSpecies(rollCatch(rng, "dawn", "lake").speciesId)!.rarity]++;
    }
    expect(counts.common / 10_000).toBeCloseTo(0.6, 1);
    expect(counts.legendary / 10_000).toBeGreaterThan(0.01);
    expect(counts.legendary / 10_000).toBeLessThan(0.04);
  });
});

describe("catalog", () => {
  it("has unique ids, and every fish lives on a known map", () => {
    expect(new Set(SPECIES.map((species) => species.id)).size).toBe(SPECIES.length);
    const mapIds = MAPS.map((map) => map.id);
    for (const species of SPECIES) {
      expect(species.homes.length).toBeGreaterThan(0);
      for (const home of species.homes) expect(mapIds).toContain(home);
    }
  });

  it("gives every map commons at every time of day, and a legendary", () => {
    for (const map of MAPS) {
      const locals = SPECIES.filter((species) => species.homes.includes(map.id));
      for (const time of TIMES) {
        const common = locals.some(
          (s) => s.rarity === "common" && (s.times === undefined || s.times.includes(time)),
        );
        expect(common, `${map.id} at ${time}`).toBe(true);
      }
      expect(
        locals.some((species) => species.rarity === "legendary"),
        map.id,
      ).toBe(true);
    }
  });

  it("maps hours to times of day and months to seasons", () => {
    expect(timeOfDay(new Date(2026, 9, 9, 6))).toBe("dawn");
    expect(timeOfDay(new Date(2026, 9, 9, 12))).toBe("day");
    expect(timeOfDay(new Date(2026, 9, 9, 19))).toBe("dusk");
    expect(timeOfDay(new Date(2026, 9, 9, 23))).toBe("night");
    expect(timeOfDay(new Date(2026, 9, 9, 2))).toBe("night");
    expect(seasonOf(new Date(2026, 2, 1))).toBe("spring");
    expect(seasonOf(new Date(2026, 6, 1))).toBe("summer");
    expect(seasonOf(new Date(2026, 9, 9))).toBe("autumn");
    expect(seasonOf(new Date(2026, 11, 31))).toBe("winter");
    expect(seasonOf(new Date(2027, 1, 1))).toBe("winter");
  });

  it("sizes the top tenth of a range as XL", () => {
    const pike = findSpecies("northern-pike")!;
    expect(sizeTier(pike, 50)).toBe("S");
    expect(sizeTier(pike, 75)).toBe("M");
    expect(sizeTier(pike, 90)).toBe("L");
    expect(sizeTier(pike, 100)).toBe("XL");
  });
});
