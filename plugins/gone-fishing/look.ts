// How the pond looks: the map, the season, and the angler, boat, and dog. Each
// option can be locked behind a milestone. Shared by the server, which stores
// and enforces the look, and the app, which draws it and offers the choices.

import { MAPS, SEASONS, seasonOf, type MapId, type Season } from "./catalog.js";
import { meets, type Requirement, type Stats } from "./progress.js";

/** Realtime channel the server publishes on when the look or the unlocks change. */
export const PROFILE_CHANNEL = "profile";

export type Option = { id: string; name: string; unlock?: Requirement };

/** Sprite rows replace the angler's top two rows: the hat, or hair without one. */
export type HatOption = Option & { rows: readonly [string, string]; ink: Record<string, string> };
export type ColorOption = Option & { color: string };
/** Two colors make a check pattern. */
export type JacketOption = Option & { colors: readonly [string] | readonly [string, string] };
export type BoatOption = Option & { rows: readonly string[] };
export type PaintOption = Option & { trim: string; hull: string };
/** `spots` paints a pattern over the body; `none` leaves the dog at home. */
export type DogOption = Option & { body: string; dark: string; spots?: string; none?: true };

// Skin tones are never locked.
export const SKINS: readonly ColorOption[] = [
  { id: "light", name: "Light", color: "#f6d8bd" },
  { id: "medium-light", name: "Medium light", color: "#efc39b" },
  { id: "medium", name: "Medium", color: "#c99366" },
  { id: "medium-dark", name: "Medium dark", color: "#9a6644" },
  { id: "dark", name: "Dark", color: "#64412c" },
];

export const HATS: readonly HatOption[] = [
  { id: "straw", name: "Straw hat", rows: ["..HHH.", ".HHHHH"], ink: { H: "#e2bb52" } },
  { id: "cap", name: "Cap", rows: ["..HHH.", "..HHBB"], ink: { H: "#33507f", B: "#243a5e" } },
  { id: "none", name: "No hat", rows: ["......", "..KKK."], ink: { K: "#3a2a1e" } },
  {
    id: "beanie",
    name: "Beanie",
    rows: ["...W..", "..HHH."],
    ink: { H: "#d8662e", W: "#f4efe6" },
    unlock: { kind: "catches", count: 25 },
  },
  {
    id: "bucket",
    name: "Bucket hat",
    rows: [".HHHH.", "HHHHHH"],
    ink: { H: "#6b7a3a" },
    unlock: { kind: "xl", count: 3 },
  },
];

export const JACKETS: readonly JacketOption[] = [
  { id: "red", name: "Red jacket", colors: ["#c4473a"] },
  { id: "blue", name: "Blue jacket", colors: ["#3a6fc4"] },
  { id: "green", name: "Green jacket", colors: ["#3f8a4a"] },
  {
    id: "slicker",
    name: "Rain slicker",
    colors: ["#e8b62e"],
    unlock: { kind: "map-catches", map: "river", count: 25 },
  },
  {
    id: "plaid",
    name: "Plaid flannel",
    colors: ["#b8382e", "#3a1c1a"],
    unlock: { kind: "catches", count: 250 },
  },
];

// L is the trim, D the hull; the paint picks their colors.
export const BOATS: readonly BoatOption[] = [
  {
    id: "rowboat",
    name: "Rowboat",
    rows: [
      "L.......................L",
      "LLLLLLLLLLLLLLLLLLLLLLLLL",
      ".DDDDDDDDDDDDDDDDDDDDDDD.",
      "..DDDDDDDDDDDDDDDDDDDDD..",
    ],
  },
  {
    id: "canoe",
    name: "Canoe",
    rows: [
      "D.......................D",
      ".DLLLLLLLLLLLLLLLLLLLLLD.",
      "..DDDDDDDDDDDDDDDDDDDDD..",
      "....DDDDDDDDDDDDDDDDD....",
    ],
    unlock: { kind: "map-catches", map: "river", count: 10 },
  },
  {
    id: "kayak",
    name: "Kayak",
    rows: [
      ".........................",
      "...LLLLLLLLLLLLLLLLLLL...",
      ".DDDDDDDDDDDDDDDDDDDDDDD.",
      "....DDDDDDDDDDDDDDDDD....",
    ],
    unlock: { kind: "map-catches", map: "marsh", count: 10 },
  },
];

