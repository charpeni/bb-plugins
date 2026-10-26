/** Small helpers for reading untyped event data and printing it. */

export type Json = Record<string, unknown>;

export function record(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** One line of at most `max` characters, ending in "…" when cut. */
export function oneLine(value: string, max = 90): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "1 call", "2 calls". */
export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** `part` as a whole percentage of `whole`, or "—" when there is no whole. */
export function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((100 * part) / whole)}%` : "—";
}

/** What the trace says about a thread, beside its events. */
export interface ThreadInfo {
  id: string;
  title: string;
  projectId: string | null;
  providerId: string | null;
  parentThreadId: string | null;
}
