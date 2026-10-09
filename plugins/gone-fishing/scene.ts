// Draws the pond: a side-on pixel-art strip at a low logical resolution that the
// browser scales up with `image-rendering: pixelated`. The scene is an
// illustration with its own palette per time of day, season, and map, not
// themed app chrome.

import { findSpecies, type MapId, type Season, type Species, type TimeOfDay } from "./catalog.js";
import { approachingFish, CAST_MS, HOOK_X, type GameState } from "./game.js";
import { BOATS, DOGS, findOption, HATS, JACKETS, PAINTS, SKINS, type Look } from "./look.js";

/** Logical pixels; the strip is SCENE_HEIGHT * PIXEL_SCALE CSS pixels tall. */
export const SCENE_HEIGHT = 36;
export const PIXEL_SCALE = 2;
const HORIZON = 17;
const BOAT_X = 6;

type BasePalette = {
  sky: readonly [string, string, string];
  glow: string;
  cloud: string | null;
  far: string;
  near: string;
  trees: string;
  water: readonly [string, string];
  shimmer: string;
  shadow: string;
  line: string;
  stars: boolean;
};

type Particles = "petals" | "fireflies" | "leaves" | "snow";

type Palette = BasePalette & {
  /** The strip's water, one color per row from the surface down. */
  waterRows: readonly string[];
  /** Crowns of leafy trees: blossoms, greens, autumn colors, or snow. */
  leaves: readonly string[];
  trunk: string;
  rock: string;
  reed: string;
  snow: boolean;
  particles: Particles | null;
  map: MapId;
};

const PALETTES: Record<TimeOfDay, BasePalette> = {
  dawn: {
    sky: ["#3b4a86", "#c77a8a", "#f4b886"],
    glow: "#ffe0a8",
    cloud: "#f6c7b0",
    far: "#7a6a8a",
    near: "#4a5068",
    trees: "#2e3446",
    water: ["#6a7aa6", "#2e3a66"],
    shimmer: "#f4c896",
    shadow: "#26305a",
    line: "#f2ead8",
    stars: false,
  },
  day: {
    sky: ["#4f93db", "#86bfec", "#c8e6f6"],
    glow: "#fff4b8",
    cloud: "#ffffff",
    far: "#8fb0c8",
    near: "#5b8a5a",
    trees: "#2f5a3a",
    water: ["#4a8cc0", "#22507e"],
    shimmer: "#bfe2f6",
    shadow: "#1c4268",
    line: "#f4f4f4",
    stars: false,
  },
  dusk: {
    sky: ["#2c2f6b", "#a6506e", "#f09a58"],
    glow: "#ffcf70",
    cloud: "#d97f7a",
    far: "#6a4a6a",
    near: "#3a3a52",
    trees: "#24243a",
    water: ["#56508a", "#24224a"],
    shimmer: "#f2a865",
    shadow: "#1c1a3c",
    line: "#efe2d8",
    stars: false,
  },
  night: {
    sky: ["#060b1e", "#0f1838", "#1e2a58"],
    glow: "#e8ecf5",
    cloud: null,
    far: "#1c2648",
    near: "#131b36",
    trees: "#0a1126",
    water: ["#15244a", "#060e24"],
    shimmer: "#5a70b0",
    shadow: "#040a1c",
    line: "#b8c2d8",
    stars: true,
  },
};

/** How much of a season's color shows at each time of day. */
const LIGHT: Record<TimeOfDay, number> = { dawn: 0.6, day: 1, dusk: 0.5, night: 0.22 };

type SeasonColors = {
  far: string;
  near: string;
  trees: string;
  leaves: readonly string[];
  water?: readonly [string, string];
};

const SEASON_COLORS: Record<Season, SeasonColors> = {
  spring: {
    far: "#9fbcd0",
    near: "#7cb565",
    trees: "#3b7444",
    leaves: ["#a6d77f", "#f3b9cb", "#fbeef2"],
  },
  summer: { far: "#8fb0c8", near: "#5b8a5a", trees: "#2f5a3a", leaves: ["#3f8a46", "#57a052"] },
  autumn: {
    far: "#a3a9bb",
    near: "#9a8a4c",
    trees: "#2c4c36",
    leaves: ["#dd7a2e", "#c8452c", "#e9b43c", "#a0602c"],
  },
  winter: {
    far: "#cbd6e6",
    near: "#e9eff5",
    trees: "#28433a",
    leaves: ["#f4f8fc"],
    water: ["#5f86a5", "#2b4b68"],
  },
};

/** River water runs clearer and greener, marsh water murkier. */
const MAP_WATER: Record<MapId, { color: string; amount: number }> = {
  lake: { color: "#4a8cc0", amount: 0 },
  river: { color: "#3f8f9a", amount: 0.35 },
  marsh: { color: "#56704a", amount: 0.5 },
};

function particlesFor(season: Season, timeOfDay: TimeOfDay): Particles | null {
  if (season === "winter") return "snow";
  if (season === "autumn") return "leaves";
  if (season === "spring") return timeOfDay === "night" ? null : "petals";
  return timeOfDay === "dusk" || timeOfDay === "night" ? "fireflies" : null;
}

