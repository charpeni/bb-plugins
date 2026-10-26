/**
 * The server's view of traces: folds each thread's history once and keeps it
 * current, finds the threads a thread spawned, and reads a span's full output
 * on demand instead of holding every command's output in memory.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { TRACE_EVENT_TYPES, TraceBuilder, type Span, type Turn } from "./trace.js";
import { errorMessage, record, text, type ThreadInfo } from "./util.js";

// The events endpoint refuses pages larger than 100.
const EVENT_PAGE_SIZE = 100;
// Folded traces kept in memory; the least recently read is dropped first.
const MAX_CACHED_THREADS = 48;
const CHILD_LIST_TTL_MS = 15_000;
const MAX_CHILD_THREADS = 12;
const MAX_CHILD_SPANS = 200;
const OUTPUT_TAIL_LINES = 80;
const OUTPUT_TAIL_CHARS = 6_000;
const PREVIEW_CHARS = 2_000;

interface ChildThread {
  id: string;
  title: string;
  providerId: string;
  createdAt: number;
}

export interface SpanDetails {
  /** The command's or tool's output, last lines first kept. */
  output: string | null;
  outputTruncated: boolean;
  /** Tool call arguments, as pretty JSON. */
  arguments: string | null;
  /** A subagent's or task's own summary of what it did. */
  summary: string | null;
  exitCode: number | null;
  error: string | null;
  /** Files an edit changed. */
  files: Array<{ path: string; kind: string }>;
}

function tail(value: string): { text: string; truncated: boolean } {
  const lines = value.replace(/\s+$/, "").split("\n");
  let kept = lines.slice(-OUTPUT_TAIL_LINES).join("\n");
  let truncated = lines.length > OUTPUT_TAIL_LINES;
  if (kept.length > OUTPUT_TAIL_CHARS) {
    kept = kept.slice(-OUTPUT_TAIL_CHARS);
    truncated = true;
  }
  return { text: kept, truncated };
}

function preview(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return raw.length > PREVIEW_CHARS ? `${raw.slice(0, PREVIEW_CHARS - 1)}…` : raw;
}

