import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  CATCH_CHANNEL,
  findMap,
  findSpecies,
  isValidLength,
  MAP_IDS,
  mapName,
  SPECIES,
  sizeTier,
  type MapId,
} from "./catalog.js";
import { lockedParts, PROFILE_CHANNEL, sanitizeLook, unlockedRewards, type Look } from "./look.js";
import { meets, type Stats } from "./progress.js";

const tierSchema = z.enum(["S", "M", "L", "XL"]);
const LOOK_KEY = "look";

// The app rolls catches, so the server only accepts ones the catalog allows.
export const catchInputSchema = z
  .object({
    threadId: z.string().min(1).max(200),
    speciesId: z.string().max(64),
    lengthCm: z.number().int(),
    mode: z.enum(["passive", "active"]),
    mapId: z.enum(MAP_IDS),
  })
  .strict()
  .superRefine((input, context) => {
    const species = findSpecies(input.speciesId);
    if (!species) {
      context.addIssue({ code: "custom", message: "unknown species", path: ["speciesId"] });
    } else if (!species.homes.includes(input.mapId)) {
      context.addIssue({
        code: "custom",
        message: "that species does not live there",
        path: ["mapId"],
      });
    } else if (!isValidLength(species, input.lengthCm)) {
      context.addIssue({
        code: "custom",
        message: "length is outside the species' range",
        path: ["lengthCm"],
      });
    } else if (species.rarity === "legendary" && input.mode === "passive") {
      context.addIssue({
        code: "custom",
        message: "legendary fish only land on the player's rod",
        path: ["mode"],
      });
    }
  });

export const catchResultSchema = z.object({
  tier: tierSchema,
  firstOfSpecies: z.boolean(),
  personalBest: z.boolean(),
  /** Maps and cosmetics this catch unlocked. */
  unlocked: z.array(z.string()),
});

export const fishBookSchema = z.object({
  totalCatches: z.number().int(),
  species: z.array(
    z.object({
      id: z.string(),
      count: z.number().int(),
      bestCm: z.number().int(),
      bestTier: tierSchema,
      firstCaughtAt: z.number(),
      lastCaughtAt: z.number(),
    }),
  ),
});

// Option ids are checked against the catalog and the player's unlocks.
export const lookSchema = z
  .object({
    map: z.enum(MAP_IDS),
    season: z.enum(["auto", "spring", "summer", "autumn", "winter"]),
    skin: z.string().max(40),
    hat: z.string().max(40),
    jacket: z.string().max(40),
    boat: z.string().max(40),
    paint: z.string().max(40),
    dog: z.string().max(40),
  })
  .strict();

const statsSchema = z.object({
  catches: z.number().int(),
  species: z.number().int(),
  legendaries: z.number().int(),
  xl: z.number().int(),
  catchesByMap: z.partialRecord(z.enum(MAP_IDS), z.number().int()),
});

export const profileSchema = z.object({ look: lookSchema, stats: statsSchema });

export const rpcContract = defineRpcContract({
  recordCatch: { input: catchInputSchema, output: catchResultSchema },
  fishBook: { input: z.null(), output: fishBookSchema },
  profile: { input: z.null(), output: profileSchema },
  setLook: { input: lookSchema, output: profileSchema },
});

type CatchInput = z.infer<typeof catchInputSchema>;
type CatchResult = z.infer<typeof catchResultSchema>;
type FishBook = z.infer<typeof fishBookSchema>;
type Profile = z.infer<typeof profileSchema>;
type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

