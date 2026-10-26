/**
 * Where an agent's time went, moment by moment: every stretch of a turn is
 * waiting on the user, starting up, compacting, running tools, waiting on
 * subagents, writing, thinking, or, when nothing else explains it, the model
 * (response latency and writing tool calls, which providers do not stream).
 */
import type { Activity, Span, SpanKind, Turn } from "./trace.js";

/** Most to least specific: when two overlap, the earlier one names the moment. */
export const PHASES = [
  "waiting",
  "startup",
  "compaction",
  "tools",
  "subagents",
  "writing",
  "thinking",
  "model",
] as const;
export type Phase = (typeof PHASES)[number];
export type PhaseTotals = Record<Phase, number>;

export const PHASE_LABELS: Record<Phase, string> = {
  waiting: "Waiting on you",
  startup: "Starting",
  compaction: "Compaction",
  tools: "Tools",
  subagents: "Subagents",
  writing: "Writing",
  thinking: "Thinking",
  model: "Model",
};

export const PHASE_HINTS: Record<Phase, string> = {
  waiting: "Approvals, questions, and forms the agent waited on you for",
  startup: "Between sending the prompt and the agent starting",
  compaction: "Summarizing the conversation to free context",
  tools: "Commands and tool calls the agent waited on",
  subagents: "Waiting on subagents with nothing else running",
  writing: "Streaming its reply",
  thinking: "Streaming its visible thinking",
  model: "Model time nothing else explains: response latency and writing tool calls",
};

const SPAN_PHASES: Partial<Record<SpanKind, Phase>> = {
  waiting: "waiting",
  startup: "startup",
  compaction: "compaction",
  subagent: "subagents",
  command: "tools",
  tool: "tools",
  read: "tools",
  edit: "tools",
  search: "tools",
  web: "tools",
};

export interface Segment {
  phase: Phase;
  start: number;
  end: number;
}

/** The part of a turn the timing math needs. */
export type TimedTurn = Pick<Turn, "start" | "end" | "status" | "spans" | "activity">;

export function emptyTotals(): PhaseTotals {
  return Object.fromEntries(PHASES.map((phase) => [phase, 0])) as PhaseTotals;
}

/**
 * One agent's time, split into phases. `lane` is a subagent span id, or null
 * for the turn's own agent. Background work runs alongside the agent, so it
 * never takes a moment away from what the agent itself was doing.
 */
export function laneBreakdown(
  turn: TimedTurn,
  lane: string | null,
  now: number,
): { segments: Segment[]; totals: PhaseTotals } {
  const totals = emptyTotals();
  const owner = lane === null ? turn : turn.spans.find((span) => span.id === lane);
  if (!owner) return { segments: [], totals };
  const from = owner.start;
  const to = owner.end ?? Math.max(now, owner.start);
  if (to <= from) return { segments: [], totals };

  const intervals: Array<{ rank: number; start: number; end: number }> = [];
  const add = (phase: Phase, start: number, end: number | null) => {
    const clippedStart = Math.max(start, from);
    const clippedEnd = Math.min(end ?? to, to);
    if (clippedEnd > clippedStart) {
      intervals.push({ rank: PHASES.indexOf(phase), start: clippedStart, end: clippedEnd });
    }
  };
  for (const span of turn.spans) {
    const phase = SPAN_PHASES[span.kind];
    if (span.parentId === lane && !span.background && phase) add(phase, span.start, span.end);
  }
  for (const activity of turn.activity as Activity[]) {
    if (activity.lane === lane) add(activity.kind, activity.start, activity.end);
  }

  // Sweep the edges, keeping a count of each phase in play.
  const edges = intervals.flatMap(({ rank, start, end }) => [
    { at: start, rank, delta: 1 },
    { at: end, rank, delta: -1 },
  ]);
  edges.sort((a, b) => a.at - b.at);
  const counts = Array.from({ length: PHASES.length }, () => 0);
  const modelRank = PHASES.indexOf("model");
  const segments: Segment[] = [];
  let cursor = from;
  let index = 0;
  const emit = (until: number) => {
    if (until <= cursor) return;
    const rank = counts.findIndex((count) => count > 0);
    const phase = PHASES[rank === -1 ? modelRank : rank];
    const last = segments.at(-1);
    if (last && last.phase === phase && last.end === cursor) last.end = until;
    else segments.push({ phase, start: cursor, end: until });
    totals[phase] += until - cursor;
    cursor = until;
  };
  while (index < edges.length) {
    const at = edges[index].at;
    emit(at);
    while (index < edges.length && edges[index].at === at) {
      counts[edges[index].rank] += edges[index].delta;
      index++;
    }
  }
  emit(to);
  return { segments, totals };
}

export interface TurnStats {
  durationMs: number;
  /** The turn's own agent's time by phase. */
  phases: PhaseTotals;
  /** Thinking, writing, and the rest of the model's time together. */
  modelMs: number;
  toolCalls: number;
  subagents: number;
  childThreads: number;
  errors: number;
  /** Sum of the tokens subagents reported, or null when none did. */
  subagentTokens: number | null;
}

const NOT_TOOL_CALLS = new Set<SpanKind>([
  "subagent",
  "thread",
  "waiting",
  "startup",
  "compaction",
  "error",
]);

/**
 * A command or tool call, as opposed to a subagent, a thread, a wait, startup,
 * compaction, or an error marker. Counts, command stats, reports, and exports
 * all go by this one list.
 */
export function isToolCall(span: Pick<Span, "kind">): boolean {
  return !NOT_TOOL_CALLS.has(span.kind);
}

/**
 * Whether a call spent most of its time waiting on the user, like a question
 * tool held open until you answer. Its length says nothing about the tool.
 */
export function waitsOnUser(span: Span, spans: readonly Span[], now: number): boolean {
  if (span.kind === "waiting") return true;
  const end = span.end ?? now;
  const duration = end - span.start;
  if (duration <= 0) return false;
  let waited = 0;
  for (const wait of spans) {
    if (wait.kind !== "waiting") continue;
    waited += Math.max(0, Math.min(end, wait.end ?? now) - Math.max(span.start, wait.start));
  }
  return waited >= duration / 2;
}

export function turnStats(turn: TimedTurn, now: number): TurnStats {
  const end = turn.end ?? Math.max(now, turn.start);
  let toolCalls = 0;
  let subagents = 0;
  let childThreads = 0;
  let errors = turn.status === "failed" ? 1 : 0;
  let subagentTokens: number | null = null;
  for (const span of turn.spans) {
    if (span.kind === "thread") {
      if (span.parentId === null) childThreads++;
      continue;
    }
    // Child threads' own spans, subagents included, count in their own trace.
    if (span.parentId?.startsWith("thread:")) continue;
    if (span.kind === "subagent") {
      subagents++;
      if (span.tokens !== null) subagentTokens = (subagentTokens ?? 0) + span.tokens;
    }
    if (isToolCall(span)) toolCalls++;
    if (span.status === "failed") errors++;
  }
  const { totals } = laneBreakdown(turn, null, now);
  return {
    durationMs: end - turn.start,
    phases: totals,
    modelMs: totals.thinking + totals.writing + totals.model,
    toolCalls,
    subagents,
    childThreads,
    errors,
    subagentTokens,
  };
}
