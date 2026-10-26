/**
 * Patterns across turns and threads: which commands take the most time, how
 * often they fail, and how two turns differ, so tuning a test script or a
 * skill shows up as a before-and-after.
 */
import {
  emptyTotals,
  isToolCall,
  PHASES,
  turnStats,
  type Phase,
  type PhaseTotals,
  type TurnStats,
} from "./breakdown.js";
import { basename, commandWords, type Span, type Turn } from "./trace.js";

// Programs whose first argument names what they did: `git diff`, `pnpm test`.
const SUBCOMMAND_PROGRAMS = new Set([
  "git",
  "gh",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "bunx",
  "docker",
  "kubectl",
  "cargo",
  "go",
  "bb",
  "make",
  "uv",
  "pip",
  "pip3",
  "brew",
  "terraform",
  "aws",
  "gcloud",
  "mvn",
  "gradle",
  "dotnet",
  "bundle",
  "poetry",
  "rails",
]);
// Programs that run a script: `node bench.mjs`, `python3 -m pytest`.
const SCRIPT_RUNNERS = new Set([
  "node",
  "python",
  "python3",
  "ruby",
  "bash",
  "sh",
  "zsh",
  "deno",
  "tsx",
  "ts-node",
]);
// Programs that only wrap the real one: `timeout 300 pnpm test`.
const WRAPPERS = new Set([
  "timeout",
  "time",
  "nice",
  "env",
  "sudo",
  "nohup",
  "stdbuf",
  "exec",
  "command",
]);
const SHELLS = new Set(["bash", "sh", "zsh"]);
const RUN_SUBCOMMANDS = new Set(["run", "exec", "x", "dlx"]);
// CLIs whose commands are two words deep: `bb thread wait`, `gh pr view`.
const TWO_LEVEL_PROGRAMS = new Set(["bb", "gh", "gcloud", "aws", "az"]);
const VALUED_OPTIONS: Record<string, Set<string>> = {
  git: new Set(["-C", "-c", "--git-dir", "--work-tree"]),
  pnpm: new Set(["-C", "--dir", "--filter", "-F"]),
  npm: new Set(["--prefix", "-w", "--workspace"]),
  yarn: new Set(["--cwd"]),
  docker: new Set(["-H", "--context"]),
  kubectl: new Set(["-n", "--namespace", "--context"]),
  make: new Set(["-C", "-f"]),
  go: new Set(["-C"]),
};

// Redirections such as `2>&1`, `>out.txt`, or `<input` say nothing about what ran.
const REDIRECTION = /^(\d*[<>]|&>)/;

function signatureOfWords(words: string[], depth = 0): string {
  let rest = words.filter((word) => !REDIRECTION.test(word));
  while (rest.length > 0 && WRAPPERS.has(basename(rest[0]))) {
    rest = rest.slice(1);
    // The wrapper's own options and arguments: `timeout -k 5 300 pnpm test`.
    while (rest.length > 0 && (rest[0].startsWith("-") || /^[\d.]+[smhd]?$/.test(rest[0]))) {
      rest = rest.slice(1);
    }
  }
  const program = rest[0] ? basename(rest[0]) : "";
  if (!program) return "shell";
  const args = rest.slice(1);
  if (SUBCOMMAND_PROGRAMS.has(program)) {
    // Options that take a value, so the value is not read as the subcommand.
    const valued = VALUED_OPTIONS[program] ?? new Set<string>();
    const bare = args.filter(
      (word, index) => !word.startsWith("-") && !valued.has(args[index - 1] ?? ""),
    );
    const [sub, next] = bare;
    if (!sub) return program;
    const twoLevels = RUN_SUBCOMMANDS.has(sub) || TWO_LEVEL_PROGRAMS.has(program);
    return twoLevels && next ? `${program} ${sub} ${next}` : `${program} ${sub}`;
  }
  // `bash -c "pnpm test"` is about what it runs.
  const inline = args.findIndex((word) => /^-[a-z]*c$/.test(word));
  if (SHELLS.has(program) && inline !== -1 && args[inline + 1] && depth < 2) {
    return signatureOfWords(commandWords(args[inline + 1]), depth + 1);
  }
  if (SCRIPT_RUNNERS.has(program)) {
    const moduleIndex = args.indexOf("-m");
    if (moduleIndex !== -1 && args[moduleIndex + 1])
      return `${program} -m ${args[moduleIndex + 1]}`;
    if (args.some((word) => word === "-e" || word === "-c" || word === "--eval"))
      return `${program} -e`;
    const script = args.find((word) => !word.startsWith("-"));
    return script ? `${program} ${basename(script)}` : `${program} (inline)`;
  }
  return program;
}

/** What a span did, grouped so repeated runs of the same thing add up. Null when it is not a call. */
export function signatureOf(span: Span, byId: ReadonlyMap<string, Span>): string | null {
  if (!isToolCall(span)) return null;
  switch (span.kind) {
    case "command": {
      // A command clipped mid-heredoc keeps the program named from its full text.
      const words = commandWords(span.detail);
      return words.length > 0 || !span.name || span.name === "shell"
        ? signatureOfWords(words)
        : span.name;
    }
    case "background": {
      const launcher = span.launchedBy ? byId.get(span.launchedBy) : undefined;
      const source = launcher ? signatureOf(launcher, byId) : null;
      return source ? `${source} (background)` : "background task";
    }
    case "tool":
    case "web":
      return span.name;
    default:
      return span.name || span.kind;
  }
}

