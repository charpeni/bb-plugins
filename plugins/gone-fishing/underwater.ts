// Floods the chat input while the pond is open: a translucent layer behind the
// editor, found through bb's markup (see composer-dom.ts). It changes nothing
// else, and it does nothing when that markup is not recognized.

import { timeOfDay } from "./catalog.js";
import { findComposerSurface } from "./composer-dom.js";
import type { GameState } from "./game.js";
import { resolveSeason, type Look } from "./look.js";
import { UnderwaterScene } from "./scene.js";

/** Time for the water to rise from empty to full (draining is the same). */
export const FLOOD_MS = 900;
const FRAME_MS = 33;
/** Under reduced motion nothing animates, but resizes and fish leaving still redraw. */
const STILL_FRAME_MS = 500;
const SCHEME_CHECK_MS = 1_000;
const LAYER_SELECTOR = "[data-gone-fishing-underwater]";

export type FloodOptions = {
  getGame: () => GameState | null;
  getLook: () => Look;
  isReducedMotion: () => boolean;
};

/** Moves a water level toward its target at a constant rate. */
export function approach(level: number, target: number, dt: number, durationMs = FLOOD_MS): number {
  const step = dt / durationMs;
  return level < target ? Math.min(target, level + step) : Math.max(target, level - step);
}

/** Smoothstep, so the water slows down as it settles. */
export function easeLevel(level: number): number {
  return level * level * (3 - 2 * level);
}

const floods = new WeakMap<HTMLElement, Flood>();

/**
 * Starts filling the composer next to `from`. Returns a function that drains
 * it, or null when no composer surface can be found.
 */
export function flood(from: Element, options: FloodOptions): (() => void) | null {
  const surface = findComposerSurface(from);
  if (!surface) return null;
  let current = floods.get(surface);
  if (!current) {
    current = new Flood(surface);
    floods.set(surface, current);
  }
  const owner = current;
  owner.fill(options);
  return () => owner.drain();
}

class Flood {
  readonly #surface: HTMLElement;
  readonly #layer: HTMLDivElement;
  readonly #scene: UnderwaterScene;
  #options: FloodOptions | null = null;
  #level = 0;
  #target = 0;
  #frame = 0;
  #lastTick = 0;
  #lastDraw = 0;
  #dark = false;
  #schemeCheckedAt = -Infinity;

  constructor(surface: HTMLElement) {
    this.#surface = surface;
    const layer = document.createElement("div");
    layer.dataset.goneFishingUnderwater = "";
    layer.setAttribute("aria-hidden", "true");
    // Below the editor's content but above the form's own background, inside
    // the stacking context `isolation: isolate` gives the form.
    Object.assign(layer.style, {
      position: "absolute",
      inset: "0",
      zIndex: "-1",
      borderRadius: "inherit",
      overflow: "hidden",
      pointerEvents: "none",
    });
    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, {
      display: "block",
      width: "100%",
      height: "100%",
      imageRendering: "pixelated",
    });
    layer.append(canvas);
    this.#layer = layer;
    this.#scene = new UnderwaterScene(canvas);
  }

  fill(options: FloodOptions): void {
    this.#options = options;
    this.#target = 1;
    if (!this.#layer.isConnected) {
      // The original value lives on the element, not in this instance: after a
      // plugin reload, the old bundle's drain can still be running.
      const surface = this.#surface;
      surface.dataset.goneFishingIsolation ??= surface.style.isolation;
      surface.style.isolation = "isolate";
      surface.append(this.#layer);
    }
    this.#start();
  }

  drain(): void {
    this.#target = 0;
    this.#start();
  }

  #start(): void {
    if (this.#frame !== 0) return;
    this.#lastTick = performance.now();
    this.#frame = requestAnimationFrame(this.#tick);
  }

  #remove(): void {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#layer.remove();
    floods.delete(this.#surface);
    const surface = this.#surface;
    if (
      !surface.querySelector(LAYER_SELECTOR) &&
      surface.dataset.goneFishingIsolation !== undefined
    ) {
      surface.style.isolation = surface.dataset.goneFishingIsolation;
      delete surface.dataset.goneFishingIsolation;
    }
  }

  readonly #tick = (now: number): void => {
    this.#frame = 0;
    if (!this.#surface.isConnected) {
      this.#remove();
      return;
    }
    const options = this.#options;
    const reducedMotion = options?.isReducedMotion() ?? false;
    const dt = now - this.#lastTick;
    this.#lastTick = now;
    this.#level = reducedMotion ? this.#target : approach(this.#level, this.#target, dt);
    if (this.#level === 0 && this.#target === 0) {
      this.#remove();
      return;
    }

    const interval = reducedMotion ? STILL_FRAME_MS : FRAME_MS;
    if (now - this.#lastDraw >= interval && document.visibilityState === "visible") {
      this.#lastDraw = now;
      if (now - this.#schemeCheckedAt >= SCHEME_CHECK_MS) {
        this.#schemeCheckedAt = now;
        this.#dark = getComputedStyle(document.documentElement).colorScheme.includes("dark");
      }
      this.#scene.resize(this.#layer.clientWidth, this.#layer.clientHeight);
      const date = new Date();
      const look = options?.getLook();
      this.#scene.draw({
        game: options?.getGame() ?? null,
        map: look?.map ?? "lake",
        season: look ? resolveSeason(look, date) : "summer",
        timeOfDay: timeOfDay(date),
        now,
        reducedMotion,
        level: easeLevel(this.#level),
        dark: this.#dark,
      });
    }
    this.#frame = requestAnimationFrame(this.#tick);
  };
}
