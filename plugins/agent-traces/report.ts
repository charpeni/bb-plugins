/**
 * Plain-text traces for the `bb agent-traces` command and the agent tool:
 * short enough to read in a terminal or a tool result, ordered by what is
 * worth looking at first.
 */
import {
  isToolCall,
  PHASE_LABELS,
  PHASES,
  turnStats,
  waitsOnUser,
  type TurnStats,
} from "./breakdown.js";
import { type CommandStat, type TurnComparison } from "./insights.js";
import { formatDuration, formatTokens, type Span, type Turn } from "./trace.js";
import { oneLine, share } from "./util.js";

function phaseLine(stats: TurnStats): string {
  return PHASES.filter((phase) => stats.phases[phase] >= 500)
    .sort((a, b) => stats.phases[b] - stats.phases[a])
    .map(
      (phase) =>
        `${PHASE_LABELS[phase].toLowerCase()} ${share(stats.phases[phase], stats.durationMs)} (${formatDuration(stats.phases[phase])})`,
    )
    .join(" · ");
}

function spanLabel(span: Span): string {
  return oneLine(span.kind === "command" ? span.detail : `${span.name} ${span.detail}`);
}

export function turnReport(turn: Turn, now: number, limit = 8): string {
  const stats = turnStats(turn, now);
  const byId = new Map(turn.spans.map((span) => [span.id, span]));
  const lines = [
    `Turn #${turn.index} · ${formatDuration(stats.durationMs)} · ${turn.status}`,
    `Prompt: ${turn.prompt ? oneLine(turn.prompt, 120) : "(continued on its own)"}${turn.sender ? ` (sent by ${turn.sender === "bb" ? "bb" : `thread ${turn.sender}`})` : ""}`,
    `Time: ${phaseLine(stats) || "nothing recorded yet"}`,
    `Calls: ${stats.toolCalls} · subagents: ${stats.subagents}${stats.subagentTokens !== null ? ` (${formatTokens(stats.subagentTokens)} tokens)` : ""} · child threads: ${stats.childThreads} · errors: ${stats.errors}`,
  ];
  const durationOf = (span: Span) => (span.end ?? now) - span.start;
  // Calls held open by a question to the user say nothing about the tool; the phases show the wait.
  const calls = turn.spans
    .filter(isToolCall)
    .filter((span) => !waitsOnUser(span, turn.spans, now))
    .sort((a, b) => durationOf(b) - durationOf(a))
    .slice(0, limit);
  if (calls.length > 0) {
    lines.push("", "Slowest:");
    for (const span of calls) {
      const parent = span.parentId ? byId.get(span.parentId) : undefined;
      lines.push(
        `  ${formatDuration(durationOf(span)).padStart(7)}  ${spanLabel(span)}${parent ? `  (in ${oneLine(parent.name, 40)})` : ""}${span.background ? "  (background)" : ""}`,
      );
    }
  }
  const lanes = turn.spans.filter((span) => span.kind === "subagent" || span.kind === "thread");
  if (lanes.length > 0) {
    lines.push("", "Subagents and child threads:");
    for (const span of lanes) {
      const calls = turn.spans.filter((child) => child.parentId === span.id).length;
      lines.push(
        `  ${formatDuration(durationOf(span)).padStart(7)}  ${span.kind === "thread" ? "thread " : ""}${oneLine(span.name, 60)} · ${calls} call${calls === 1 ? "" : "s"}${span.tokens !== null ? ` · ${formatTokens(span.tokens)} tokens` : ""} · ${span.status}`,
      );
    }
  }
  const failures = turn.spans.filter((span) => span.status === "failed");
  if (failures.length > 0) {
    lines.push("", "Failures:");
    for (const span of failures.slice(0, limit)) {
      const why = [span.exitCode !== null ? `exit ${span.exitCode}` : "", span.error ?? ""].filter(
        Boolean,
      );
      lines.push(
        `  ${spanLabel(span)}${why.length > 0 ? ` — ${oneLine(why.join(", "), 120)}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

export function turnsReport(turns: readonly Turn[], now: number): string {
  if (turns.length === 0) return "No turns yet.";
  const lines = ["  #  duration  model  calls  status       prompt"];
  for (const turn of turns) {
    const stats = turnStats(turn, now);
    lines.push(
      `${String(turn.index).padStart(3)}  ${formatDuration(stats.durationMs).padStart(8)}  ${share(stats.modelMs, stats.durationMs).padStart(5)}  ${String(stats.toolCalls).padStart(5)}  ${turn.status.padEnd(11)}  ${turn.prompt ? oneLine(turn.prompt, 70) : "(continued on its own)"}`,
    );
  }
  return lines.join("\n");
}

export function commandsReport(stats: readonly CommandStat[], scope: string): string {
  if (stats.length === 0) return `No calls recorded in ${scope}.`;
  const lines = [
    `Calls in ${scope}, most total time first:`,
    "     total      avg      max  runs  fails  threads  call",
  ];
  for (const row of stats) {
    lines.push(
      `${formatDuration(row.totalMs).padStart(10)}  ${formatDuration(row.avgMs).padStart(7)}  ${formatDuration(row.maxMs).padStart(7)}  ${String(row.count).padStart(4)}  ${String(row.failures).padStart(5)}  ${String(row.threads).padStart(7)}  ${oneLine(row.signature, 60)}`,
    );
  }
  return lines.join("\n");
}

function delta(a: number, b: number): string {
  const difference = b - a;
  if (Math.abs(difference) < 500) return "same";
  return `${difference > 0 ? "+" : "−"}${formatDuration(Math.abs(difference))}`;
}

export function compareReport(comparison: TurnComparison, a: Turn, b: Turn): string {
  const lines = [
    `Turn #${a.index} → turn #${b.index}: ${formatDuration(comparison.a.durationMs)} → ${formatDuration(comparison.b.durationMs)} (${delta(comparison.a.durationMs, comparison.b.durationMs)})`,
    "",
    "Time by phase:",
  ];
  for (const row of comparison.phases) {
    if (row.a < 500 && row.b < 500) continue;
    lines.push(
      `  ${PHASE_LABELS[row.phase].padEnd(15)} ${formatDuration(row.a).padStart(8)} → ${formatDuration(row.b).padStart(8)}  ${delta(row.a, row.b)}`,
    );
  }
  const changed = comparison.commands.filter(
    (row) => Math.abs(row.b.totalMs - row.a.totalMs) >= 500 || row.a.count !== row.b.count,
  );
  if (changed.length > 0) {
    lines.push("", "Calls that changed:");
    for (const row of changed) {
      lines.push(
        `  ${oneLine(row.signature, 40).padEnd(40)} ${String(row.a.count).padStart(3)}× ${formatDuration(row.a.totalMs).padStart(7)} → ${String(row.b.count).padStart(3)}× ${formatDuration(row.b.totalMs).padStart(7)}  ${delta(row.a.totalMs, row.b.totalMs)}`,
      );
    }
  }
  return lines.join("\n");
}