export function createTraceStore(bb: BbPluginApi) {
  /** Insertion order doubles as recency: a read moves the thread to the end. */
  const traces = new Map<string, TraceBuilder>();
  /** One fold at a time per thread, so concurrent reads share the same pages. */
  const syncs = new Map<string, Promise<TraceBuilder>>();
  const children = new Map<string, { at: number; rows: ChildThread[] }>();
  /** A child thread to the thread that spawned it, to refresh the parent's trace. */
  const parents = new Map<string, string>();
  const infos = new Map<string, ThreadInfo>();
  /** Bumped by `forget`, so a read that started before it does not keep what it read. */
  const generations = new Map<string, number>();

  const keep = (threadId: string, builder: TraceBuilder) => {
    traces.delete(threadId);
    traces.set(threadId, builder);
    while (traces.size > MAX_CACHED_THREADS) {
      const oldest = traces.keys().next().value;
      if (oldest === undefined) break;
      traces.delete(oldest);
    }
  };

  /** Reads what is new; a trace not kept yet is only kept when `cache` is set. */
  const fold = async (threadId: string, cache: boolean): Promise<TraceBuilder> => {
    for (let attempt = 0; ; attempt++) {
      const generation = generations.get(threadId) ?? 0;
      const cached = traces.get(threadId);
      const builder = cached ?? new TraceBuilder();
      for (;;) {
        const page = await bb.sdk.threads.events.list({
          threadId,
          afterSeq: String(builder.lastSeq),
          limit: String(EVENT_PAGE_SIZE),
          types: [...TRACE_EVENT_TYPES],
        });
        builder.apply(page);
        if (page.length < EVENT_PAGE_SIZE) break;
      }
      // History was rewritten during the read: read it again from the start.
      const current = (generations.get(threadId) ?? 0) === generation;
      if (!current && attempt < 2) continue;
      if (current && (cached || cache)) keep(threadId, builder);
      return builder;
    }
  };

  const sync = (threadId: string, cache = true): Promise<TraceBuilder> => {
    const previous = syncs.get(threadId) ?? Promise.resolve(null);
    const next = previous.catch(() => null).then(() => fold(threadId, cache));
    syncs.set(threadId, next);
    const settle = () => {
      if (syncs.get(threadId) === next) syncs.delete(threadId);
    };
    next.then(settle, settle);
    return next;
  };

  const turns = async (threadId: string): Promise<Turn[]> =>
    (await sync(threadId)).snapshot(Date.now());

  /**
   * A thread's turns for its totals. Listing many threads must not push out
   * the traces someone has open, so a trace not kept already is only kept
   * while the thread is working, which also signals its changes.
   */
  const peekTurns = async (threadId: string): Promise<Turn[]> => {
    const builder = await sync(threadId, false);
    const result = builder.snapshot(Date.now());
    if (result.at(-1)?.end === null && !traces.has(threadId)) keep(threadId, builder);
    return result;
  };

  const info = async (threadId: string): Promise<ThreadInfo> => {
    const cached = infos.get(threadId);
    if (cached) return cached;
    const raw = record(await bb.sdk.threads.get({ threadId }));
    const thread = "thread" in raw ? record(raw.thread) : raw;
    const result: ThreadInfo = {
      id: threadId,
      title: text(thread.title) || text(thread.titleFallback) || "Untitled thread",
      projectId: text(thread.projectId) || null,
      providerId: text(thread.providerId) || null,
      parentThreadId: text(thread.parentThreadId) || null,
    };
    infos.set(threadId, result);
    return result;
  };

  /** Threads this thread spawned, archived and hidden ones included. */
  const childThreads = async (threadId: string): Promise<ChildThread[]> => {
    const cached = children.get(threadId);
    if (cached && Date.now() - cached.at < CHILD_LIST_TTL_MS) return cached.rows;
    const lists = await Promise.all(
      [false, true].map((archived) =>
        bb.sdk.threads.list({ parentThreadId: threadId, includeHidden: true, archived }),
      ),
    );
    const rows = lists.flat().map((row) => {
      const thread = record(row);
      return {
        id: text(thread.id),
        title: text(thread.title) || text(thread.titleFallback) || "Child thread",
        providerId: text(thread.providerId),
        createdAt: typeof thread.createdAt === "number" ? thread.createdAt : 0,
      };
    });
    for (const row of rows) parents.set(row.id, threadId);
    children.set(threadId, { at: Date.now(), rows });
    return rows;
  };

  /**
   * The turn with the threads it spawned folded in as background rows, each
   * holding the spans that child ran while this turn did. Their own trace has
   * the rest. With `peek`, reading them keeps nothing in the cache, as for an
   * export nobody is watching.
   */
  const withChildThreads = async (
    threadId: string,
    turn: Turn,
    now: number,
    { peek = false }: { peek?: boolean } = {},
  ): Promise<Turn> => {
    let spawned: ChildThread[];
    try {
      spawned = await childThreads(threadId);
    } catch (cause) {
      bb.log.warn(`Could not list the threads ${threadId} spawned: ${errorMessage(cause)}`);
      return turn;
    }
    const end = turn.end ?? now;
    const inTurn = spawned
      .filter((child) => child.createdAt >= turn.start && child.createdAt <= end)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, MAX_CHILD_THREADS);
    if (inTurn.length === 0) return turn;
    const read = peek ? peekTurns : turns;
    const childTraces = await Promise.all(inTurn.map((child) => read(child.id).catch(() => null)));
    const extra: Span[] = [];
    for (const [index, child] of inTurn.entries()) {
      const childTurns = childTraces[index];
      if (!childTurns) continue;
      const running = childTurns.some((childTurn) => childTurn.end === null);
      const last = childTurns.at(-1);
      const id = `thread:${child.id}`;
      extra.push({
        id,
        parentId: null,
        kind: "thread",
        name: child.title,
        detail: [child.providerId, `${childTurns.length} turn${childTurns.length === 1 ? "" : "s"}`]
          .filter(Boolean)
          .join(" · "),
        start: child.createdAt,
        end: running ? null : (last?.end ?? child.createdAt),
        status: running
          ? "running"
          : childTurns.some((t) => t.status === "failed")
            ? "failed"
            : "completed",
        background: true,
        tokens: null,
        exitCode: null,
        error: null,
        launchedBy: null,
        seq: 0,
        endSeq: null,
        chatSeq: null,
      });
      let count = 0;
      for (const childTurn of childTurns) {
        for (const span of childTurn.spans) {
          if (span.start > end || count >= MAX_CHILD_SPANS) continue;
          count++;
          extra.push({
            ...span,
            id: `${id}/${span.id}`,
            parentId: id,
            launchedBy: null,
            chatSeq: null,
          });
        }
      }
    }
    return { ...turn, spans: [...turn.spans, ...extra] };
  };

  /** When each spawned thread started, for counting them per turn without reading their traces. */
  const childStarts = async (threadId: string): Promise<number[]> => {
    try {
      return (await childThreads(threadId)).map((child) => child.createdAt);
    } catch {
      return [];
    }
  };

  /** A span's output and arguments, read from the event that ended it. */
  const spanDetails = async (threadId: string, spanId: string): Promise<SpanDetails> => {
    const nested = /^thread:([^/]+)\/(.+)$/.exec(spanId);
    if (nested) return spanDetails(nested[1], nested[2]);
    const span = (await turns(threadId))
      .flatMap((turn) => turn.spans)
      .find((candidate) => candidate.id === spanId);
    const details: SpanDetails = {
      output: null,
      outputTruncated: false,
      arguments: null,
      summary: null,
      exitCode: span?.exitCode ?? null,
      error: span?.error ?? null,
      files: [],
    };
    if (!span || span.endSeq === null || span.kind === "error" || span.kind === "startup")
      return details;
    const [event] = await bb.sdk.threads.events.list({
      threadId,
      afterSeq: String(span.endSeq - 1),
      limit: "1",
    });
    const item = record(record(event?.data).item);
    const output = text(item.aggregatedOutput) || text(item.output);
    if (output) {
      const kept = tail(output);
      details.output = kept.text;
      details.outputTruncated =
        kept.truncated || record(item.truncation).aggregatedOutput !== undefined;
    } else if (item.result !== undefined) {
      details.output = preview(item.result);
    }
    details.arguments = preview(item.arguments);
    details.summary = text(item.summary) || null;
    details.files = (Array.isArray(item.changes) ? item.changes : []).map((change) => ({
      path: text(record(change).path),
      kind: text(record(change).kind) || "update",
    }));
    return details;
  };

  /** The most recently active threads of a project, for project-wide stats. */
  const projectThreads = async (projectId: string, limit: number): Promise<string[]> => {
    const rows = await bb.sdk.threads.list({ projectId, limit: Math.max(limit * 2, limit) });
    return rows
      .map((row) => record(row))
      .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
      .slice(0, limit)
      .map((row) => text(row.id))
      .filter(Boolean);
  };

  return {
    sync,
    turns,
    peekTurns,
    info,
    withChildThreads,
    childStarts,
    spanDetails,
    projectThreads,
    /** Whether a thread's trace is being kept, so changes to it matter. */
    isWatched: (threadId: string) => traces.has(threadId),
    parentOf: (threadId: string) => parents.get(threadId) ?? null,
    forget: (threadId: string) => {
      traces.delete(threadId);
      generations.set(threadId, (generations.get(threadId) ?? 0) + 1);
    },
    /** Drops a thread's title, project, and parent, after it was renamed or moved. */
    forgetInfo: (threadId: string) => {
      infos.delete(threadId);
    },
    clear: () => {
      traces.clear();
      children.clear();
      parents.clear();
      infos.clear();
      generations.clear();
    },
  };
}

export type TraceStore = ReturnType<typeof createTraceStore>;
