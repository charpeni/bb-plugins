// The fishing rules as a pure state machine: no DOM, no clock, no randomness of
// its own. The banner feeds it elapsed time and player input; the scene draws it.

import {
  findSpecies,
  RARITY_STRENGTH,
  rollCatch,
  type Catch,
  type MapId,
  type TimeOfDay,
} from "./catalog.js";

/** Passive fishes by itself; active means the player holds the rod. */
export type Mode = "passive" | "active";
export type LossReason = "missed" | "snapped" | "escaped" | "too-big";

export type HookedFish = Catch & {
  /** The map it was hooked at; it is recorded there even if the map changes mid-fight. */
  mapId: MapId;
  strength: number;
  legendary: boolean;
  /** The player held the rod at some point in this fight. */
  assisted: boolean;
};

/** A fish swimming in the pond: under the strip and behind the chat input. */
export type PondFish = Catch & {
  id: number;
  mapId: MapId;
  /** Across the pond, 0 (left edge) to 1 (right edge). */
  x: number;
  /** Down the flooded chat input, 0 (just under the strip) to 1 (bottom). */
  depth: number;
  /** Pond widths per ms; the sign is the heading. */
  speed: number;
};

/** A fish from the pond on its way to the hook. */
export type Approach = { fishId: number; fromX: number; fromDepth: number; elapsed: number };

export type Phase =
  | { kind: "casting"; elapsed: number }
  | { kind: "waiting"; elapsed: number; biteAt: number; approach: Approach | null }
  | { kind: "nibble"; elapsed: number; fish: HookedFish; autoHookAt: number }
  | {
      kind: "fighting";
      elapsed: number;
      fish: HookedFish;
      progress: number;
      tension: number;
      running: boolean;
      /** Time spent in the current run or calm spell. */
      spell: number;
      spellLength: number;
    }
  | { kind: "landed"; elapsed: number; fish: HookedFish }
  | { kind: "lost"; elapsed: number; reason: LossReason }
  | { kind: "docked" };

export type GameState = {
  phase: Phase;
  mode: Mode;
  /** The player is holding the rod (pointer or key down). */
  reeling: boolean;
  /** Time since the player last touched the rod, while active. */
  idle: number;
  /** The agent stopped: land the fish on the line, then dock. */
  finishing: boolean;
  /** Time since the agent stopped, while finishing. */
  finishingFor: number;
  /** Every fish in the pond, including one swimming to the hook. */
  fish: PondFish[];
  nextFishId: number;
  /** Time until another fish swims in, while the pond is short of fish. */
  spawnIn: number;
  /** The pond got its first fish. */
  stocked: boolean;
};

export type GameEvent =
  | { type: "bite" }
  | { type: "caught"; fish: Catch; mode: Mode; mapId: MapId }
  | { type: "lost"; reason: LossReason };

export type StepContext = { rng: () => number; timeOfDay: TimeOfDay; mapId: MapId };

export const CAST_MS = 900;
export const WAIT_MIN_MS = 2_500;
export const WAIT_MAX_MS = 9_500;
/** Where the hook hangs, as a fraction of the pond's width. */
export const HOOK_X = 0.4;
/** A biting fish takes this long to swim from where it was to the hook. */
export const APPROACH_MS = 2_500;
/** Fish the pond keeps; a fish that gets away can briefly make one more. */
export const POPULATION = 4;
const INITIAL_STOCK = 3;
const SPAWN_MIN_MS = 4_000;
const SPAWN_MAX_MS = 10_000;
/** Cruising speed in pond widths per ms: a crossing takes 12 to 35 seconds. */
const SWIM_MIN = 1 / 35_000;
const SWIM_MAX = 1 / 12_000;
const DEPTH_MIN = 0.25;
const DEPTH_MAX = 0.9;
/** How long an active player has to hook a nibbling fish. */
export const NIBBLE_WINDOW_MS = 1_400;
const AUTO_HOOK_MIN_MS = 450;
const AUTO_HOOK_MAX_MS = 900;
/** Auto-fishing lets go of, and picks up, the reel this long after a spell changes. */
const AUTO_REACTION_MS = 200;
/** An active player goes back to auto-fishing after this long without input. */
export const ACTIVE_IDLE_MS = 15_000;
export const LANDED_MS = 2_400;
export const LOST_MS = 1_600;
/** Once the agent stops, a fish still on the line has this long to land. */
export const FINISH_GRACE_MS = 20_000;
/** Progress per ms while reeling a calm fish of strength 1; stronger fish divide it by √strength. */
const REEL_RATE = 1 / 3_000;
const PASSIVE_REEL_FACTOR = 0.7;
/** Tension per ms while reeling into a running fish of strength 1. */
const TENSION_GAIN = 1 / 900;
const TENSION_DECAY = 1 / 1_800;
/** Progress lost per ms while a running fish of strength 1 takes line. */
const RUN_PULL = 1 / 30_000;
/** A legendary fish throws the hook here unless the player helped. */
const LEGENDARY_ESCAPE_PROGRESS = 0.6;