const paletteCache = new Map<string, Palette>();

/** The palette only depends on these three, so each combination is built once. */
export function paletteFor(timeOfDay: TimeOfDay, map: MapId, season: Season): Palette {
  const key = `${timeOfDay}:${map}:${season}`;
  let palette = paletteCache.get(key);
  if (!palette) {
    palette = buildPalette(timeOfDay, map, season);
    paletteCache.set(key, palette);
  }
  return palette;
}

function buildPalette(timeOfDay: TimeOfDay, map: MapId, season: Season): Palette {
  const base = PALETTES[timeOfDay];
  const colors = SEASON_COLORS[season];
  const light = LIGHT[timeOfDay];
  // At night everything sinks toward the time of day's own dark colors.
  const shade = (color: string, dark: string) => mix(dark, color, light);
  const water = colors.water
    ? ([shade(colors.water[0], base.water[0]), shade(colors.water[1], base.water[1])] as const)
    : base.water;
  const tint = MAP_WATER[map];
  const tintColor = mix(base.water[1], tint.color, light);
  const surface = mix(water[0], tintColor, tint.amount);
  const bottom = mix(water[1], tintColor, tint.amount);
  const depth = SCENE_HEIGHT - HORIZON;
  return {
    ...base,
    waterRows: Array.from({ length: depth }, (_, row) => mix(surface, bottom, row / (depth - 1))),
    far: shade(colors.far, base.far),
    near: shade(colors.near, base.near),
    trees: shade(colors.trees, base.trees),
    leaves: colors.leaves.map((color) => shade(color, base.trees)),
    water: [surface, bottom],
    trunk: shade("#5a3e28", base.trees),
    rock: shade(season === "winter" ? "#c9d0d8" : "#8a8f96", base.far),
    reed: shade(season === "winter" ? "#a89a72" : "#5d7a3a", base.trees),
    snow: season === "winter",
    particles: particlesFor(season, timeOfDay),
    map,
  };
}

const INK: Record<string, string> = {
  P: "#34466e", // trousers
  N: "#2a1a10", // dog nose
  W: "#ffffff",
  X: "#2a1a10",
  R: "#e04848", // bobber top
};

/** The angler below the hat: face, jacket, and trousers. */
const ANGLER_BODY = ["..SSS.", "..SSS.", ".CCCC.", "CCCCCC", ".CCCC.", ".PPPP."];
const DOG = ["....K..", "...GGGN", "K..GGG.", "KGGGG..", ".GGGG.."];
const BARK = [".WWW.", "WWXWW", "WWXWW", "WWWWW", "WWXWW", ".WWW.", "..W.."];

// Facing left; B back, L belly, E eye, T tail.
const SMALL_FISH = [".BBBB.T", "EBBBBTT", ".LLLL.T"];
const LARGE_FISH = ["..BBBBBB..T", ".EBBBBBBBTT", "BLLLLLLLBTT", "..LLLLLL..T"];

const ANGLER_X = BOAT_X + 10;
const ANGLER_TOP = HORIZON - 10;
// The dog rides at the stern, clear of the rod and line.
const DOG_X = BOAT_X + 1;
const DOG_TOP = HORIZON - 7;
const HAND = { x: ANGLER_X + 5, y: ANGLER_TOP + 5 };
/** Approach progress where a biting fish leaves the chat input for the strip. */
const HANDOFF = 0.8;
const ROD_TIP = { x: ANGLER_X + 13, y: 3 };

export type SceneInput = {
  game: GameState;
  look: Look;
  timeOfDay: TimeOfDay;
  season: Season;
  /** Monotonic clock for ambient motion, in ms. */
  now: number;
  reducedMotion: boolean;
};

