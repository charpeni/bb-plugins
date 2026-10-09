// The fish you can catch, the maps they live in, and the seasons. Shared by the
// app (rolls catches, draws scenes) and the server (validates what it records).

import type { Requirement } from "./progress.js";

/** Realtime channel the server publishes on after recording a catch. */
export const CATCH_CHANNEL = "catch";

export type Rarity = "common" | "uncommon" | "rare" | "legendary";
export type TimeOfDay = "dawn" | "day" | "dusk" | "night";
export type SizeTier = "S" | "M" | "L" | "XL";
export type MapId = "lake" | "river" | "marsh";
export type Season = "spring" | "summer" | "autumn" | "winter";

export type MapInfo = {
  id: MapId;
  name: string;
  description: string;
  /** Omitted for the map every player starts at. */
  unlock?: Requirement;
};

export const MAPS: readonly MapInfo[] = [
  { id: "lake", name: "Pine Lake", description: "Calm water under pine hills." },
  {
    id: "river",
    name: "Birch River",
    description: "A quick current past birches and boulders. Trout and salmon country.",
    unlock: { kind: "species", count: 6 },
  },
  {
    id: "marsh",
    name: "Cattail Marsh",
    description: "Warm, weedy shallows full of bass, pike, and stranger things.",
    unlock: { kind: "species", count: 12 },
  },
];

export const MAP_IDS = MAPS.map((map) => map.id) as [MapId, ...MapId[]];
export const SEASONS: readonly Season[] = ["spring", "summer", "autumn", "winter"];

export type Species = {
  id: string;
  name: string;
  rarity: Rarity;
  minCm: number;
  maxCm: number;
  /** Sprite colors: back, belly. */
  colors: readonly [string, string];
  /** Maps this fish lives in. */
  homes: readonly MapId[];
  /** Only swims in at these times of day; omitted means any time. */
  times?: readonly TimeOfDay[];
};