export interface CommandStat {
  signature: string;
  count: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  failures: number;
  /** Threads it ran in, for project-wide stats. */
  threads: number;
  /** The slowest run, to open it. */
  slowest: {
    threadId: string;
    turnId: string;
    turnIndex: number;
    spanId: string;
    durationMs: number;
  };
}

interface Accumulator extends Omit<CommandStat, "avgMs" | "threads"> {
  threadIds: Set<string>;
}

function accumulate(
  rows: Map<string, Accumulator>,
  threadId: string,
  turns: readonly Turn[],
  now: number,
): void {
  for (const turn of turns) {
    const byId = new Map(turn.spans.map((span) => [span.id, span]));
    for (const span of turn.spans) {
      // Child threads' spans count in their own thread.
      if (span.parentId?.startsWith("thread:")) continue;
      const signature = signatureOf(span, byId);
      if (!signature) continue;
      const durationMs = Math.max(0, (span.end ?? now) - span.start);
      const row = rows.get(signature) ?? {
        signature,
        count: 0,
        totalMs: 0,
        maxMs: -1,
        failures: 0,
        threadIds: new Set<string>(),
        slowest: { threadId, turnId: turn.id, turnIndex: turn.index, spanId: span.id, durationMs },
      };
      row.count++;
      row.totalMs += durationMs;
      if (span.status === "failed") row.failures++;
      row.threadIds.add(threadId);
      if (durationMs > row.maxMs) {
        row.maxMs = durationMs;
        row.slowest = {
          threadId,
          turnId: turn.id,
          turnIndex: turn.index,
          spanId: span.id,
          durationMs,
        };
      }
      rows.set(signature, row);
    }
  }
}

function finalize(rows: Map<string, Accumulator>, limit: number): CommandStat[] {
  return [...rows.values()]
    .map(({ threadIds, ...row }) => ({
      ...row,
      maxMs: Math.max(0, row.maxMs),
      avgMs: row.count > 0 ? row.totalMs / row.count : 0,
      threads: threadIds.size,
    }))
    .sort((a, b) => b.totalMs - a.totalMs || b.count - a.count)
    .slice(0, limit);
}

/** Calls grouped by what they did, most total time first. */
export function commandStats(
  threads: ReadonlyArray<{ threadId: string; turns: readonly Turn[] }>,
  now: number,
  limit = 50,
): CommandStat[] {
  const rows = new Map<string, Accumulator>();
  for (const { threadId, turns } of threads) accumulate(rows, threadId, turns, now);
  return finalize(rows, limit);
}

export interface ThreadTotals {
  turns: number;
  /** Time the agent spent on its turns, waits included; gaps between turns are not. */
  activeMs: number;
  phases: PhaseTotals;
  toolCalls: number;
  subagents: number;
  errors: number;
  longestTurnMs: number;
  /** When the running turn started, or null when the thread is not working. */
  runningSince: number | null;
  /** When the latest turn started. */
  lastTurnAt: number | null;
}

/** A whole thread in one row, to see which threads the time went to. */
export function threadTotals(turns: readonly Turn[], now: number): ThreadTotals {
  const totals: ThreadTotals = {
    turns: turns.length,
    activeMs: 0,
    phases: emptyTotals(),
    toolCalls: 0,
    subagents: 0,
    errors: 0,
    longestTurnMs: 0,
    runningSince: null,
    lastTurnAt: turns.at(-1)?.start ?? null,
  };
  for (const turn of turns) {
    const stats = turnStats(turn, now);
    totals.activeMs += stats.durationMs;
    totals.longestTurnMs = Math.max(totals.longestTurnMs, stats.durationMs);
    for (const phase of PHASES) totals.phases[phase] += stats.phases[phase];
    totals.toolCalls += stats.toolCalls;
    totals.subagents += stats.subagents;
    totals.errors += stats.errors;
    if (turn.end === null) totals.runningSince = turn.start;
  }
  return totals;
}

export interface TurnComparison {
  a: TurnStats;
  b: TurnStats;
  phases: Array<{ phase: Phase; a: number; b: number }>;
  commands: Array<{
    signature: string;
    a: { count: number; totalMs: number };
    b: { count: number; totalMs: number };
  }>;
}

/** Two turns side by side: where the time moved, and which calls changed. */
export function compareTurns(a: Turn, b: Turn, now: number, limit = 30): TurnComparison {
  const statsA = turnStats(a, now);
  const statsB = turnStats(b, now);
  const byA = commandStats([{ threadId: "", turns: [a] }], now, Infinity);
  const byB = commandStats([{ threadId: "", turns: [b] }], now, Infinity);
  const signatures = new Set([...byA, ...byB].map((row) => row.signature));
  const pick = (rows: CommandStat[], signature: string) => {
    const row = rows.find((candidate) => candidate.signature === signature);
    return { count: row?.count ?? 0, totalMs: row?.totalMs ?? 0 };
  };
  const commands = [...signatures]
    .map((signature) => ({ signature, a: pick(byA, signature), b: pick(byB, signature) }))
    .sort(
      (x, y) =>
        Math.abs(y.b.totalMs - y.a.totalMs) - Math.abs(x.b.totalMs - x.a.totalMs) ||
        x.signature.localeCompare(y.signature),
    )
    .slice(0, limit);
  return {
    a: statsA,
    b: statsB,
    phases: PHASES.map((phase) => ({ phase, a: statsA.phases[phase], b: statsB.phases[phase] })),
    commands,
  };
}