export const PAINTS: readonly PaintOption[] = [
  { id: "wood", name: "Varnished wood", trim: "#c08a52", hull: "#7a4f2a" },
  { id: "white", name: "White", trim: "#f2f1ea", hull: "#b9b8ae" },
  {
    id: "red",
    name: "Red",
    trim: "#e9705e",
    hull: "#a8352a",
    unlock: { kind: "catches", count: 50 },
  },
  {
    id: "blue",
    name: "Blue",
    trim: "#74a3e6",
    hull: "#2b4f8c",
    unlock: { kind: "catches", count: 100 },
  },
  {
    id: "green",
    name: "Green",
    trim: "#76b276",
    hull: "#2f6a3a",
    unlock: { kind: "species", count: 15 },
  },
  {
    id: "golden",
    name: "Golden",
    trim: "#f7da6e",
    hull: "#c48f22",
    unlock: { kind: "legendaries", count: 1 },
  },
];

export const DOGS: readonly DogOption[] = [
  { id: "tan", name: "Tan", body: "#c99c62", dark: "#6e4a2a" },
  { id: "black", name: "Black", body: "#3b3a3a", dark: "#1b1a1a" },
  { id: "none", name: "No dog", body: "", dark: "", none: true },
  {
    id: "spotted",
    name: "Spotted",
    body: "#f0ece2",
    dark: "#3a3a3a",
    spots: "#3a3a3a",
    unlock: { kind: "catches", count: 15 },
  },
  {
    id: "husky",
    name: "Husky",
    body: "#a5abb4",
    dark: "#4a4f58",
    unlock: { kind: "map-catches", map: "marsh", count: 30 },
  },
  {
    id: "golden",
    name: "Golden",
    body: "#e8b84a",
    dark: "#a8702a",
    unlock: { kind: "legendaries", count: 3 },
  },
];

export const SEASON_NAMES: Record<Season, string> = {
  spring: "Spring",
  summer: "Summer",
  autumn: "Autumn",
  winter: "Winter",
};

export type Look = {
  map: MapId;
  /** "auto" follows the calendar. */
  season: Season | "auto";
  skin: string;
  hat: string;
  jacket: string;
  boat: string;
  paint: string;
  dog: string;
};

export type LockablePart = Exclude<keyof Look, "season">;

export const DEFAULT_LOOK: Look = {
  map: "lake",
  season: "auto",
  skin: "medium-light",
  hat: "straw",
  jacket: "red",
  boat: "rowboat",
  paint: "wood",
  dog: "tan",
};

export const PARTS: Record<LockablePart, readonly Option[]> = {
  map: MAPS,
  skin: SKINS,
  hat: HATS,
  jacket: JACKETS,
  boat: BOATS,
  paint: PAINTS,
  dog: DOGS,
};

const PART_NAMES: Record<LockablePart, string> = {
  map: "map",
  skin: "skin tone",
  hat: "hat",
  jacket: "jacket",
  boat: "boat",
  paint: "paint",
  dog: "dog",
};

export function findOption<T extends Option>(options: readonly T[], id: string): T {
  return options.find((option) => option.id === id) ?? options[0]!;
}

export function isUnlocked(option: Option, stats: Stats): boolean {
  return meets(option.unlock, stats);
}

/** Parts set to an unknown or locked option, for the server's validation. */
export function lockedParts(look: Look, stats: Stats): string[] {
  return (Object.keys(PARTS) as LockablePart[]).flatMap((part) => {
    const option = PARTS[part].find((entry) => entry.id === look[part]);
    return option && isUnlocked(option, stats) ? [] : [PART_NAMES[part]];
  });
}

/** Swaps unknown or locked options for the defaults, e.g. after a catalog change. */
export function sanitizeLook(value: Partial<Look> | null | undefined, stats: Stats): Look {
  const look: Look = { ...DEFAULT_LOOK };
  for (const part of Object.keys(PARTS) as LockablePart[]) {
    const option = PARTS[part].find((entry) => entry.id === value?.[part]);
    if (option && isUnlocked(option, stats))
      (look as Record<LockablePart, string>)[part] = option.id;
  }
  const season = value?.season;
  if (season === "auto" || SEASONS.includes(season as Season))
    look.season = season as Look["season"];
  return look;
}

/** Everything a milestone has unlocked, for spotting what a catch just unlocked. */
export function unlockedRewards(stats: Stats): string[] {
  return (Object.keys(PARTS) as LockablePart[]).flatMap((part) =>
    PARTS[part]
      .filter((option) => option.unlock !== undefined && isUnlocked(option, stats))
      .map((option) => (part === "map" ? option.name : `${option.name} (${PART_NAMES[part]})`)),
  );
}

export function resolveSeason(look: Look, date: Date): Season {
  return look.season === "auto" ? seasonOf(date) : look.season;
}
