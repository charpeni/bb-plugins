// What a player has caught so far, and the milestones that unlock maps and
// cosmetics. Pure, so the server (which enforces unlocks) and the app (which
// shows progress) agree.

import type { MapId } from "./catalog.js";

export type Stats = {
  catches: number;
  /** Distinct species ever caught. */
  species: number;
  legendaries: number;
  /** Catches in the top size tier of their species. */
  xl: number;
  catchesByMap: Partial<Record<MapId, number>>;
};

export type Requirement =
  | { kind: "catches"; count: number }
  | { kind: "species"; count: number }
  | { kind: "legendaries"; count: number }
  | { kind: "xl"; count: number }
  | { kind: "map-catches"; map: MapId; count: number };

export const NO_STATS: Stats = { catches: 0, species: 0, legendaries: 0, xl: 0, catchesByMap: {} };

function current(requirement: Requirement, stats: Stats): number {
  switch (requirement.kind) {
    case "catches":
      return stats.catches;
    case "species":
      return stats.species;
    case "legendaries":
      return stats.legendaries;
    case "xl":
      return stats.xl;
    case "map-catches":
      return stats.catchesByMap[requirement.map] ?? 0;
  }
}

/** Options without a requirement are always available. */
export function meets(requirement: Requirement | undefined, stats: Stats): boolean {
  return requirement === undefined || current(requirement, stats) >= requirement.count;
}

/** What to do to unlock it, for example "Catch 10 species". */
export function requirementLabel(
  requirement: Requirement,
  mapName: (map: MapId) => string,
): string {
  // "fish", "species", and "XL fish" read the same in the singular.
  const { count } = requirement;
  switch (requirement.kind) {
    case "catches":
      return `Catch ${count} fish`;
    case "species":
      return `Catch ${count} species`;
    case "legendaries":
      return `Land ${count} legendary fish`;
    case "xl":
      return `Land ${count} XL fish`;
    case "map-catches":
      return `Catch ${count} fish at ${mapName(requirement.map)}`;
  }
}

/** How far along the player is, for example "4/10". */
export function progressLabel(requirement: Requirement, stats: Stats): string {
  return `${Math.min(current(requirement, stats), requirement.count)}/${requirement.count}`;
}
