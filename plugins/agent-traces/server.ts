import {
  cliCommand,
  defineCli,
  defineRpcContract,
  PluginCliError,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PHASES, turnStats } from "./breakdown.js";
import { commandStats, compareTurns, threadTotals } from "./insights.js";
import { parseHeaders, toOtlp } from "./otlp.js";
import { commandsReport, compareReport, turnReport, turnsReport } from "./report.js";
import { turnSnapshot } from "./snapshot.js";
import { createTraceStore, type TraceStore } from "./store.js";
import {
  ACTIVITY_KINDS,
  SPAN_KINDS,
  STATUSES,
  TRACE_CHANNEL,
  TRACE_EVENT_TYPES,
  type Turn,
} from "./trace.js";
import { errorMessage } from "./util.js";

const VERSION = "0.1.0";
const SIGNAL_DEBOUNCE_MS = 750;
const RELEVANT_EVENTS = new Set<string>(TRACE_EVENT_TYPES);
const STALE_HISTORY = ["history-compacted", "history-rewritten", "thread-deleted"];
// Changes to what `store.info` keeps: the title, the parent, and the project with its environment.
const INFO_CHANGES = ["title-changed", "parent-changed", "environment-changed", "thread-deleted"];
const DEFAULT_PROJECT_THREADS = 20;
const PROJECT_SYNC_CONCURRENCY = 4;
const SEND_TIMEOUT_MS = 15_000;
// Thread totals kept for the Traces page; each is a few hundred bytes.
const MAX_CACHED_TOTALS = 1_000;
const MAX_TOTALS_PER_CALL = 10;
// Plugin CLI output must stay under 1 MiB.
const MAX_CLI_EXPORT_BYTES = 900_000;

const threadIdSchema = z.string().min(1).max(200);
const statusSchema = z.enum(STATUSES);
const durationSchema = z.number().nonnegative();
const phaseTotalsSchema = z.object({
  waiting: durationSchema,
  startup: durationSchema,
  compaction: durationSchema,
  tools: durationSchema,
  subagents: durationSchema,
  writing: durationSchema,
  thinking: durationSchema,
  model: durationSchema,
});

const spanSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  kind: z.enum(SPAN_KINDS),
  name: z.string(),
  detail: z.string(),
  start: z.number(),
  end: z.number().nullable(),
  status: statusSchema,
  background: z.boolean(),
  tokens: z.number().nullable(),
  exitCode: z.number().nullable(),
  error: z.string().nullable(),
  launchedBy: z.string().nullable(),
  seq: z.number(),
  endSeq: z.number().nullable(),
  chatSeq: z.number().nullable(),
});

const activitySchema = z.object({
  id: z.string(),
  lane: z.string().nullable(),
  kind: z.enum(ACTIVITY_KINDS),
  start: z.number(),
  end: z.number().nullable(),
});

const turnStatsSchema = z.object({
  durationMs: durationSchema,
  phases: phaseTotalsSchema,
  modelMs: durationSchema,
  toolCalls: z.number().int().nonnegative(),
  subagents: z.number().int().nonnegative(),
  childThreads: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  subagentTokens: z.number().nullable(),
});

const turnSummarySchema = turnStatsSchema.extend({
  id: z.string(),
  index: z.number().int().positive(),
  prompt: z.string(),
  sender: z.string().nullable(),
  start: z.number(),
  end: z.number().nullable(),
  status: statusSchema,
  requestSeq: z.number().nullable(),
  firstSeq: z.number(),
  lastSeq: z.number(),
});

export const traceSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  projectId: z.string().nullable(),
  parentThreadId: z.string().nullable(),
  generatedAt: z.number(),
  turns: z.array(turnSummarySchema),
  /** The requested turn with its spans, or null when none was asked for or it is unknown. */
  focus: z
    .object({
      id: z.string(),
      start: z.number(),
      end: z.number().nullable(),
      status: statusSchema,
      spans: z.array(spanSchema),
      activity: z.array(activitySchema),
    })
    .nullable(),
});

