import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOOK,
  isUnlocked,
  lockedParts,
  PARTS,
  resolveSeason,
  sanitizeLook,
  SKINS,
  unlockedRewards,
  type Look,
} from "./look";
import { meets, NO_STATS, progressLabel, requirementLabel, type Stats } from "./progress";

const veteran: Stats = {
  catches: 300,
  species: 20,
  legendaries: 3,
  xl: 10,
  catchesByMap: { lake: 200, river: 60, marsh: 40 },
};

describe("progress", () => {
  it("checks each kind of milestone", () => {
    const stats: Stats = { ...NO_STATS, catches: 10, species: 4, catchesByMap: { river: 3 } };
    expect(meets(undefined, stats)).toBe(true);
    expect(meets({ kind: "catches", count: 10 }, stats)).toBe(true);
    expect(meets({ kind: "species", count: 6 }, stats)).toBe(false);
    expect(meets({ kind: "map-catches", map: "river", count: 3 }, stats)).toBe(true);
    expect(meets({ kind: "map-catches", map: "marsh", count: 1 }, stats)).toBe(false);
    expect(progressLabel({ kind: "species", count: 6 }, stats)).toBe("4/6");
    expect(progressLabel({ kind: "catches", count: 5 }, stats)).toBe("5/5");
    const name = (map: string) => (map === "river" ? "Birch River" : map);
    expect(requirementLabel({ kind: "map-catches", map: "river", count: 1 }, name)).toBe(
      "Catch 1 fish at Birch River",
    );
    expect(requirementLabel({ kind: "legendaries", count: 3 }, name)).toBe("Land 3 legendary fish");
  });
});

describe("look", () => {
  it("starts with a look that needs nothing unlocked", () => {
    expect(lockedParts(DEFAULT_LOOK, NO_STATS)).toEqual([]);
    expect(unlockedRewards(NO_STATS)).toEqual([]);
  });

  it("never locks skin tones", () => {
    expect(SKINS.every((skin) => skin.unlock === undefined)).toBe(true);
  });

  it("names locked and unknown parts", () => {
    const look: Look = { ...DEFAULT_LOOK, map: "marsh", paint: "golden", hat: "sombrero" };
    expect(lockedParts(look, NO_STATS)).toEqual(["map", "hat", "paint"]);
    expect(lockedParts(look, veteran)).toEqual(["hat"]);
  });

  it("falls back to defaults for anything locked or unknown", () => {
    const stored = {
      ...DEFAULT_LOOK,
      map: "river",
      dog: "golden",
      boat: "yacht",
      season: "winter",
    };
    expect(sanitizeLook(stored as Look, NO_STATS)).toEqual({ ...DEFAULT_LOOK, season: "winter" });
    expect(sanitizeLook(stored as Look, veteran)).toEqual({
      ...DEFAULT_LOOK,
      map: "river",
      dog: "golden",
      season: "winter",
    });
    expect(sanitizeLook(null, veteran)).toEqual(DEFAULT_LOOK);
    // Inherited object keys are not seasons.
    expect(sanitizeLook({ season: "toString" } as unknown as Look, veteran).season).toBe("auto");
  });

  it("unlocks everything for a veteran", () => {
    for (const options of Object.values(PARTS)) {
      expect(options.length).toBeGreaterThan(1);
      for (const option of options) expect(isUnlocked(option, veteran), option.id).toBe(true);
    }
    expect(unlockedRewards(veteran)).toContain("Cattail Marsh");
    expect(unlockedRewards(veteran)).toContain("Golden (paint)");
  });

  it("follows the calendar unless a season is pinned", () => {
    const october = new Date(2026, 9, 9);
    expect(resolveSeason(DEFAULT_LOOK, october)).toBe("autumn");
    expect(resolveSeason({ ...DEFAULT_LOOK, season: "winter" }, october)).toBe("winter");
  });
});