/** Append only: bb rejects a changed statement at an existing index. */
export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS catches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    species_id TEXT NOT NULL,
    length_cm INTEGER NOT NULL,
    tier TEXT NOT NULL,
    mode TEXT NOT NULL,
    map_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    caught_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS catches_species ON catches (species_id, length_cm)`,
];

const CATALOG_IDS = SPECIES.map((species) => species.id);
const LEGENDARY_IDS = SPECIES.filter((species) => species.rarity === "legendary").map(
  (species) => species.id,
);
const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(", ");

type SpeciesRow = {
  species_id: string;
  count: number;
  best_cm: number;
  first_caught_at: number;
  last_caught_at: number;
};

/** Only fish still in the catalog count, so progress matches the fish book. */
export function readStats(db: PluginDatabase): Stats {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS catches, COUNT(DISTINCT species_id) AS species,
              COALESCE(SUM(tier = 'XL'), 0) AS xl,
              COALESCE(SUM(species_id IN (${placeholders(LEGENDARY_IDS)})), 0) AS legendaries
       FROM catches WHERE species_id IN (${placeholders(CATALOG_IDS)})`,
    )
    .get(...LEGENDARY_IDS, ...CATALOG_IDS) as Omit<Stats, "catchesByMap">;
  const byMap = db
    .prepare(
      `SELECT map_id, COUNT(*) AS count FROM catches
       WHERE species_id IN (${placeholders(CATALOG_IDS)}) GROUP BY map_id`,
    )
    .all(...CATALOG_IDS) as { map_id: string; count: number }[];
  const catchesByMap: Partial<Record<MapId, number>> = {};
  for (const row of byMap) {
    if ((MAP_IDS as readonly string[]).includes(row.map_id)) {
      catchesByMap[row.map_id as MapId] = row.count;
    }
  }
  return { ...totals, catchesByMap };
}

export function recordCatch(db: PluginDatabase, input: CatchInput, now: number): CatchResult {
  const species = findSpecies(input.speciesId)!;
  const tier = sizeTier(species, input.lengthCm);
  return db.transaction(() => {
    const before = readStats(db);
    // Maps never lock again, so a fish from a map the player has not unlocked is not real.
    if (!meets(findMap(input.mapId)?.unlock, before)) {
      throw new Error(`${mapName(input.mapId)} is not unlocked yet`);
    }
    const unlockedBefore = new Set(unlockedRewards(before));
    const previous = db
      .prepare("SELECT COUNT(*) AS count, MAX(length_cm) AS best FROM catches WHERE species_id = ?")
      .get(species.id) as { count: number; best: number | null };
    db.prepare(
      `INSERT INTO catches (species_id, length_cm, tier, mode, thread_id, caught_at, map_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(species.id, input.lengthCm, tier, input.mode, input.threadId, now, input.mapId);
    return {
      tier,
      firstOfSpecies: previous.count === 0,
      personalBest: previous.best !== null && input.lengthCm > previous.best,
      unlocked: unlockedRewards(readStats(db)).filter((reward) => !unlockedBefore.has(reward)),
    };
  })();
}

export function readFishBook(db: PluginDatabase): FishBook {
  const rows = db
    .prepare(
      `SELECT species_id, COUNT(*) AS count, MAX(length_cm) AS best_cm,
              MIN(caught_at) AS first_caught_at, MAX(caught_at) AS last_caught_at
       FROM catches GROUP BY species_id`,
    )
    .all() as SpeciesRow[];
  const species = rows.flatMap((row) => {
    // Rows for species removed from the catalog stay in the log but leave the book.
    const entry = findSpecies(row.species_id);
    if (!entry) return [];
    return [
      {
        id: row.species_id,
        count: row.count,
        bestCm: row.best_cm,
        bestTier: sizeTier(entry, row.best_cm),
        firstCaughtAt: row.first_caught_at,
        lastCaughtAt: row.last_caught_at,
      },
    ];
  });
  return { totalCatches: species.reduce((sum, entry) => sum + entry.count, 0), species };
}

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  const readProfile = async (): Promise<Profile> => {
    const stats = readStats(db);
    return { look: sanitizeLook(await bb.storage.kv.get<Look>(LOOK_KEY), stats), stats };
  };

  bb.rpc.register(rpcContract, {
    recordCatch: (input) => {
      const result = recordCatch(db, input, Date.now());
      bb.realtime.publish(CATCH_CHANNEL, { speciesId: input.speciesId });
      if (result.unlocked.length > 0) bb.realtime.publish(PROFILE_CHANNEL, {});
      return result;
    },
    fishBook: () => readFishBook(db),
    profile: readProfile,
    setLook: async (look) => {
      const locked = lockedParts(look, readStats(db));
      if (locked.length > 0) throw new Error(`Not unlocked yet: ${locked.join(", ")}`);
      await bb.storage.kv.set(LOOK_KEY, look);
      bb.realtime.publish(PROFILE_CHANNEL, {});
      return readProfile();
    },
  });
}
