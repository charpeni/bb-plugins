/**
 * The visible slice of a turn's timeline, as offsets in ms from the turn's
 * start. Pure so zooming and panning stay testable outside React.
 */
export interface TimeWindow {
  from: number;
  to: number;
}

/** The narrowest window zooming can reach. */
export const MIN_WINDOW_MS = 20;
const MAX_TICKS = 6;
const TICK_STEPS_MS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000,
  300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000,
];

export function fullWindow(total: number): TimeWindow {
  return { from: 0, to: Math.max(total, MIN_WINDOW_MS) };
}

export function isFull(window: TimeWindow, total: number): boolean {
  return window.from <= 0 && window.to >= total;
}

/** Keeps a window inside the turn and at least `MIN_WINDOW_MS` wide. */
export function clampWindow(window: TimeWindow, total: number): TimeWindow {
  const full = fullWindow(total);
  const width = Math.min(Math.max(window.to - window.from, MIN_WINDOW_MS), full.to);
  const from = Math.min(Math.max(window.from, 0), full.to - width);
  return { from, to: from + width };
}

/**
 * Scales the window by `factor` (below 1 zooms in) around `anchor`, a 0–1
 * position across the window that stays under the pointer.
 */
export function zoomAt(
  window: TimeWindow,
  total: number,
  anchor: number,
  factor: number,
): TimeWindow {
  const width = window.to - window.from;
  const nextWidth = width * factor;
  const at = window.from + anchor * width;
  const from = at - anchor * nextWidth;
  return clampWindow({ from, to: from + nextWidth }, total);
}

export function panBy(window: TimeWindow, total: number, deltaMs: number): TimeWindow {
  return clampWindow({ from: window.from + deltaMs, to: window.to + deltaMs }, total);
}

/** A window around one span, with room on both sides. */
export function fitRange(start: number, end: number, total: number): TimeWindow {
  const pad = Math.max((end - start) * 0.1, MIN_WINDOW_MS / 2);
  return clampWindow({ from: start - pad, to: end + pad }, total);
}

export function ticksFor(window: TimeWindow): { step: number; ticks: number[] } {
  const width = window.to - window.from;
  const step =
    TICK_STEPS_MS.find((candidate) => width / candidate <= MAX_TICKS) ?? TICK_STEPS_MS.at(-1)!;
  const ticks: number[] = [];
  for (let at = Math.ceil(window.from / step) * step; at < window.to; at += step) ticks.push(at);
  return { step, ticks };
}

/** A tick label, only as precise as the step between ticks needs. */
export function formatTick(ms: number, step: number): string {
  if (ms === 0) return "0s";
  const minutes = Math.floor(ms / 60_000);
  if (step < 1_000) {
    const digits = step >= 100 ? 1 : step >= 10 ? 2 : 3;
    const seconds = ((ms % 60_000) / 1_000).toFixed(digits);
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const wholeMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (wholeMinutes < 60) return seconds ? `${wholeMinutes}m ${seconds}s` : `${wholeMinutes}m`;
  const hours = Math.floor(wholeMinutes / 60);
  const restMinutes = wholeMinutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}