export class PondScene {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  #background: HTMLCanvasElement | null = null;
  #backgroundKey = "";

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable");
    this.#canvas = canvas;
    this.#context = context;
    canvas.height = SCENE_HEIGHT;
  }

  /** Matches the logical width to the strip's CSS width. */
  resize(cssWidth: number): void {
    const width = Math.max(64, Math.ceil(cssWidth / PIXEL_SCALE));
    if (this.#canvas.width !== width) this.#canvas.width = width;
  }

  draw({ game, look, timeOfDay, season, now, reducedMotion }: SceneInput): void {
    const ctx = this.#context;
    const width = this.#canvas.width;
    const palette = paletteFor(timeOfDay, look.map, season);
    const t = reducedMotion ? 0 : now;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.#backgroundFor(width, palette, timeOfDay, season), 0, 0);
    if (palette.stars) drawStars(ctx, width, t);
    if (palette.cloud) drawClouds(ctx, width, palette.snow ? "#e8ecf2" : palette.cloud, t);
    drawWater(ctx, width, palette, t);
    drawSurface(ctx, width, palette, season, t);

    const bobberX = Math.max(BOAT_X + 30, Math.min(width - 8, Math.round(width * HOOK_X)));
    const phase = game.phase;
    const hasDog = drawCrew(ctx, look);
    drawLine(ctx, HAND.x, HAND.y, ROD_TIP.x, ROD_TIP.y, "#5a3a20");

    switch (phase.kind) {
      case "casting": {
        const progress = Math.min(1, phase.elapsed / CAST_MS);
        const x = Math.round(ROD_TIP.x + (bobberX - ROD_TIP.x) * progress);
        const y = Math.round(
          ROD_TIP.y + (HORIZON - 1 - ROD_TIP.y) * progress - 10 * Math.sin(Math.PI * progress),
        );
        drawSaggingLine(ctx, ROD_TIP, { x, y }, 2, palette.line);
        drawBobber(ctx, x, y);
        break;
      }
      case "waiting": {
        const approach = approachingFish(game);
        if (approach && approach.progress >= HANDOFF - 0.05) {
          // Up from the chat input below, to the hook.
          const rise = (approach.progress - (HANDOFF - 0.05)) / (1.05 - HANDOFF);
          const y = Math.round(SCENE_HEIGHT - (SCENE_HEIGHT - HORIZON - 5) * Math.min(1, rise));
          drawFish(ctx, findSpecies(approach.fish.speciesId), bobberX - 1, y, "left");
        }
        drawHookLine(ctx, bobberX, palette.line);
        drawSaggingLine(ctx, ROD_TIP, { x: bobberX, y: HORIZON - 1 }, 4, palette.line);
        drawBobber(ctx, bobberX, HORIZON - 1 + (Math.sin(t / 700) > 0.6 ? 1 : 0));
        break;
      }
      case "nibble": {
        const tug = reducedMotion ? 0 : Math.floor(phase.elapsed / 160) % 2;
        drawHookLine(ctx, bobberX, palette.line);
        drawFish(ctx, findSpecies(phase.fish.speciesId), bobberX - 1 + tug, HORIZON + 5, "left");
        drawSaggingLine(ctx, ROD_TIP, { x: bobberX, y: HORIZON - 1 + tug }, 3, palette.line);
        drawBobber(ctx, bobberX, HORIZON - 1 + tug * 2);
        if (hasDog) drawSprite(ctx, BARK, DOG_X + 4, DOG_TOP - 8, INK);
        break;
      }
      case "fighting": {
        const species = findSpecies(phase.fish.speciesId);
        // `t` is frozen under reduced motion, so the fish holds still.
        const thrash = phase.running ? Math.round(Math.sin(t / 60)) : 0;
        const fishX = Math.round(bobberX + (BOAT_X + 30 - bobberX) * phase.progress) + thrash;
        const fishY = HORIZON + 4 + (phase.running ? Math.round(Math.sin(t / 90) + 1) : 0);
        drawFish(ctx, species, fishX, fishY, phase.running ? "right" : "left");
        drawLine(
          ctx,
          ROD_TIP.x,
          ROD_TIP.y,
          fishX,
          fishY + 1,
          tensionColor(palette.line, phase.tension),
        );
        if (phase.running) drawSplash(ctx, fishX + 2, t);
        break;
      }
      case "landed": {
        const rise = reducedMotion ? 1 : Math.min(1, phase.elapsed / 500);
        const fishY = Math.round(
          HORIZON + 2 - (HORIZON - 1) * rise + Math.sin(t / 120) * (1 - rise),
        );
        drawLine(ctx, ROD_TIP.x, ROD_TIP.y, ROD_TIP.x + 1, fishY, palette.line);
        drawFish(ctx, findSpecies(phase.fish.speciesId), ROD_TIP.x - 2, fishY, "left");
        if (rise >= 1) drawSparkles(ctx, ROD_TIP.x + 2, fishY + 1, t);
        break;
      }
      case "lost": {
        drawSaggingLine(ctx, ROD_TIP, { x: ROD_TIP.x + 3, y: ROD_TIP.y + 7 }, 1, palette.line);
        drawRipple(ctx, bobberX, phase.elapsed, palette.shimmer);
        break;
      }
      case "docked":
        break;
    }
    drawForeground(ctx, width, palette, t);
    if (palette.particles) drawParticles(ctx, width, palette, t);
  }

  #backgroundFor(
    width: number,
    palette: Palette,
    timeOfDay: TimeOfDay,
    season: Season,
  ): HTMLCanvasElement {
    const key = `${width}:${timeOfDay}:${season}:${palette.map}`;
    if (this.#background && this.#backgroundKey === key) return this.#background;
    const canvas = this.#background ?? document.createElement("canvas");
    canvas.width = width;
    canvas.height = SCENE_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (ctx) paintBackground(ctx, width, palette, timeOfDay);
    this.#background = canvas;
    this.#backgroundKey = key;
    return canvas;
  }
}

export type UnderwaterInput = {
  game: GameState | null;
  map: MapId;
  season: Season;
  timeOfDay: TimeOfDay;
  now: number;
  reducedMotion: boolean;
  /** How full the composer is, 0 (dry) to 1 (flooded). */
  level: number;
  /** The app uses a dark color scheme. */
  dark: boolean;
};

