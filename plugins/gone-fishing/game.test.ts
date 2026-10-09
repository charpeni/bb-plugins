import { describe, expect, it } from "vitest";
import { findSpecies } from "./catalog";
import {
  ACTIVE_IDLE_MS,
  approachingFish,
  changeMap,
  finish,
  FINISH_GRACE_MS,
  hasFishOn,
  HOOK_X,
  mulberry32,
  newGame,
  NIBBLE_WINDOW_MS,
  POPULATION,
  press,
  release,
  resume,
  step,
  type GameEvent,
  type GameState,
  type HookedFish,
} from "./game";

const TICK = 50;

function run(state: GameState, ms: number, seed = 1, input?: (state: GameState) => GameState) {
  const context = { rng: mulberry32(seed), timeOfDay: "day" as const, mapId: "lake" as const };
  const events: GameEvent[] = [];
  for (let t = 0; t < ms; t += TICK) {
    if (input) state = input(state);
    const result = step(state, TICK, context);
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}

function runUntil(state: GameState, done: (state: GameState) => boolean, seed = 1) {
  const context = { rng: mulberry32(seed), timeOfDay: "day" as const, mapId: "lake" as const };
  for (let t = 0; t < 60_000 && !done(state); t += TICK) state = step(state, TICK, context).state;
  return state;
}

function fighting(fish: Partial<HookedFish> = {}): GameState {
  return {
    ...newGame(),
    phase: {
      kind: "fighting",
      elapsed: 0,
      fish: {
        speciesId: "bluegill",
        lengthCm: 20,
        tier: "M",
        mapId: "lake",
        strength: 1,
        legendary: false,
        assisted: false,
        ...fish,
      },
      progress: 0,
      tension: 0,
      running: false,
      spell: 0,
      spellLength: 900,
    },
  };
}

describe("auto-fishing", () => {
  it("casts, waits, and lands fish by itself", () => {
    const { events } = run(newGame(), 120_000);
    const caught = events.filter((event) => event.type === "caught");
    expect(caught.length).toBeGreaterThanOrEqual(3);
    expect(caught.every((event) => event.type === "caught" && event.mode === "passive")).toBe(true);
  });

  it("never snaps the line, even on the strongest fish", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { events } = run(fighting({ strength: 2.75 }), 60_000, seed);
      expect(events).not.toContainEqual({ type: "lost", reason: "snapped" });
    }
  });

  it("lets a legendary fish get away", () => {
    const { events } = run(
      fighting({ speciesId: "muskellunge", strength: 2.4, legendary: true }),
      60_000,
    );
    expect(events[0]).toEqual({ type: "lost", reason: "too-big" });
  });
});

describe("taking the rod", () => {
  it("hooks a nibbling fish on press, and misses it when too slow", () => {
    const waiting = runUntil(newGame(), (state) => state.phase.kind === "nibble");
    expect(waiting.phase.kind).toBe("nibble");

    const hooked = press(waiting);
    expect(hooked.mode).toBe("active");
    expect(hooked.phase.kind).toBe("fighting");

    const slow = run({ ...waiting, mode: "active" }, NIBBLE_WINDOW_MS + TICK).events;
    expect(slow).toContainEqual({ type: "lost", reason: "missed" });
  });

  it("snaps the line when held through a run", () => {
    let state = press(fighting({ strength: 1.8 }));
    if (state.phase.kind !== "fighting") throw new Error("expected a fight");
    state = { ...state, phase: { ...state.phase, running: true, spellLength: 5_000 } };
    const { events } = run(state, 2_000);
    expect(events).toContainEqual({ type: "lost", reason: "snapped" });
  });

  it("lands a legendary fish when the player reels between runs", () => {
    const start = press(fighting({ speciesId: "lake-sturgeon", strength: 2.75, legendary: true }));
    // A perfect player: reel while calm, let go while the fish runs.
    const player = (state: GameState) => {
      if (state.phase.kind !== "fighting") return state;
      return state.phase.running ? release(state) : { ...state, reeling: true, idle: 0 };
    };
    const { events } = run(start, 60_000, 3, player);
    expect(events[0]).toMatchObject({
      type: "caught",
      mode: "active",
      fish: { speciesId: "lake-sturgeon" },
    });
  });

  it("hands the rod back to auto-fishing after a quiet spell", () => {
    const active = release(press(newGame()));
    expect(run(active, ACTIVE_IDLE_MS - TICK).state.mode).toBe("active");
    expect(run(active, ACTIVE_IDLE_MS + TICK).state.mode).toBe("passive");
  });
});

describe("when the agent stops", () => {
  it("docks right away with nothing on the line", () => {
    const docked = finish(newGame());
    expect(docked.phase.kind).toBe("docked");
    expect(hasFishOn(docked)).toBe(false);
  });

  it("lands the fish on the line before docking", () => {
    const { state, events } = run(finish(fighting()), 30_000);
    expect(events.filter((event) => event.type === "caught")).toHaveLength(1);
    expect(state.phase.kind).toBe("docked");
  });

  it("starts the grace period when the agent stops, not when the fight started", () => {
    // A long fight, then the agent stops: the fish still gets the full grace period.
    const long = fighting();
    if (long.phase.kind !== "fighting") throw new Error("expected a fight");
    const stuck = finish({ ...long, mode: "active", phase: { ...long.phase, elapsed: 25_000 } });
    const keepActive = (state: GameState) => ({ ...state, idle: 0 });
    expect(run(stuck, FINISH_GRACE_MS - TICK, 1, keepActive).events).toEqual([]);
    expect(run(stuck, FINISH_GRACE_MS + TICK, 1, keepActive).events).toContainEqual({
      type: "lost",
      reason: "escaped",
    });
  });

  it("gives a fish on the line a limited grace period", () => {
    // Nobody reels: an active player who walked away keeps the fish forever otherwise.
    const stuck = finish({ ...fighting(), mode: "active" });
    const { events } = run(stuck, FINISH_GRACE_MS + TICK, 1, (state) => ({ ...state, idle: 0 }));
    expect(events).toContainEqual({ type: "lost", reason: "escaped" });
  });

  it("casts again when the agent starts back up", () => {
    expect(resume(finish(newGame())).phase).toEqual({ kind: "casting", elapsed: 0 });
    const fight = finish(fighting());
    expect(resume(fight)).toEqual({ ...fight, finishing: false });
  });
});