export function newGame(): GameState {
  return {
    phase: { kind: "casting", elapsed: 0 },
    mode: "passive",
    reeling: false,
    idle: 0,
    finishing: false,
    finishingFor: 0,
    fish: [],
    nextFishId: 1,
    spawnIn: 0,
    stocked: false,
  };
}

/** The agent started (again): cast out, or keep the current fight going. The fish stay. */
export function resume(state: GameState): GameState {
  if (state.phase.kind === "docked") {
    return {
      ...state,
      phase: { kind: "casting", elapsed: 0 },
      reeling: false,
      idle: 0,
      finishing: false,
      finishingFor: 0,
    };
  }
  return { ...state, finishing: false, finishingFor: 0 };
}

/** The agent stopped. Only a fish already on the line keeps the pond open. */
export function finish(state: GameState): GameState {
  if (state.phase.kind === "casting" || state.phase.kind === "waiting") {
    return {
      ...state,
      phase: { kind: "docked" },
      reeling: false,
      finishing: true,
      finishingFor: 0,
    };
  }
  return state.finishing ? state : { ...state, finishing: true, finishingFor: 0 };
}

export function hasFishOn(state: GameState): boolean {
  return state.phase.kind === "nibble" || state.phase.kind === "fighting";
}

export function press(state: GameState): GameState {
  const next: GameState = { ...state, mode: "active", reeling: true, idle: 0 };
  const phase = state.phase;
  if (phase.kind === "nibble") {
    next.phase = startFight({ ...phase.fish, assisted: true });
  } else if (phase.kind === "fighting" && !phase.fish.assisted) {
    next.phase = { ...phase, fish: { ...phase.fish, assisted: true } };
  } else if ((phase.kind === "landed" || phase.kind === "lost") && !state.finishing) {
    // Skip the celebration (or the sulking) and cast again.
    next.phase = { kind: "casting", elapsed: 0 };
  }
  return next;
}

export function release(state: GameState): GameState {
  return state.reeling ? { ...state, reeling: false, idle: 0 } : state;
}

/** Moving to another map: its fish swim in, and a fish on the line stays on it. */
export function changeMap(state: GameState): GameState {
  const phase = state.phase.kind === "waiting" ? { ...state.phase, approach: null } : state.phase;
  return { ...state, phase, fish: [], stocked: false, spawnIn: 0 };
}

/** The fish swimming to the hook, if any. */
export function approachingFish(state: GameState): { fish: PondFish; progress: number } | null {
  const phase = state.phase;
  if (phase.kind !== "waiting" || phase.approach === null) return null;
  const { fishId, elapsed } = phase.approach;
  const fish = state.fish.find((entry) => entry.id === fishId);
  return fish ? { fish, progress: Math.min(1, elapsed / APPROACH_MS) } : null;
}

/** The pond's mutable bookkeeping for one step. */
type Pond = Pick<GameState, "fish" | "nextFishId" | "spawnIn" | "stocked">;

export function step(
  state: GameState,
  dt: number,
  context: StepContext,
): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  let mode = state.mode;
  let idle = state.idle;
  if (mode === "active" && !state.reeling) {
    idle += dt;
    if (idle >= ACTIVE_IDLE_MS) {
      mode = "passive";
      idle = 0;
    }
  }
  const finishingFor = state.finishing ? state.finishingFor + dt : 0;
  const base: GameState = { ...state, mode, idle, finishingFor };
  const pond: Pond = {
    fish: [...state.fish],
    nextFishId: state.nextFishId,
    spawnIn: state.spawnIn,
    stocked: state.stocked,
  };
  restock(pond, dt, context);
  const approaching = state.phase.kind === "waiting" ? state.phase.approach?.fishId : undefined;
  pond.fish = pond.fish.map((fish) => (fish.id === approaching ? fish : swim(fish, dt)));
  const phase = advance(base, dt, context, events, pond);
  return { state: { ...base, ...pond, phase }, events };
}