/**
 * The pond seen from below, painted behind the chat input. Everything is
 * translucent so the composer's own text stays readable in both themes.
 */
export class UnderwaterScene {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  #rowsKey = "";
  #rows: readonly string[] = [];

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable");
    this.#canvas = canvas;
    this.#context = context;
  }

  /** Water colors for this many rows; only recomputed while the level or palette changes. */
  #waterRows(palette: Palette, count: number): readonly string[] {
    const key = `${palette.water[0]}:${palette.water[1]}:${count}`;
    if (this.#rowsKey !== key) {
      this.#rowsKey = key;
      this.#rows = Array.from({ length: count }, (_, row) =>
        mix(palette.water[0], palette.water[1], row / Math.max(1, count - 1)),
      );
    }
    return this.#rows;
  }

  resize(cssWidth: number, cssHeight: number): void {
    const width = Math.max(1, Math.ceil(cssWidth / PIXEL_SCALE));
    const height = Math.max(1, Math.ceil(cssHeight / PIXEL_SCALE));
    if (this.#canvas.width !== width) this.#canvas.width = width;
    if (this.#canvas.height !== height) this.#canvas.height = height;
  }

  draw({ game, map, season, timeOfDay, now, reducedMotion, level, dark }: UnderwaterInput): void {
    const ctx = this.#context;
    const { width, height } = this.#canvas;
    const palette = paletteFor(timeOfDay, map, season);
    const t = reducedMotion ? 0 : now;
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, width, height);
    const surface = Math.round(height * (1 - level));
    if (surface >= height) return;

    const [shallow, deep] = dark ? [0.24, 0.4] : [0.15, 0.3];
    const rows = this.#waterRows(palette, height - surface);
    for (let y = surface; y < height; y++) {
      const depth = (y - surface) / Math.max(1, height - surface - 1);
      ctx.globalAlpha = shallow + (deep - shallow) * depth;
      fill(ctx, 0, y, width, 1, rows[y - surface]!);
    }

    // A wavy waterline while the water rises or drains.
    if (level < 1) {
      ctx.globalAlpha = dark ? 0.6 : 0.8;
      for (let x = 0; x < width; x++) {
        const wave = Math.round(Math.sin(x * 0.22 + t / 180) + Math.sin(x * 0.09 - t / 260) * 0.6);
        fill(ctx, x, Math.max(surface, surface + wave), 1, 1, palette.shimmer);
      }
    }

    // Light glints on dark water compete with the text, so keep them faint there.
    ctx.globalAlpha = dark ? 0.12 : 0.4;
    for (let row = surface + 2; row < height; row += 4) {
      const count = Math.max(1, Math.round(width / 50));
      const direction = row % 2 === 0 ? 1 : -1;
      for (let i = 0; i < count; i++) {
        const span = width + 8;
        const drift = (direction * t) / (180 + (row % 7) * 30);
        const x = Math.round((((hash(row * 17 + i) * span + drift) % span) + span) % span) - 4;
        fill(ctx, x, row, 2 + Math.floor(hash(row + i * 5) * 3), 1, palette.shimmer);
      }
    }

    // The pond's fish, in their own colors. The one biting leaves through the
    // top and finishes its trip in the strip above.
    const approach = game ? approachingFish(game) : null;
    for (const fish of game?.fish ?? []) {
      if (approach?.fish.id === fish.id && approach.progress >= HANDOFF) continue;
      const species = findSpecies(fish.speciesId);
      const sprite = spriteFor(species);
      const spriteWidth = sprite[0]!.length;
      const room = Math.max(0, height - surface - sprite.length - 2);
      const bob = fish.depth > 0.05 ? Math.round(Math.sin(t / 700 + fish.id)) : 0;
      const y = surface + 1 + Math.round(fish.depth * room) + bob;
      if (y < surface || y + sprite.length > height) continue;
      const x = Math.round(fish.x * width - spriteWidth / 2);
      ctx.globalAlpha = dark ? 0.45 : 0.35;
      drawFish(ctx, species, x, y, fish.speed < 0 ? "left" : "right");
      // Rare and legendary fish glint, so they are worth watching for.
      const rarity = species?.rarity;
      if (
        (rarity === "rare" || rarity === "legendary") &&
        Math.floor(t / 400 + fish.id) % 3 === 0
      ) {
        ctx.globalAlpha = rarity === "legendary" ? 0.9 : 0.6;
        fill(ctx, x + Math.floor(spriteWidth / 2), y - 1, 1, 1, "#fff2a0");
      }
      const rise = (t / 45 + fish.id * 37) % 40;
      if (rise < y - surface - 1) {
        ctx.globalAlpha = dark ? 0.4 : 0.55;
        const mouth = fish.speed < 0 ? 0 : spriteWidth - 1;
        fill(
          ctx,
          x + mouth + (Math.floor(rise / 6) % 2),
          y - Math.round(rise),
          1,
          1,
          palette.shimmer,
        );
      }
    }
    ctx.globalAlpha = 1;
  }
}

