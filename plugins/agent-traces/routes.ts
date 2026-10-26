/**
 * What a trace shows, and how the Traces page writes it into its URL, so a
 * turn or a comparison has a link and browser back walks the way it came.
 *
 *   ""                               every thread
 *   <thread>                         the thread's turns
 *   <thread>/commands                its calls, grouped by what they ran
 *   <thread>/turns/<turn>[/<span>]   one turn's waterfall
 *   <thread>/compare/<a>/<b>         two turns side by side
 */
export type Screen =
  | { kind: "turns" }
  | { kind: "commands" }
  | { kind: "compare"; a: string; b: string }
  | { kind: "turn"; turnId: string; spanId?: string };

export type PageRoute = { threadId: null } | { threadId: string; screen: Screen };

export const TRACES_PATH = "traces";

const THREAD_ID = /^[A-Za-z0-9_-]{1,200}$/;

function decode(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Anything it cannot read falls back to the nearest page that makes sense. */
export function parseSubPath(subPath: string): PageRoute {
  const [thread, kind, ...rest] = subPath.split("/").filter(Boolean);
  if (!thread || !THREAD_ID.test(thread)) return { threadId: null };
  const threadId = thread;
  if (kind === "commands") return { threadId, screen: { kind: "commands" } };
  if (kind === "turns") {
    const turnId = decode(rest[0]);
    // A child thread's span id has a slash in it, which may arrive decoded.
    const spanId = decode(rest.slice(1).join("/"));
    if (turnId) {
      return {
        threadId,
        screen: spanId ? { kind: "turn", turnId, spanId } : { kind: "turn", turnId },
      };
    }
  }
  if (kind === "compare") {
    const a = decode(rest[0]);
    const b = decode(rest[1]);
    if (a && b) return { threadId, screen: { kind: "compare", a, b } };
  }
  return { threadId, screen: { kind: "turns" } };
}

export function formatSubPath(threadId: string | null, screen?: Screen): string {
  if (!threadId) return "";
  const thread = encodeURIComponent(threadId);
  switch (screen?.kind) {
    case "commands":
      return `${thread}/commands`;
    case "turn": {
      const turn = `${thread}/turns/${encodeURIComponent(screen.turnId)}`;
      return screen.spanId ? `${turn}/${encodeURIComponent(screen.spanId)}` : turn;
    }
    case "compare":
      return `${thread}/compare/${encodeURIComponent(screen.a)}/${encodeURIComponent(screen.b)}`;
    default:
      return thread;
  }
}