const spanDetailsSchema = z.object({
  output: z.string().nullable(),
  outputTruncated: z.boolean(),
  arguments: z.string().nullable(),
  summary: z.string().nullable(),
  exitCode: z.number().nullable(),
  error: z.string().nullable(),
  files: z.array(z.object({ path: z.string(), kind: z.string() })),
});

const commandStatSchema = z.object({
  signature: z.string(),
  count: z.number().int(),
  totalMs: durationSchema,
  avgMs: durationSchema,
  maxMs: durationSchema,
  failures: z.number().int(),
  threads: z.number().int(),
  slowest: z.object({
    threadId: z.string(),
    turnId: z.string(),
    turnIndex: z.number().int(),
    spanId: z.string(),
    durationMs: durationSchema,
  }),
});

const comparisonSchema = z.object({
  a: turnStatsSchema,
  b: turnStatsSchema,
  phases: z.array(z.object({ phase: z.enum(PHASES), a: durationSchema, b: durationSchema })),
  commands: z.array(
    z.object({
      signature: z.string(),
      a: z.object({ count: z.number().int(), totalMs: durationSchema }),
      b: z.object({ count: z.number().int(), totalMs: durationSchema }),
    }),
  ),
});

const threadTotalsSchema = z.object({
  threadId: z.string(),
  /** Why the thread could not be read, with zero totals. */
  error: z.string().nullable(),
  turns: z.number().int().nonnegative(),
  activeMs: durationSchema,
  phases: phaseTotalsSchema,
  toolCalls: z.number().int().nonnegative(),
  subagents: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  longestTurnMs: durationSchema,
  runningSince: z.number().nullable(),
  lastTurnAt: z.number().nullable(),
});

export const rpcContract = defineRpcContract({
  trace: {
    input: z
      .object({
        threadId: threadIdSchema,
        /** The turn to return spans for. Without it, only turn summaries come back. */
        turnId: z.string().min(1).max(200).optional(),
      })
      .strict(),
    output: traceSchema,
  },
  threadTotals: {
    input: z
      .object({
        threads: z
          .array(
            z.object({
              threadId: threadIdSchema,
              /** Changes whenever the thread does, such as its updatedAt and status. */
              version: z.string().max(200),
            }),
          )
          .min(1)
          .max(MAX_TOTALS_PER_CALL),
      })
      .strict(),
    output: z.object({ generatedAt: z.number(), rows: z.array(threadTotalsSchema) }),
  },
  span: {
    input: z.object({ threadId: threadIdSchema, spanId: z.string().min(1).max(500) }).strict(),
    output: spanDetailsSchema,
  },
  commands: {
    input: z
      .object({
        threadId: threadIdSchema,
        scope: z.enum(["thread", "project"]),
        threads: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
    output: z.object({
      scope: z.enum(["thread", "project"]),
      threads: z.number().int(),
      rows: z.array(commandStatSchema),
    }),
  },
  compare: {
    input: z
      .object({ threadId: threadIdSchema, a: z.string().min(1), b: z.string().min(1) })
      .strict(),
    output: comparisonSchema,
  },
  exportTurn: {
    input: z
      .object({
        threadId: threadIdSchema,
        turnId: z.string().min(1),
        format: z.enum(["otlp", "html"]),
      })
      .strict(),
    output: z.object({ fileName: z.string(), mimeType: z.string(), content: z.string() }),
  },
  sendTurn: {
    input: z.object({ threadId: threadIdSchema, turnId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), status: z.number().nullable(), message: z.string() }),
  },
  exportConfig: {
    input: z.object({}).strict(),
    output: z.object({ endpointConfigured: z.boolean(), autoExport: z.boolean() }),
  },
});

type TraceResult = z.infer<typeof traceSchema>;
type ThreadTotalsRow = z.infer<typeof threadTotalsSchema>;

function summarize(turn: Turn, now: number): TraceResult["turns"][number] {
  const { id, index, prompt, sender, start, end, status, requestSeq, firstSeq, lastSeq } = turn;
  return {
    ...turnStats(turn, now),
    id,
    index,
    prompt,
    sender,
    start,
    end,
    status,
    requestSeq,
    firstSeq,
    lastSeq,
  };
}

/** `latest` and `previous` count from the end; a number is the turn's `#`. */
function pickTurn(turns: readonly Turn[], ref: string | number | undefined): Turn | undefined {
  if (ref === undefined) {
    // An agent asking about "the last turn" usually means the one that finished.
    return [...turns].reverse().find((turn) => turn.end !== null) ?? turns.at(-1);
  }
  if (ref === "latest") return turns.at(-1);
  if (ref === "previous") return turns.at(-2);
  const index = typeof ref === "number" ? ref : Number(ref);
  return turns.find((turn) => turn.index === index);
}

function fileSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "thread"
  );
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]);
      }
    }),
  );
  return results;
}