/** Draws one species' sprite for the fish book. */
export function drawFishPortrait(canvas: HTMLCanvasElement, species: Species): void {
  const sprite = spriteFor(species);
  canvas.width = sprite[0]!.length;
  canvas.height = sprite.length;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawFish(ctx, species, 0, 0, "left");
}

function paintBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  palette: Palette,
  timeOfDay: TimeOfDay,
) {
  // Sky in dithered bands.
  for (let y = 0; y < HORIZON; y++) {
    const position = (y / (HORIZON - 1)) * 4;
    const band = Math.floor(position);
    const [from, to] = [skyBand(palette, band), skyBand(palette, band + 1)];
    if (position - band < 0.5) {
      fill(ctx, 0, y, width, 1, from);
    } else {
      fill(ctx, 0, y, width, 1, from);
      for (let x = y % 2; x < width; x += 2) fill(ctx, x, y, 1, 1, to);
    }
  }

  // Sun low at dawn and dusk, high at noon; a moon at night.
  const sun = { dawn: [0.2, 12], day: [0.72, 3], dusk: [0.85, 12], night: [0.78, 3] }[timeOfDay];
  const sunX = Math.round(width * sun[0]!);
  const sunY = sun[1]!;
  fill(ctx, sunX - 1, sunY - 2, 3, 5, palette.glow);
  fill(ctx, sunX - 2, sunY - 1, 5, 3, palette.glow);
  if (timeOfDay === "night") fill(ctx, sunX, sunY - 2, 2, 3, palette.sky[1]);

  if (palette.map === "river") paintRiverBanks(ctx, width, palette);
  else if (palette.map === "marsh") paintMarshBanks(ctx, width, palette);
  else paintLakeShore(ctx, width, palette);
}

/** Pine hills, with a few leafy trees among the pines. */
function paintLakeShore(ctx: CanvasRenderingContext2D, width: number, palette: Palette) {
  for (let x = 0; x < width; x++) {
    const far = Math.round(5 + 2.5 * Math.sin(x * 0.045 + 1.3) + 1.5 * Math.sin(x * 0.12 + 0.4));
    fill(ctx, x, HORIZON - far, 1, far, palette.far);
    const near = Math.round(2 + 1.5 * Math.sin(x * 0.08 + 4) + Math.sin(x * 0.19 + 1));
    fill(ctx, x, HORIZON - near, 1, near, palette.near);
    if (hash(x) < 0.32) {
      const height = 3 + Math.floor(hash(x + 999) * 4);
      if (hash(x + 500) < 0.3) drawLeafyTree(ctx, x, HORIZON - near, height, palette, x);
      else drawPine(ctx, x, HORIZON - near, height, palette);
    }
  }
}

/** Low hills, a rocky bank with boulders, and birches. */
function paintRiverBanks(ctx: CanvasRenderingContext2D, width: number, palette: Palette) {
  for (let x = 0; x < width; x++) {
    const far = Math.round(3 + 1.5 * Math.sin(x * 0.03 + 2) + Math.sin(x * 0.11));
    fill(ctx, x, HORIZON - far, 1, far, palette.far);
    const near = Math.round(1.5 + Math.sin(x * 0.07 + 1) + 0.6 * Math.sin(x * 0.23));
    fill(ctx, x, HORIZON - near, 1, near, palette.near);
  }
  for (let x = 2; x < width; x += 9 + Math.floor(hash(x) * 7)) {
    if (hash(x + 77) < 0.55)
      drawBirch(ctx, x, HORIZON - 2, 5 + Math.floor(hash(x + 3) * 3), palette, x);
    else drawPine(ctx, x, HORIZON - 2, 4 + Math.floor(hash(x + 5) * 3), palette);
  }
  for (let x = 5; x < width; x += 13 + Math.floor(hash(x + 31) * 11)) {
    fill(ctx, x, HORIZON - 2, 4, 2, palette.rock);
    fill(ctx, x + 1, HORIZON - 3, 2, 1, palette.rock);
  }
}

/** A flat horizon with willows; the reeds and lily pads are drawn in front. */
function paintMarshBanks(ctx: CanvasRenderingContext2D, width: number, palette: Palette) {
  for (let x = 0; x < width; x++) {
    const far = Math.round(2 + 0.7 * Math.sin(x * 0.05 + 3));
    fill(ctx, x, HORIZON - far, 1, far, palette.far);
    fill(ctx, x, HORIZON - 1, 1, 1, palette.near);
  }
  for (let x = 3; x < width; x += 7 + Math.floor(hash(x + 13) * 9)) {
    // Willows: a dome with strands drooping at the edges.
    const color = palette.snow ? palette.leaves[0]! : mix(palette.trees, palette.leaves[0]!, 0.35);
    const radius = 2 + Math.floor(hash(x + 41) * 2);
    const bottom = HORIZON - 3;
    for (let row = 0; row <= radius; row++) {
      const half = Math.max(1, Math.round(Math.sqrt(radius * radius - (radius - row) ** 2)));
      fill(ctx, x - half, bottom - radius + row, half * 2 + 1, 1, color);
    }
    fill(ctx, x - radius, bottom + 1, 1, 1, color);
    fill(ctx, x + radius, bottom + 1, 1, 1, color);
    fill(ctx, x, bottom + 1, 1, 2, palette.trunk);
  }
}