function restock(pond: Pond, dt: number, context: StepContext) {
  if (!pond.stocked) {
    for (let i = 0; i < INITIAL_STOCK; i++) pond.fish.push(spawn(pond, context, "anywhere"));
    pond.stocked = true;
    pond.spawnIn = between(context.rng, SPAWN_MIN_MS, SPAWN_MAX_MS);
    return;
  }
  if (pond.fish.length >= POPULATION) return;
  pond.spawnIn -= dt;
  if (pond.spawnIn > 0) return;
  pond.fish.push(spawn(pond, context, "edge"));
  pond.spawnIn = between(context.rng, SPAWN_MIN_MS, SPAWN_MAX_MS);
}

/** A new fish, rolled for the time of day, somewhere in the pond or swimming in from a side. */
function spawn(pond: Pond, context: StepContext, where: "anywhere" | "edge"): PondFish {
  const { rng } = context;
  const caught = rollCatch(rng, context.timeOfDay, context.mapId);
  const heading = rng() < 0.5 ? 1 : -1;
  const x = where === "edge" ? (heading > 0 ? -0.05 : 1.05) : between(rng, 0.05, 0.95);
  return {
    ...caught,
    id: pond.nextFishId++,
    mapId: context.mapId,
    x,
    depth: between(rng, DEPTH_MIN, DEPTH_MAX),
    speed: heading * between(rng, SWIM_MIN, SWIM_MAX),
  };
}

/** Cruises across the pond and turns around at the banks. */
function swim(fish: PondFish, dt: number): PondFish {
  const x = fish.x + fish.speed * dt;
  const turn = (x < 0.03 && fish.speed < 0) || (x > 0.97 && fish.speed > 0);
  return { ...fish, x, speed: turn ? -fish.speed : fish.speed };
}

/** A fish that got away swims off from the hook and stays in its pond. */
function returnToPond(pond: Pond, fish: HookedFish, context: StepContext) {
  // After a map change, it went home to the other map.
  if (fish.mapId !== context.mapId) return;
  const heading = context.rng() < 0.5 ? 1 : -1;
  pond.fish.push({
    speciesId: fish.speciesId,
    lengthCm: fish.lengthCm,
    tier: fish.tier,
    id: pond.nextFishId++,
    mapId: fish.mapId,
    x: HOOK_X,
    depth: 0.15,
    speed: heading * SWIM_MAX * 1.5,
  });
}

function advance(
  state: GameState,
  dt: number,
  context: StepContext,
  events: GameEvent[],
  pond: Pond,
): Phase {
  const phase = state.phase;
  switch (phase.kind) {
    case "docked":
      return phase;
    case "casting": {
      if (state.finishing) return { kind: "docked" };
      const elapsed = phase.elapsed + dt;
      if (elapsed < CAST_MS) return { kind: "casting", elapsed };
      return {
        kind: "waiting",
        elapsed: 0,
        biteAt: between(context.rng, WAIT_MIN_MS, WAIT_MAX_MS),
        approach: null,
      };
    }
    case "waiting":
      return wait(state, phase, dt, context, events, pond);
    case "nibble": {
      const elapsed = phase.elapsed + dt;
      if (state.mode === "passive" && elapsed >= phase.autoHookAt) return startFight(phase.fish);
      if (state.mode === "active" && elapsed >= NIBBLE_WINDOW_MS) {
        returnToPond(pond, phase.fish, context);
        return lose("missed", events);
      }
      return { ...phase, elapsed };
    }
    case "fighting":
      return fight(state, phase, dt, context, events, pond);
    case "landed":
    case "lost": {
      const elapsed = phase.elapsed + dt;
      const hold = phase.kind === "landed" ? LANDED_MS : LOST_MS;
      if (elapsed < hold) return { ...phase, elapsed };
      return state.finishing ? { kind: "docked" } : { kind: "casting", elapsed: 0 };
    }
  }
}