export const SPECIES: readonly Species[] = [
  // Pine Lake, Birch River, and Cattail Marsh share a few fish.
  common("bluegill", "Bluegill", 12, 25, ["#3f6d8c", "#e8a33d"], ["lake", "marsh"]),
  common("yellow-perch", "Yellow Perch", 15, 30, ["#6b7d2f", "#f0d264"], ["lake"]),
  common("pumpkinseed", "Pumpkinseed", 10, 22, ["#4f7f6a", "#f08a3c"], ["lake", "marsh"]),
  common("rock-bass", "Rock Bass", 15, 28, ["#5b4a3a", "#b88a5a"], ["lake"]),
  common("creek-chub", "Creek Chub", 10, 25, ["#7c7f86", "#d9d6cc"], ["river"]),
  common("fallfish", "Fallfish", 15, 40, ["#7d8a92", "#e6e2d6"], ["river"]),
  common("white-sucker", "White Sucker", 25, 50, ["#6b6455", "#d9d2c0"], ["river"]),
  common("golden-shiner", "Golden Shiner", 8, 20, ["#a89a4a", "#f3e6a0"], ["marsh"]),
  {
    ...common("brown-bullhead", "Brown Bullhead", 20, 38, ["#4a3b2c", "#c9b48a"], ["marsh"]),
    times: ["dusk", "night"],
  },
  {
    id: "smallmouth-bass",
    name: "Smallmouth Bass",
    rarity: "uncommon",
    minCm: 25,
    maxCm: 50,
    colors: ["#6e6033", "#d8c690"],
    homes: ["lake", "river"],
  },
  {
    id: "largemouth-bass",
    name: "Largemouth Bass",
    rarity: "uncommon",
    minCm: 30,
    maxCm: 60,
    colors: ["#3d6b35", "#e2e0b0"],
    homes: ["marsh"],
  },
  {
    id: "black-crappie",
    name: "Black Crappie",
    rarity: "uncommon",
    minCm: 20,
    maxCm: 35,
    colors: ["#3a4048", "#cfd4cf"],
    homes: ["lake", "marsh"],
    times: ["dawn", "dusk"],
  },
  {
    id: "rainbow-trout",
    name: "Rainbow Trout",
    rarity: "uncommon",
    minCm: 30,
    maxCm: 60,
    colors: ["#5d7a5a", "#e898a8"],
    homes: ["river"],
    times: ["dawn", "day"],
  },
  {
    id: "brown-trout",
    name: "Brown Trout",
    rarity: "uncommon",
    minCm: 25,
    maxCm: 65,
    colors: ["#6e5a32", "#e8c87a"],
    homes: ["river"],
    times: ["dawn", "dusk", "night"],
  },
  {
    id: "walleye",
    name: "Walleye",
    rarity: "uncommon",
    minCm: 35,
    maxCm: 70,
    colors: ["#8a7a3a", "#efe2b0"],
    homes: ["lake", "river"],
    times: ["dusk", "night"],
  },
  {
    id: "chain-pickerel",
    name: "Chain Pickerel",
    rarity: "uncommon",
    minCm: 30,
    maxCm: 60,
    colors: ["#4e6a3a", "#e2e0a8"],
    homes: ["marsh"],
  },
  {
    id: "brook-trout",
    name: "Brook Trout",
    rarity: "rare",
    minCm: 25,
    maxCm: 50,
    colors: ["#3c5a46", "#e0663c"],
    homes: ["river"],
    times: ["dawn", "day"],
  },
  {
    id: "northern-pike",
    name: "Northern Pike",
    rarity: "rare",
    minCm: 50,
    maxCm: 100,
    colors: ["#4c6b3a", "#e4e6b6"],
    homes: ["lake", "marsh"],
  },
  {
    id: "channel-catfish",
    name: "Channel Catfish",
    rarity: "rare",
    minCm: 40,
    maxCm: 90,
    colors: ["#5f6f7c", "#e6e4dc"],
    homes: ["marsh"],
    times: ["night"],
  },
  {
    id: "lake-trout",
    name: "Lake Trout",
    rarity: "rare",
    minCm: 50,
    maxCm: 90,
    colors: ["#4a5560", "#d8dccf"],
    homes: ["lake"],
  },
  {
    id: "american-eel",
    name: "American Eel",
    rarity: "rare",
    minCm: 40,
    maxCm: 100,
    colors: ["#4a4a2e", "#c8c2a0"],
    homes: ["river"],
    times: ["night"],
  },
  {
    id: "bowfin",
    name: "Bowfin",
    rarity: "rare",
    minCm: 45,
    maxCm: 90,
    colors: ["#5a6a3a", "#d8d0a0"],
    homes: ["marsh"],
  },
  {
    id: "longnose-gar",
    name: "Longnose Gar",
    rarity: "rare",
    minCm: 60,
    maxCm: 120,
    colors: ["#6a7048", "#e8e2c8"],
    homes: ["marsh"],
    times: ["day", "dusk"],
  },
  {
    id: "muskellunge",
    name: "Muskellunge",
    rarity: "legendary",
    minCm: 90,
    maxCm: 140,
    colors: ["#6f7a46", "#efe9c4"],
    homes: ["lake"],
  },
  {
    id: "lake-sturgeon",
    name: "Lake Sturgeon",
    rarity: "legendary",
    minCm: 100,
    maxCm: 180,
    colors: ["#5a5148", "#c8bfae"],
    homes: ["lake", "river"],
  },
  {
    id: "ouananiche",
    name: "Ouananiche",
    rarity: "legendary",
    minCm: 45,
    maxCm: 75,
    colors: ["#6a7f96", "#f2efe6"],
    homes: ["lake"],
    times: ["dawn"],
  },
  {
    id: "atlantic-salmon",
    name: "Atlantic Salmon",
    rarity: "legendary",
    minCm: 60,
    maxCm: 110,
    colors: ["#5e6e80", "#f0eee6"],
    homes: ["river"],
    times: ["dawn", "dusk"],
  },
  {
    id: "tiger-muskellunge",
    name: "Tiger Muskellunge",
    rarity: "legendary",
    minCm: 80,
    maxCm: 130,
    colors: ["#7a7a42", "#efe8c0"],
    homes: ["marsh"],
  },
];