function drawPine(
  ctx: CanvasRenderingContext2D,
  x: number,
  base: number,
  height: number,
  palette: Palette,
) {
  const top = base - height;
  for (let row = 0; row < height; row++) {
    const half = Math.floor((row + 1) / 2);
    fill(ctx, x - half, top + row, half * 2 + 1, 1, palette.trees);
  }
  if (palette.snow) {
    fill(ctx, x, top, 1, 1, palette.leaves[0]!);
    fill(ctx, x - 1, top + 2, 3, 1, palette.leaves[0]!);
  }
}

/** A round crown on a short trunk, colored by the season. */
function drawLeafyTree(
  ctx: CanvasRenderingContext2D,
  x: number,
  base: number,
  height: number,
  palette: Palette,
  seed: number,
) {
  const crown = palette.leaves[Math.floor(hash(seed + 7) * palette.leaves.length)]!;
  const top = base - height;
  fill(ctx, x, base - 2, 1, 2, palette.trunk);
  fill(ctx, x - 1, top, 3, 1, crown);
  fill(ctx, x - 2, top + 1, 5, Math.max(1, height - 3), crown);
}

/** White bark with dark marks, and a light crown. */
function drawBirch(
  ctx: CanvasRenderingContext2D,
  x: number,
  base: number,
  height: number,
  palette: Palette,
  seed: number,
) {
  const top = base - height;
  fill(ctx, x, top + 3, 1, height - 3, mix("#e8e6de", palette.far, 0.25));
  fill(ctx, x, base - 2 - (seed % 2), 1, 1, "#2a2a2a");
  const crown = palette.leaves[Math.floor(hash(seed + 11) * palette.leaves.length)]!;
  fill(ctx, x - 1, top, 3, 1, crown);
  fill(ctx, x - 2, top + 1, 5, 2, crown);
  fill(ctx, x - 1, top + 3, 3, 1, crown);
}

function skyBand(palette: Palette, band: number): string {
  const [top, middle, bottom] = palette.sky;
  const bands = [top, mix(top, middle, 0.5), middle, mix(middle, bottom, 0.5), bottom];
  return bands[Math.min(4, Math.max(0, band))]!;
}

function drawStars(ctx: CanvasRenderingContext2D, width: number, t: number) {
  for (let i = 0; i < width / 9; i++) {
    const x = Math.floor(hash(i * 7 + 3) * width);
    const y = Math.floor(hash(i * 13 + 5) * (HORIZON - 7));
    const twinkle = Math.sin(t / 600 + i) > -0.6;
    if (twinkle) fill(ctx, x, y, 1, 1, i % 5 === 0 ? "#fff6c8" : "#c8d2f0");
  }
}

function drawClouds(ctx: CanvasRenderingContext2D, width: number, color: string, t: number) {
  for (let i = 0; i < Math.max(2, Math.round(width / 120)); i++) {
    const span = width + 30;
    const x = Math.round(((hash(i + 40) * span + t / (260 + i * 90)) % span) - 15);
    const y = 2 + Math.floor(hash(i + 60) * 5);
    fill(ctx, x + 2, y, 6, 1, color);
    fill(ctx, x, y + 1, 11, 1, color);
    fill(ctx, x + 1, y + 2, 13, 1, color);
  }
}

function drawWater(ctx: CanvasRenderingContext2D, width: number, palette: Palette, t: number) {
  const depth = SCENE_HEIGHT - HORIZON;
  palette.waterRows.forEach((color, row) => fill(ctx, 0, HORIZON + row, width, 1, color));
  // Drifting glints, denser near the surface. A river carries them all downstream.
  const river = palette.map === "river";
  for (let row = 0; row < depth; row += 2) {
    const count = Math.max(1, Math.round(width / (18 + row * 6)));
    const direction = river || row % 4 === 0 ? 1 : -1;
    // Same pace as the lake, but all one way, so it reads as a gentle current.
    const slowness = river ? 130 + row * 16 : 140 + row * 20;
    for (let i = 0; i < count; i++) {
      const span = width + 8;
      const x =
        Math.round(
          (((hash(row * 31 + i) * span + (direction * t) / slowness) % span) + span) % span,
        ) - 4;
      const length = 2 + Math.floor(hash(row + i * 17) * 3);
      fill(ctx, x, HORIZON + row, length, 1, palette.shimmer);
    }
  }
}