/** Waits for a fish from the pond to take an interest, then brings it to the hook. */
function wait(
  state: GameState,
  phase: Extract<Phase, { kind: "waiting" }>,
  dt: number,
  context: StepContext,
  events: GameEvent[],
  pond: Pond,
): Phase {
  if (state.finishing) return { kind: "docked" };
  const elapsed = phase.elapsed + dt;
  if (phase.approach === null) {
    if (elapsed < phase.biteAt) return { ...phase, elapsed };
    if (pond.fish.length === 0) pond.fish.push(spawn(pond, context, "edge"));
    const biter =
      pond.fish[Math.min(pond.fish.length - 1, Math.floor(context.rng() * pond.fish.length))]!;
    const approach = { fishId: biter.id, fromX: biter.x, fromDepth: biter.depth, elapsed: 0 };
    return { ...phase, elapsed, approach };
  }

  const approach = { ...phase.approach, elapsed: phase.approach.elapsed + dt };
  const index = pond.fish.findIndex((fish) => fish.id === approach.fishId);
  if (index < 0) return { ...phase, elapsed, approach: null };
  const fish = pond.fish[index]!;
  const t = Math.min(1, approach.elapsed / APPROACH_MS);
  if (t < 1) {
    const eased = t * t * (3 - 2 * t);
    const toward = Math.sign(HOOK_X - approach.fromX) || Math.sign(fish.speed);
    pond.fish[index] = {
      ...fish,
      x: approach.fromX + (HOOK_X - approach.fromX) * eased,
      depth: approach.fromDepth * (1 - eased),
      speed: toward * Math.abs(fish.speed),
    };
    return { ...phase, elapsed, approach };
  }
  pond.fish.splice(index, 1);
  events.push({ type: "bite" });
  return {
    kind: "nibble",
    elapsed: 0,
    fish: hook(fish),
    autoHookAt: between(context.rng, AUTO_HOOK_MIN_MS, AUTO_HOOK_MAX_MS),
  };
}

function fight(
  state: GameState,
  phase: Extract<Phase, { kind: "fighting" }>,
  dt: number,
  context: StepContext,
  events: GameEvent[],
  pond: Pond,
): Phase {
  const { fish } = phase;
  const elapsed = phase.elapsed + dt;
  const getAway = (reason: LossReason) => {
    returnToPond(pond, fish, context);
    return lose(reason, events);
  };
  if (state.finishing && state.finishingFor >= FINISH_GRACE_MS) return getAway("escaped");

  let { running, spell, spellLength } = phase;
  spell += dt;
  if (spell >= spellLength) {
    running = !running;
    spell = 0;
    spellLength = spellDuration(context.rng, running, fish.strength);
  }

  const reeling =
    state.mode === "active"
      ? state.reeling
      : running
        ? spell < AUTO_REACTION_MS
        : spell >= AUTO_REACTION_MS;
  const reelRate =
    (REEL_RATE / Math.sqrt(fish.strength)) * (state.mode === "passive" ? PASSIVE_REEL_FACTOR : 1);
  let { progress, tension } = phase;
  if (reeling && !running) {
    progress += dt * reelRate;
    tension -= dt * TENSION_DECAY;
  } else if (reeling && running) {
    tension += dt * TENSION_GAIN * fish.strength;
    progress += dt * reelRate * 0.1;
  } else if (running) {
    progress -= dt * RUN_PULL * fish.strength;
    tension -= dt * TENSION_DECAY;
  } else {
    tension -= dt * TENSION_DECAY;
  }
  progress = clamp(progress, 0, 1);
  tension = clamp(tension, 0, 1);

  if (tension >= 1) return getAway("snapped");
  if (fish.legendary && !fish.assisted && progress >= LEGENDARY_ESCAPE_PROGRESS)
    return getAway("too-big");
  if (progress >= 1) {
    events.push({
      type: "caught",
      fish: { speciesId: fish.speciesId, lengthCm: fish.lengthCm, tier: fish.tier },
      mode: fish.assisted ? "active" : "passive",
      mapId: fish.mapId,
    });
    return { kind: "landed", elapsed: 0, fish };
  }
  return { kind: "fighting", elapsed, fish, progress, tension, running, spell, spellLength };
}

function hook({ speciesId, lengthCm, tier, mapId }: PondFish): HookedFish {
  const species = findSpecies(speciesId);
  const rarity = species?.rarity ?? "common";
  // Bigger fish of a species pull a little harder.
  const sizeBonus = { S: 0, M: 0.1, L: 0.2, XL: 0.35 }[tier];
  return {
    speciesId,
    lengthCm,
    tier,
    mapId,
    strength: RARITY_STRENGTH[rarity] + sizeBonus,
    legendary: rarity === "legendary",
    assisted: false,
  };
}

function startFight(fish: HookedFish): Phase {
  // Fights open calm so the first reel always counts.
  return {
    kind: "fighting",
    elapsed: 0,
    fish,
    progress: 0,
    tension: 0,
    running: false,
    spell: 0,
    spellLength: 900,
  };
}

function spellDuration(rng: () => number, running: boolean, strength: number): number {
  return running ? between(rng, 500, 700 + 350 * strength) : between(rng, 1_100, 2_600);
}

function lose(reason: LossReason, events: GameEvent[]): Phase {
  events.push({ type: "lost", reason });
  return { kind: "lost", elapsed: 0, reason };
}

function between(rng: () => number, min: number, max: number): number {
  return min + (max - min) * rng();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Small seedable generator so tests (and replays) are deterministic. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
