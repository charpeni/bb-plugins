import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { findSpecies } from "./catalog";
import { DEFAULT_LOOK } from "./look";
import plugin, { catchResultSchema, fishBookSchema, profileSchema } from "./server";

async function loadPlugin(host = createFakePluginHost({ pluginId: "gone-fishing" })) {
  await plugin(host.bb);
  return host;
}

type Host = Awaited<ReturnType<typeof loadPlugin>>;

const walleye = {
  threadId: "thr_1",
  speciesId: "walleye",
  lengthCm: 40,
  mode: "passive",
  mapId: "lake",
};

/** Catches the smallest fish of a species on the player's rod, at Pine Lake by default. */
async function catchOne(host: Host, speciesId: string, mapId = "lake") {
  const lengthCm = findSpecies(speciesId)!.minCm;
  return catchResultSchema.parse(
    await host.harness.callRpc("recordCatch", {
      ...walleye,
      speciesId,
      lengthCm,
      mapId,
      mode: "active",
    }),
  );
}

const issue = (message: string) => ({ issues: [expect.objectContaining({ message })] });

describe("Gone Fishing server", () => {
  it("records catches and flags firsts and personal bests", async () => {
    const host = await loadPlugin();
    const call = async (input: object) =>
      catchResultSchema.parse(await host.harness.callRpc("recordCatch", input));

    expect(await call(walleye)).toEqual({
      tier: "S",
      firstOfSpecies: true,
      personalBest: false,
      unlocked: [],
    });
    expect(await call({ ...walleye, lengthCm: 38 })).toMatchObject({
      firstOfSpecies: false,
      personalBest: false,
    });
    expect(await call({ ...walleye, lengthCm: 69, mode: "active" })).toMatchObject({
      tier: "XL",
      personalBest: true,
    });
    expect(host.harness.realtimeSignals).toHaveLength(3);
    expect(host.harness.realtimeSignals[0]).toEqual({
      channel: "catch",
      payload: { speciesId: "walleye" },
    });
  });

  it("builds the fish book from the catch log", async () => {
    const host = await loadPlugin();
    await host.harness.callRpc("recordCatch", walleye);
    await host.harness.callRpc("recordCatch", { ...walleye, lengthCm: 66 });
    await host.harness.callRpc("recordCatch", { ...walleye, speciesId: "bluegill", lengthCm: 14 });

    const book = fishBookSchema.parse(await host.harness.callRpc("fishBook", null));
    expect(book.totalCatches).toBe(3);
    expect(book.species).toHaveLength(2);
    expect(book.species.find((entry) => entry.id === "walleye")).toMatchObject({
      count: 2,
      bestCm: 66,
      bestTier: "L",
    });
  });

  it("rejects fish the catalog does not allow", async () => {
    const host = await loadPlugin();
    const record = (input: object) => host.harness.callRpc("recordCatch", input);
    await expect(record({ ...walleye, speciesId: "kraken" })).rejects.toMatchObject(
      issue("unknown species"),
    );
    await expect(record({ ...walleye, mapId: "marsh" })).rejects.toMatchObject(
      issue("that species does not live there"),
    );
    await expect(record({ ...walleye, lengthCm: 500 })).rejects.toMatchObject(
      issue("length is outside the species' range"),
    );
    await expect(record({ ...walleye, lengthCm: 40.5 })).rejects.toThrow();
    await expect(record({ ...walleye, mapId: "ocean" })).rejects.toThrow();
    await expect(record({ ...walleye, extra: true })).rejects.toThrow();
    const book = fishBookSchema.parse(await host.harness.callRpc("fishBook", null));
    expect(book.totalCatches).toBe(0);
  });

  it("rejects catches the game could not make", async () => {
    const host = await loadPlugin();
    // Legendary fish only land on the player's own rod.
    await expect(
      host.harness.callRpc("recordCatch", { ...walleye, speciesId: "muskellunge", lengthCm: 100 }),
    ).rejects.toMatchObject(issue("legendary fish only land on the player's rod"));
    // Birch River is still locked for a new player.
    await expect(
      host.harness.callRpc("recordCatch", { ...walleye, mapId: "river" }),
    ).rejects.toThrow(/Birch River is not unlocked yet/);
    const book = fishBookSchema.parse(await host.harness.callRpc("fishBook", null));
    expect(book.totalCatches).toBe(0);
  });

  it("leaves fish that left the catalog out of progress, like the fish book", async () => {
    const host = await loadPlugin();
    await catchOne(host, "bluegill");
    host.bb.storage
      .database()
      .prepare(
        `INSERT INTO catches (species_id, length_cm, tier, mode, map_id, thread_id, caught_at)
         VALUES ('retired-fish', 30, 'XL', 'active', 'lake', 'thr_old', 1)`,
      )
      .run();
    const { stats } = profileSchema.parse(await host.harness.callRpc("profile", null));
    const book = fishBookSchema.parse(await host.harness.callRpc("fishBook", null));
    expect(stats).toMatchObject({ catches: 1, species: 1, xl: 0, catchesByMap: { lake: 1 } });
    expect(book.totalCatches).toBe(stats.catches);
  });

  it("announces what a catch unlocks", async () => {
    const host = await loadPlugin();
    const lakeFish = ["bluegill", "yellow-perch", "pumpkinseed", "rock-bass", "smallmouth-bass"];
    for (const speciesId of lakeFish)
      expect((await catchOne(host, speciesId)).unlocked).toEqual([]);
    expect((await catchOne(host, "walleye")).unlocked).toEqual(["Birch River"]);
    expect(host.harness.realtimeSignals.at(-1)).toEqual({ channel: "profile", payload: {} });

    const legendary = await catchOne(host, "muskellunge");
    expect(legendary.unlocked).toEqual(["Golden (paint)"]);
    const { stats } = profileSchema.parse(await host.harness.callRpc("profile", null));
    expect(stats).toMatchObject({
      catches: 7,
      species: 7,
      legendaries: 1,
      catchesByMap: { lake: 7 },
    });
  });

  it("stores the look, and only with unlocked options", async () => {
    const host = await loadPlugin();
    expect(profileSchema.parse(await host.harness.callRpc("profile", null)).look).toEqual(
      DEFAULT_LOOK,
    );

    const river = { ...DEFAULT_LOOK, map: "river", season: "winter", dog: "black" };
    await expect(host.harness.callRpc("setLook", river)).rejects.toThrow(/Not unlocked yet: map/);
    await expect(
      host.harness.callRpc("setLook", { ...DEFAULT_LOOK, hat: "crown" }),
    ).rejects.toThrow(/hat/);

    for (const speciesId of [
      "bluegill",
      "yellow-perch",
      "pumpkinseed",
      "rock-bass",
      "smallmouth-bass",
      "walleye",
    ]) {
      await catchOne(host, speciesId);
    }
    const saved = profileSchema.parse(await host.harness.callRpc("setLook", river));
    expect(saved.look).toEqual(river);
    expect(host.harness.realtimeSignals.at(-1)).toEqual({ channel: "profile", payload: {} });
    expect(profileSchema.parse(await host.harness.callRpc("profile", null)).look).toEqual(river);
  });
});