/** The boat, the angler, and the dog, as the player dressed them. Returns whether the dog came. */
function drawCrew(ctx: CanvasRenderingContext2D, look: Look): boolean {
  const boat = findOption(BOATS, look.boat);
  const paint = findOption(PAINTS, look.paint);
  drawSprite(ctx, boat.rows, BOAT_X, HORIZON - 3, { L: paint.trim, D: paint.hull });

  const hat = findOption(HATS, look.hat);
  const [jacket, check] = findOption(JACKETS, look.jacket).colors;
  // A second jacket color makes a check pattern.
  const body = check
    ? ANGLER_BODY.map((row, y) =>
        [...row].map((pixel, x) => (pixel === "C" && (x + y) % 2 === 1 ? "c" : pixel)).join(""),
      )
    : ANGLER_BODY;
  drawSprite(ctx, [...hat.rows, ...body], ANGLER_X, ANGLER_TOP, {
    ...INK,
    ...hat.ink,
    S: findOption(SKINS, look.skin).color,
    C: jacket,
    c: check ?? jacket,
  });

  const dog = findOption(DOGS, look.dog);
  if (dog.none) return false;
  const coat = dog.spots
    ? DOG.map((row, y) =>
        [...row]
          .map((pixel, x) => (pixel === "G" && hash(x * 3 + y * 7) < 0.3 ? "s" : pixel))
          .join(""),
      )
    : DOG;
  drawSprite(ctx, coat, DOG_X, DOG_TOP, {
    ...INK,
    G: dog.body,
    K: dog.dark,
    s: dog.spots ?? dog.body,
  });
  return true;
}

/** Things floating on the water: lily pads, river foam, winter ice. */
function drawSurface(
  ctx: CanvasRenderingContext2D,
  width: number,
  palette: Palette,
  season: Season,
  t: number,
) {
  if (palette.map === "marsh" && !palette.snow) {
    const pad = mix("#58a844", palette.water[0], 0.15);
    const flowering = season === "spring" || season === "summer";
    for (let i = 0; i < width / 26; i++) {
      const x = BOAT_X + 30 + Math.floor(hash(i + 200) * (width - BOAT_X - 34));
      const y = HORIZON + 1 + Math.floor(hash(i + 300) * 4) * 2;
      fill(ctx, x, y, 4, 1, pad);
      if (flowering && hash(i + 400) < 0.4) fill(ctx, x + 1, y - 1, 1, 1, "#f4a8c4");
    }
  }
  if (palette.map === "river") {
    // Foam racing downstream.
    const foam = mix(palette.shimmer, "#ffffff", 0.5);
    for (let i = 0; i < width / 30; i++) {
      const span = width + 10;
      const x = Math.round((hash(i + 600) * span + t / 100) % span) - 5;
      fill(ctx, x, HORIZON + 1 + Math.floor(hash(i + 700) * 6), 3, 1, foam);
    }
  }
  if (palette.snow) {
    for (let i = 0; i < width / 45; i++) {
      const span = width + 12;
      const x = Math.round((hash(i + 800) * span + t / 900) % span) - 6;
      fill(ctx, x, HORIZON, 4 + Math.floor(hash(i + 900) * 4), 1, "#eef4fa");
    }
  }
}

/** Cattails standing in the marsh shallows, in front of everything. */
function drawForeground(ctx: CanvasRenderingContext2D, width: number, palette: Palette, t: number) {
  if (palette.map !== "marsh") return;
  const head = palette.snow ? mix("#6a4424", "#eef4fa", 0.5) : "#6a4424";
  for (const [clump, center] of [Math.round(width * 0.64), width - 8].entries()) {
    for (let j = 0; j < 5; j++) {
      const x = center + j * 2 - 4;
      const height = 15 + Math.floor(hash(center + j) * 7);
      const sway = Math.round(Math.sin(t / 900 + j + clump) * 0.7);
      fill(ctx, x, SCENE_HEIGHT - height, 1, height, palette.reed);
      fill(ctx, x + sway, SCENE_HEIGHT - height - 1, 1, 1, palette.reed);
      if (j % 2 === 0) fill(ctx, x + sway, SCENE_HEIGHT - height - 4, 1, 3, head);
    }
  }
}

function drawParticles(ctx: CanvasRenderingContext2D, width: number, palette: Palette, t: number) {
  const fall = (i: number, speed: number) =>
    (hash(i + 50) * SCENE_HEIGHT + t / speed) % SCENE_HEIGHT;
  switch (palette.particles) {
    case "snow":
      for (let i = 0; i < width / 5; i++) {
        const x = Math.round(hash(i) * width + Math.sin(t / 1_200 + i) * 3);
        fill(ctx, x, Math.floor(fall(i, 70 + hash(i + 90) * 60)), 1, 1, "#f4f8fc");
      }
      break;
    case "leaves":
    case "petals": {
      const colors = palette.particles === "petals" ? palette.leaves.slice(1) : palette.leaves;
      const count = palette.particles === "petals" ? width / 30 : width / 20;
      for (let i = 0; i < count; i++) {
        const span = width + 8;
        const x =
          Math.round((((hash(i + 1) * span - t / (80 + hash(i + 2) * 60)) % span) + span) % span) -
          4;
        const flutter = Math.floor(t / 250 + i) % 2;
        fill(
          ctx,
          x,
          Math.floor(fall(i, 110 + hash(i + 3) * 80)),
          1 + flutter,
          1,
          colors[i % colors.length]!,
        );
      }
      break;
    }
    case "fireflies":
      for (let i = 0; i < width / 30; i++) {
        if (Math.sin(t / 400 + i * 1.7) < 0.3) continue;
        const x = Math.round(hash(i + 3) * width + Math.sin(t / 1_500 + i) * 4);
        const y = Math.round(6 + hash(i + 4) * 12 + Math.sin(t / 1_100 + i * 2) * 2);
        fill(ctx, x, y, 1, 1, "#e8f47a");
      }
      break;
    case null:
      break;
  }
}