export default function plugin(bb: BbPluginApi) {
  const store: TraceStore = createTraceStore(bb);
  const settings = bb.settings.define({
    otlpEndpoint: {
      type: "string",
      label: "OTLP/HTTP traces endpoint, such as http://localhost:4318/v1/traces",
      default: "",
      experimental_schema: z
        .string()
        .refine(
          (value) => value === "" || /^https?:\/\/\S+$/.test(value),
          "Use an http:// or https:// URL",
        ),
    },
    otlpHeaders: {
      type: "string",
      label: "OTLP headers, as key=value pairs separated by commas",
      secret: true,
    },
    autoExport: {
      type: "boolean",
      label: "Send every finished turn to the OTLP endpoint",
      default: false,
    },
  });

  const signalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Finished threads' totals by the version the page last saw, so listing them again is free. */
  const totalsCache = new Map<string, { version: string; totals: ThreadTotalsRow }>();
  let disposed = false;

  const signal = (threadId: string) => {
    if (disposed || signalTimers.has(threadId)) return;
    signalTimers.set(
      threadId,
      setTimeout(() => {
        signalTimers.delete(threadId);
        bb.realtime.publish(TRACE_CHANNEL, { threadId });
      }, SIGNAL_DEBOUNCE_MS),
    );
  };

  /**
   * Keeps what the store holds true to the thread: rewritten history and
   * renamed or moved threads are read again, whoever read them first (the
   * panel, the CLI, an agent, or an export). Only threads someone has a trace
   * of are worth signaling, and only when the appended events can change a
   * span. A child thread's changes also refresh the parent, whose turns show it.
   */
  const unsubscribe = bb.sdk.subscribe({
    event: "thread:changed",
    callback: ({ id: threadId, changes, metadata }) => {
      if (!threadId) return;
      const parent = store.parentOf(threadId);
      const watched = store.isWatched(threadId) || (parent !== null && store.isWatched(parent));
      const stale = changes.some((change) => STALE_HISTORY.includes(change));
      if (stale) {
        // Also stops a read already under way from keeping the old history.
        store.forget(threadId);
        totalsCache.delete(threadId);
      }
      if (changes.some((change) => INFO_CHANGES.includes(change))) store.forgetInfo(threadId);
      if (!watched) return;
      const types = metadata?.eventTypes;
      const relevant =
        stale ||
        (changes.includes("events-appended") &&
          (!types || types.some((type) => RELEVANT_EVENTS.has(type))));
      if (!relevant) return;
      signal(threadId);
      if (parent) signal(parent);
    },
  });

  /** A turn with its spawned threads folded in. `peek` keeps nothing it reads in the cache. */
  const turnWithChildren = async (threadId: string, turnId: string, peek = false) => {
    const turns = await (peek ? store.peekTurns(threadId) : store.turns(threadId));
    const turn = turns.find((candidate) => candidate.id === turnId);
    if (!turn) throw new Error(`Thread ${threadId} has no turn ${turnId}`);
    return store.withChildThreads(threadId, turn, Date.now(), { peek });
  };

  const otlpPayload = async (threadId: string, turnIds: readonly string[], peek: boolean) => {
    const thread = await store.info(threadId);
    const turns = await Promise.all(
      turnIds.map((turnId) => turnWithChildren(threadId, turnId, peek)),
    );
    return toOtlp(thread, turns, Date.now(), VERSION);
  };

  const send = async (threadId: string, turnIds: readonly string[], peek = false) => {
    const { otlpEndpoint, otlpHeaders } = await settings.get();
    if (!otlpEndpoint) {
      return {
        ok: false,
        status: null,
        message: "Set the OTLP endpoint in the plugin's settings first.",
      };
    }
    const payload = await otlpPayload(threadId, turnIds, peek);
    try {
      const response = await fetch(otlpEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...parseHeaders(otlpHeaders ?? "") },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (response.ok) {
        const count = turnIds.length;
        return {
          ok: true,
          status: response.status,
          message: `Sent ${count} turn${count === 1 ? "" : "s"}.`,
        };
      }
      const body = (await response.text()).slice(0, 200);
      return {
        ok: false,
        status: response.status,
        message: `The collector answered ${response.status}: ${body}`,
      };
    } catch (cause) {
      return {
        ok: false,
        status: null,
        message: `Could not reach the collector: ${errorMessage(cause)}`,
      };
    }
  };

  /** Sends each turn that finished since the last send, once. */
  const exportFinished = async (threadId: string) => {
    const { otlpEndpoint, autoExport } = await settings.get();
    if (!autoExport || !otlpEndpoint || disposed) return;
    // Every thread that goes idle comes through here; reading it must not push out open traces.
    const finished = (await store.peekTurns(threadId)).filter((turn) => turn.end !== null);
    const key = `otlp-sent:${threadId}`;
    const last = await bb.storage.kv.get<number>(key);
    // Turning it on sends what finishes from now on, not the whole history.
    const pending =
      typeof last === "number" ? finished.filter((turn) => turn.index > last) : finished.slice(-1);
    if (pending.length === 0) return;
    const result = await send(
      threadId,
      pending.map((turn) => turn.id),
      true,
    );
    if (result.ok) await bb.storage.kv.set(key, pending.at(-1)!.index);
    else bb.log.warn(`Could not send the trace of ${threadId}: ${result.message}`);
  };
  // One export at a time per thread, so back-to-back events never send a turn twice.
  const exports = new Map<string, Promise<void>>();
  for (const event of ["thread.idle", "thread.failed"] as const) {
    bb.events.on(event, ({ thread }) => {
      const next = (exports.get(thread.id) ?? Promise.resolve())
        .then(() => exportFinished(thread.id))
        .catch((cause) =>
          bb.log.warn(`Could not send the trace of ${thread.id}: ${errorMessage(cause)}`),
        );
      exports.set(thread.id, next);
      void next.then(() => {
        if (exports.get(thread.id) === next) exports.delete(thread.id);
      });
    });
  }

  const projectStats = async (threadId: string, limit: number) => {
    const { projectId } = await store.info(threadId);
    if (!projectId) throw new Error("This thread has no project.");
    const threadIds = await store.projectThreads(projectId, limit);
    const threads = await mapLimit(threadIds, PROJECT_SYNC_CONCURRENCY, async (id) => ({
      threadId: id,
      turns: await store.peekTurns(id).catch(() => [] as Turn[]),
    }));
    return { threads: threads.length, rows: commandStats(threads, Date.now()) };
  };

  bb.rpc.register(rpcContract, {
    async trace({ threadId, turnId }) {
      let turns: Turn[];
      try {
        turns = await store.turns(threadId);
      } catch (cause) {
        bb.log.warn(`Could not read the history of ${threadId}: ${errorMessage(cause)}`);
        throw cause;
      }
      const thread = await store.info(threadId);
      const spawned = await store.childStarts(threadId);
      const now = Date.now();
      const found = turnId ? turns.find((turn) => turn.id === turnId) : undefined;
      const focused = found ? await store.withChildThreads(threadId, found, now) : undefined;
      return {
        threadId,
        title: thread.title,
        projectId: thread.projectId,
        parentThreadId: thread.parentThreadId,
        generatedAt: now,
        turns: turns.map((turn) => {
          const summary = summarize(turn, now);
          const end = turn.end ?? now;
          // Turn summaries leave child threads' traces unread; count when they started.
          summary.childThreads = spawned.filter((at) => at >= turn.start && at <= end).length;
          return summary;
        }),
        focus: focused
          ? {
              id: focused.id,
              start: focused.start,
              end: focused.end,
              status: focused.status,
              spans: focused.spans,
              activity: focused.activity,
            }
          : null,
      };
    },
    async threadTotals({ threads }) {
      const now = Date.now();
      const rows = await mapLimit(
        threads,
        PROJECT_SYNC_CONCURRENCY,
        async ({ threadId, version }) => {
          const cached = totalsCache.get(threadId);
          // A running thread's totals grow by the second; read what is new instead.
          if (cached?.version === version && cached.totals.runningSince === null) {
            return cached.totals;
          }
          let totals: ThreadTotalsRow;
          try {
            totals = {
              threadId,
              error: null,
              ...threadTotals(await store.peekTurns(threadId), now),
            };
          } catch (cause) {
            return { threadId, error: errorMessage(cause), ...threadTotals([], now) };
          }
          totalsCache.delete(threadId);
          totalsCache.set(threadId, { version, totals });
          while (totalsCache.size > MAX_CACHED_TOTALS) {
            const oldest = totalsCache.keys().next().value;
            if (oldest === undefined) break;
            totalsCache.delete(oldest);
          }
          return totals;
        },
      );
      return { generatedAt: now, rows };
    },
    span: ({ threadId, spanId }) => store.spanDetails(threadId, spanId),
    async commands({ threadId, scope, threads }) {
      if (scope === "project") {
        return { scope, ...(await projectStats(threadId, threads ?? DEFAULT_PROJECT_THREADS)) };
      }
      const turns = await store.turns(threadId);
      return { scope, threads: 1, rows: commandStats([{ threadId, turns }], Date.now()) };
    },
    async compare({ threadId, a, b }) {
      const now = Date.now();
      return compareTurns(
        await turnWithChildren(threadId, a),
        await turnWithChildren(threadId, b),
        now,
      );
    },
    async exportTurn({ threadId, turnId, format }) {
      const thread = await store.info(threadId);
      const turn = await turnWithChildren(threadId, turnId);
      const base = `${fileSlug(thread.title)}-turn-${turn.index}`;
      if (format === "html") {
        return {
          fileName: `${base}.html`,
          mimeType: "text/html",
          content: turnSnapshot(thread, turn, Date.now(), Date.now()),
        };
      }
      return {
        fileName: `${base}.otlp.json`,
        mimeType: "application/json",
        content: JSON.stringify(toOtlp(thread, [turn], Date.now(), VERSION), null, 2),
      };
    },
    sendTurn: ({ threadId, turnId }) => send(threadId, [turnId]),
    async exportConfig() {
      const { otlpEndpoint, autoExport } = await settings.get();
      return { endpointConfigured: otlpEndpoint !== "", autoExport };
    },
  });

  // `bb agent-traces …` for people and agents in a terminal.
  const threadPositional = {
    name: "thread",
    description: "Thread ID; defaults to the thread the command runs in",
  } as const;
  const resolveThread = (given: string | undefined, ctx: { threadId?: string }) => {
    const threadId = given ?? ctx.threadId;
    if (!threadId) {
      throw new PluginCliError("no thread given", {
        code: "thread_required",
        hint: "Pass a thread ID, such as `bb agent-traces show thr_abc123`.",
      });
    }
    return threadId;
  };
  const resolveTurn = (turns: readonly Turn[], ref: string | undefined) => {
    const turn = pickTurn(turns, ref);
    if (!turn) {
      throw new PluginCliError(`no turn ${ref ?? ""}`.trim(), {
        code: "turn_not_found",
        hint: "Run `bb agent-traces turns` to list the thread's turns.",
      });
    }
    return turn;
  };
  const turnOption = {
    type: "string",
    placeholder: "n|latest|previous",
    description: "Turn number, latest, or previous; defaults to the last finished turn",
  } as const;
  const jsonOption = { type: "boolean", description: "Print machine-readable JSON" } as const;

  bb.cli.register(
    defineCli({
      name: "agent-traces",
      summary: "See where an agent's time went: turns, slowest calls, waits, failures, and exports",
      commands: {
        show: cliCommand({
          summary:
            "Explain one turn: time by phase, slowest calls, subagents, child threads, failures",
          positionals: [threadPositional],
          options: {
            turn: turnOption,
            limit: {
              type: "integer",
              min: 1,
              max: 50,
              default: 8,
              description: "How many slowest calls to list (1-50)",
            },
            json: jsonOption,
          },
          async run({ positionals, options }, ctx) {
            const threadId = resolveThread(positionals.thread, ctx);
            const turn = resolveTurn(await store.turns(threadId), options.turn);
            const full = await store.withChildThreads(threadId, turn, Date.now());
            const now = Date.now();
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify({ ...summarize(full, now), spans: full.spans.length }, null, 2)
                : turnReport(full, now, options.limit),
            };
          },
        }),
        turns: cliCommand({
          summary: "List a thread's turns with their length, model share, and calls",
          positionals: [threadPositional],
          options: { json: jsonOption },
          async run({ positionals, options }, ctx) {
            const threadId = resolveThread(positionals.thread, ctx);
            const turns = await store.turns(threadId);
            const now = Date.now();
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify(
                    turns.map((turn) => summarize(turn, now)),
                    null,
                    2,
                  )
                : turnsReport(turns, now),
            };
          },
        }),
        commands: cliCommand({
          summary: "Group calls by what they ran: total, average, slowest, and failures",
          positionals: [threadPositional],
          options: {
            project: {
              type: "boolean",
              description: "Across the project's most recently active threads",
            },
            threads: {
              type: "integer",
              min: 1,
              max: 50,
              default: DEFAULT_PROJECT_THREADS,
              description: "How many threads --project reads (1-50)",
            },
            json: jsonOption,
          },
          async run({ positionals, options }, ctx) {
            const threadId = resolveThread(positionals.thread, ctx);
            const result = options.project
              ? await projectStats(threadId, options.threads)
              : {
                  threads: 1,
                  rows: commandStats(
                    [{ threadId, turns: await store.turns(threadId) }],
                    Date.now(),
                  ),
                };
            const scope = options.project
              ? `the project's ${result.threads} most recent threads`
              : "this thread";
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify(result, null, 2)
                : commandsReport(result.rows, scope),
            };
          },
        }),
        compare: cliCommand({
          summary: "Compare two turns: where the time moved and which calls changed",
          positionals: [
            { name: "a", description: "The earlier turn's number", required: true },
            { name: "b", description: "The later turn's number", required: true },
            threadPositional,
          ],
          options: { json: jsonOption },
          async run({ positionals, options }, ctx) {
            const threadId = resolveThread(positionals.thread, ctx);
            const turns = await store.turns(threadId);
            const a = resolveTurn(turns, positionals.a);
            const b = resolveTurn(turns, positionals.b);
            const now = Date.now();
            const comparison = compareTurns(
              await store.withChildThreads(threadId, a, now),
              await store.withChildThreads(threadId, b, now),
              now,
            );
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify(comparison, null, 2)
                : compareReport(comparison, a, b),
            };
          },
        }),
        export: cliCommand({
          summary:
            "Export a turn as OpenTelemetry (OTLP/JSON) or an HTML snapshot, or send it to the OTLP endpoint",
          positionals: [threadPositional],
          options: {
            turn: turnOption,
            format: {
              type: "enum",
              values: ["otlp", "html"],
              default: "otlp",
              description: "otlp (JSON) or html",
            },
            send: {
              type: "boolean",
              description:
                "Send it to the OTLP endpoint in the plugin's settings instead of printing it",
            },
          },
          async run({ positionals, options }, ctx) {
            const threadId = resolveThread(positionals.thread, ctx);
            const turn = resolveTurn(await store.turns(threadId), options.turn);
            if (options.send) {
              const result = await send(threadId, [turn.id]);
              return result.ok
                ? { exitCode: 0, stdout: result.message }
                : { exitCode: 1, stderr: result.message };
            }
            const full = await store.withChildThreads(threadId, turn, Date.now());
            const content =
              options.format === "html"
                ? turnSnapshot(await store.info(threadId), full, Date.now(), Date.now())
                : JSON.stringify(toOtlp(await store.info(threadId), [full], Date.now(), VERSION));
            if (Buffer.byteLength(content, "utf8") > MAX_CLI_EXPORT_BYTES) {
              throw new PluginCliError("this turn is too large to print", {
                code: "export_too_large",
                hint: "Use --send, or download it from the Trace panel's Export menu.",
              });
            }
            return { exitCode: 0, stdout: content };
          },
        }),
      },
    }),
  );

  // The same answers for agents, without leaving the conversation.
  bb.agents.registerTool({
    name: "agent_traces",
    description:
      "Explain where an agent's time went in a bb thread: one turn's time by phase (tools, subagents, thinking, writing, model, waiting on the user, compaction), its slowest calls, subagents, child threads, and failures; or list turns, group calls by what they ran, or compare two turns.",
    instructions:
      "When asked why a turn was slow or what took the time, call agent_traces instead of guessing from memory.",
    presentation: { label: { pending: "Reading the trace", completed: "Read the trace" } },
    parameters: z.object({
      threadId: z.string().optional().describe("Thread to inspect; defaults to this thread"),
      view: z
        .enum(["turn", "turns", "commands", "compare"])
        .default("turn")
        .describe(
          "turn explains one turn; turns lists them; commands groups calls; compare diffs two turns",
        ),
      turn: z
        .union([z.number().int().positive(), z.enum(["latest", "previous"])])
        .optional()
        .describe("Turn number, latest, or previous; defaults to the last finished turn"),
      compareWith: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("For compare: the other turn's number"),
      scope: z
        .enum(["thread", "project"])
        .default("thread")
        .describe("For commands: this thread or the project's recent threads"),
    }),
    async execute({ threadId: given, view, turn: ref, compareWith, scope }, { threadId: current }) {
      const threadId = given ?? current;
      if (!threadId)
        return { content: [{ type: "text", text: "No thread to inspect." }], isError: true };
      const turns = await store.turns(threadId);
      const now = Date.now();
      if (view === "turns") return turnsReport(turns, now);
      if (view === "commands") {
        if (scope === "project") {
          const result = await projectStats(threadId, DEFAULT_PROJECT_THREADS);
          return commandsReport(
            result.rows.slice(0, 25),
            `the project's ${result.threads} most recent threads`,
          );
        }
        return commandsReport(commandStats([{ threadId, turns }], now, 25), "this thread");
      }
      const turn = pickTurn(turns, ref);
      if (!turn)
        return {
          content: [{ type: "text", text: `No turn ${ref ?? ""} in ${threadId}.` }],
          isError: true,
        };
      if (view === "compare") {
        const other = compareWith ? pickTurn(turns, compareWith) : undefined;
        if (!other)
          return {
            content: [{ type: "text", text: "Pass compareWith, the other turn's number." }],
            isError: true,
          };
        const [a, b] = other.index < turn.index ? [other, turn] : [turn, other];
        const comparison = compareTurns(
          await store.withChildThreads(threadId, a, now),
          await store.withChildThreads(threadId, b, now),
          now,
        );
        return compareReport(comparison, a, b);
      }
      return turnReport(await store.withChildThreads(threadId, turn, now), now);
    },
  });
  bb.agents.configure(() => ({ tools: ["agent_traces"], skills: ["agent-traces"] }));

  bb.onDispose(() => {
    disposed = true;
    unsubscribe();
    for (const timer of signalTimers.values()) clearTimeout(timer);
    signalTimers.clear();
    totalsCache.clear();
    store.clear();
  });
}