function common(
  id: string,
  name: string,
  minCm: number,
  maxCm: number,
  colors: readonly [string, string],
  homes: readonly MapId[],
): Species {
  return { id, name, rarity: "common", minCm, maxCm, colors, homes };
}

const SPECIES_BY_ID = new Map(SPECIES.map((species) => [species.id, species]));

export const RARITIES: readonly Rarity[] = ["common", "uncommon", "rare", "legendary"];

const RARITY_WEIGHT: Record<Rarity, number> = { common: 60, uncommon: 28, rare: 10, legendary: 2 };

/** How hard a fish pulls. Scales tension gain and slows reeling. */
export const RARITY_STRENGTH: Record<Rarity, number> = {
  common: 1,
  uncommon: 1.35,
  rare: 1.8,
  legendary: 2.4,
};

export type Catch = { speciesId: string; lengthCm: number; tier: SizeTier };

export function findSpecies(id: string): Species | undefined {
  return SPECIES_BY_ID.get(id);
}

export function findMap(id: string): MapInfo | undefined {
  return MAPS.find((map) => map.id === id);
}

export function mapName(id: MapId): string {
  return findMap(id)?.name ?? id;
}

/** Northern-hemisphere meteorological seasons. */
export function seasonOf(date: Date): Season {
  const month = date.getMonth();
  if (month >= 2 && month <= 4) return "spring";
  if (month >= 5 && month <= 7) return "summer";
  if (month >= 8 && month <= 10) return "autumn";
  return "winter";
}

export function timeOfDay(date: Date): TimeOfDay {
  const hour = date.getHours();
  if (hour >= 5 && hour < 8) return "dawn";
  if (hour >= 8 && hour < 18) return "day";
  if (hour >= 18 && hour < 21) return "dusk";
  return "night";
}

export function bitesAt(species: Species, time: TimeOfDay): boolean {
  return species.times === undefined || species.times.includes(time);
}

/** S, M, L, or XL from where a length sits in the species' range. */
export function sizeTier(species: Species, lengthCm: number): SizeTier {
  const span = species.maxCm - species.minCm;
  const fraction = span <= 0 ? 0 : (lengthCm - species.minCm) / span;
  if (fraction < 0.4) return "S";
  if (fraction < 0.7) return "M";
  if (fraction < 0.9) return "L";
  return "XL";
}

export function isValidLength(species: Species, lengthCm: number): boolean {
  return Number.isInteger(lengthCm) && lengthCm >= species.minCm && lengthCm <= species.maxCm;
}

/** Picks a rarity by weight, then a species of that rarity that lives here and swims now. */
export function rollCatch(rng: () => number, time: TimeOfDay, map: MapId): Catch {
  const available = SPECIES.filter(
    (species) => species.homes.includes(map) && bitesAt(species, time),
  );
  const rarities = RARITIES.filter((rarity) =>
    available.some((species) => species.rarity === rarity),
  );
  const total = rarities.reduce((sum, rarity) => sum + RARITY_WEIGHT[rarity], 0);
  let pick = rng() * total;
  let rarity = rarities[rarities.length - 1]!;
  for (const candidate of rarities) {
    pick -= RARITY_WEIGHT[candidate];
    if (pick < 0) {
      rarity = candidate;
      break;
    }
  }
  const pool = available.filter((species) => species.rarity === rarity);
  const species = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))]!;
  // Skewed toward small fish so an XL feels like an event.
  const lengthCm = Math.round(species.minCm + (species.maxCm - species.minCm) * rng() ** 1.6);
  return { speciesId: species.id, lengthCm, tier: sizeTier(species, lengthCm) };
}