function drawHookLine(ctx: CanvasRenderingContext2D, bobberX: number, color: string) {
  fill(ctx, bobberX, HORIZON + 1, 1, 5, withAlpha(color, 0.55));
  fill(ctx, bobberX + 1, HORIZON + 6, 1, 1, "#9aa0a8");
}

function drawBobber(ctx: CanvasRenderingContext2D, x: number, y: number) {
  fill(ctx, x, y - 1, 2, 1, INK.R!);
  fill(ctx, x, y, 2, 1, INK.W!);
}

function drawSplash(ctx: CanvasRenderingContext2D, x: number, now: number) {
  const frame = Math.floor(now / 120) % 3;
  fill(ctx, x - 2 - frame, HORIZON - 1, 1, 1, "#ffffff");
  fill(ctx, x + 2 + frame, HORIZON - 1 - (frame % 2), 1, 1, "#ffffff");
  fill(ctx, x, HORIZON - 2 - frame, 1, 1, "#e8f4ff");
}

function drawSparkles(ctx: CanvasRenderingContext2D, x: number, y: number, now: number) {
  const frame = Math.floor(now / 200) % 2;
  for (const [dx, dy] of frame
    ? [
        [-5, -2],
        [6, 0],
        [1, -4],
      ]
    : [
        [-4, 1],
        [5, -3],
        [0, 3],
      ]) {
    fill(ctx, x + dx!, y + dy!, 1, 1, "#fff2a0");
  }
}

function drawRipple(ctx: CanvasRenderingContext2D, x: number, elapsed: number, color: string) {
  const radius = 1 + Math.floor(elapsed / 250);
  if (radius > 6) return;
  fill(ctx, x - radius, HORIZON, 2, 1, color);
  fill(ctx, x + radius, HORIZON, 2, 1, color);
}

function spriteFor(species: Species | undefined): readonly string[] {
  return species && species.maxCm >= 60 ? LARGE_FISH : SMALL_FISH;
}

function drawFish(
  ctx: CanvasRenderingContext2D,
  species: Species | undefined,
  x: number,
  y: number,
  facing: "left" | "right",
) {
  const [back, belly] = species?.colors ?? ["#808080", "#c0c0c0"];
  const sprite = spriteFor(species);
  drawSprite(ctx, facing === "left" ? sprite : mirror(sprite), x, y, {
    B: back,
    T: back,
    L: belly,
    E: "#101010",
  });
}

function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprite: readonly string[],
  x: number,
  y: number,
  ink: Record<string, string>,
) {
  sprite.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const color = ink[row[dx]!];
      if (color) fill(ctx, x + dx, y + dy, 1, 1, color);
    }
  });
}

function mirror(sprite: readonly string[]): string[] {
  return sprite.map((row) => [...row].reverse().join(""));
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
) {
  // Bresenham, so the line stays one crisp pixel wide.
  let x = Math.round(x0);
  let y = Math.round(y0);
  const tx = Math.round(x1);
  const ty = Math.round(y1);
  const dx = Math.abs(tx - x);
  const dy = -Math.abs(ty - y);
  const sx = x < tx ? 1 : -1;
  const sy = y < ty ? 1 : -1;
  let error = dx + dy;
  for (;;) {
    fill(ctx, x, y, 1, 1, color);
    if (x === tx && y === ty) return;
    const doubled = 2 * error;
    if (doubled >= dy) {
      error += dy;
      x += sx;
    }
    if (doubled <= dx) {
      error += dx;
      y += sy;
    }
  }
}

function drawSaggingLine(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  sag: number,
  color: string,
) {
  const steps = Math.max(8, Math.ceil(Math.abs(to.x - from.x) / 2));
  let previous = from;
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    const point = {
      x: from.x + (to.x - from.x) * p,
      y: from.y + (to.y - from.y) * p + sag * 4 * p * (1 - p),
    };
    drawLine(ctx, previous.x, previous.y, point.x, point.y, color);
    previous = point;
  }
}

function tensionColor(base: string, tension: number): string {
  return tension < 0.4 ? base : mix(base, "#ff4040", Math.min(1, (tension - 0.4) / 0.5));
}

function fill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43_758.5453;
  return s - Math.floor(s);
}

/** Blends two hex colors and returns hex, so blends can be blended again. */
function mix(a: string, b: string, amount: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  const channel = (i: number) => Math.round(pa[i]! + (pb[i]! - pa[i]!) * amount);
  return `#${[0, 1, 2].map((i) => channel(i).toString(16).padStart(2, "0")).join("")}`;
}

function withAlpha(color: string, alpha: number): string {
  const [r, g, b] = parseHex(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function parseHex(color: string): [number, number, number] {
  const value = Number.parseInt(color.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