describe("the pond's fish", () => {
  it("stocks the pond, and every bite is a fish that was swimming in it", () => {
    expect(run(newGame(), TICK).state.fish).toHaveLength(3);
    for (let seed = 1; seed <= 10; seed++) {
      const context = { rng: mulberry32(seed), timeOfDay: "day" as const, mapId: "lake" as const };
      let state = newGame();
      let bites = 0;
      for (let t = 0; t < 120_000; t += TICK) {
        const before = state;
        state = step(state, TICK, context).state;
        if (before.phase.kind === "waiting" && state.phase.kind === "nibble") {
          const biter = approachingFish(before)!.fish;
          expect(state.phase.fish).toMatchObject({
            speciesId: biter.speciesId,
            lengthCm: biter.lengthCm,
          });
          expect(state.fish.some((fish) => fish.id === biter.id)).toBe(false);
          bites++;
        }
        expect(state.fish.length).toBeLessThanOrEqual(POPULATION + 1);
      }
      expect(bites).toBeGreaterThan(3);
    }
  });

  it("brings the biting fish up to the hook", () => {
    const start = runUntil(newGame(), (state) => approachingFish(state) !== null);
    const near = runUntil(start, (state) => (approachingFish(state)?.progress ?? 1) >= 0.95);
    const { fish } = approachingFish(near)!;
    expect(Math.abs(fish.x - HOOK_X)).toBeLessThan(0.02);
    expect(fish.depth).toBeLessThan(0.05);
  });

  it("refills itself after fish leave", () => {
    const context = { rng: mulberry32(4), timeOfDay: "day" as const, mapId: "lake" as const };
    let state = newGame();
    let full = false;
    for (let t = 0; t < 60_000; t += TICK) {
      state = step(state, TICK, context).state;
      full ||= state.fish.length >= POPULATION;
    }
    expect(full).toBe(true);
  });

  it("puts a fish that gets away back in the pond", () => {
    const nibbling = runUntil(newGame(), (state) => state.phase.kind === "nibble");
    if (nibbling.phase.kind !== "nibble") throw new Error("expected a nibble");
    const { speciesId, lengthCm } = nibbling.phase.fish;
    const matching = (state: GameState) =>
      state.fish.filter((fish) => fish.speciesId === speciesId && fish.lengthCm === lengthCm)
        .length;
    const { state, events } = run({ ...nibbling, mode: "active" }, NIBBLE_WINDOW_MS + TICK);
    expect(events).toContainEqual({ type: "lost", reason: "missed" });
    expect(matching(state)).toBe(matching(nibbling) + 1);
  });

  it("keeps the legendary that auto-fishing could not land", () => {
    const fish = { speciesId: "muskellunge", lengthCm: 120, strength: 2.4, legendary: true };
    const lost = runUntil(fighting(fish), (state) => state.phase.kind === "lost");
    expect(lost.phase).toMatchObject({ reason: "too-big" });
    expect(lost.fish).toContainEqual(
      expect.objectContaining({ speciesId: "muskellunge", lengthCm: 120 }),
    );
  });

  it("keeps its fish across turns, including one on its way to the hook", () => {
    const approaching = runUntil(newGame(), (state) => approachingFish(state) !== null);
    const ids = approaching.fish.map((fish) => fish.id);
    const docked = finish(approaching);
    expect(docked.phase.kind).toBe("docked");
    const resumed = resume(docked);
    expect(resumed.phase).toEqual({ kind: "casting", elapsed: 0 });
    expect(resumed.fish.map((fish) => fish.id)).toEqual(ids);
  });
});

describe("maps", () => {
  it("stocks the pond with the map's own fish", () => {
    const context = { rng: mulberry32(9), timeOfDay: "night" as const, mapId: "marsh" as const };
    let state = newGame();
    for (let t = 0; t < 60_000; t += TICK) {
      state = step(state, TICK, context).state;
      for (const fish of state.fish) {
        expect(findSpecies(fish.speciesId)!.homes).toContain("marsh");
        expect(fish.mapId).toBe("marsh");
      }
    }
  });

  it("moving maps swaps the fish, and a fish on the line counts for its own map", () => {
    const moved = changeMap(run(fighting(), TICK).state);
    expect(moved.fish).toEqual([]);
    expect(moved.phase.kind).toBe("fighting");

    const context = { rng: mulberry32(2), timeOfDay: "day" as const, mapId: "river" as const };
    let state = moved;
    const events: GameEvent[] = [];
    for (let t = 0; t < 30_000 && !events.some((e) => e.type === "caught"); t += TICK) {
      const result = step(state, TICK, context);
      state = result.state;
      events.push(...result.events);
    }
    expect(events.find((event) => event.type === "caught")).toMatchObject({ mapId: "lake" });
    expect(state.fish.every((fish) => fish.mapId === "river")).toBe(true);
  });

  it("drops a fish swimming to the hook when the map changes", () => {
    const approaching = runUntil(newGame(), (state) => approachingFish(state) !== null);
    const moved = changeMap(approaching);
    expect(approachingFish(moved)).toBeNull();
    expect(moved.phase).toMatchObject({ kind: "waiting", approach: null });
  });
});
