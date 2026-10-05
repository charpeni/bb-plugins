import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  addDays,
  buildBlocks,
  buildTimesheet,
  CHANGE_CHANNEL,
  DAY_MS,
  dayBoundaries,
  DEFAULT_MERGE_GAP_MINUTES,
  formatHours,
  isMergeGapMinutes,
  MERGE_GAP_MINUTES,
  MINUTE_MS,
  startOfDay,
  startOfWeek,
  type ActivityBlock,
  type MergeGapMinutes,
  type TurnInterval,
} from "./activity.js";

const MAX_RANGE_MS = 62 * DAY_MS;
const THREAD_PAGE_SIZE = 500;
// The events endpoint refuses pages larger than 100.
const EVENT_PAGE_SIZE = 100;
const SYNC_CONCURRENCY = 6;
const FRESH_SYNC_MS = 30_000;
const THREAD_SYNC_DEBOUNCE_MS = 1_500;
const CHANGE_SIGNAL_DEBOUNCE_MS = 1_000;
const RUNNING_STATUSES = new Set(["active", "starting", "stopping"]);
const TURN_EVENT_TYPES = ["turn/started", "turn/completed"] as const;

const mergeGapSchema = z
  .number()
  .int()
  .refine(isMergeGapMinutes, `mergeGapMinutes must be one of ${MERGE_GAP_MINUTES.join(", ")}`);

export const rangeInputSchema = z
  .object({
    from: z.number().int().nonnegative(),
    to: z.number().int().positive(),
    mergeGapMinutes: mergeGapSchema,
  })
  .strict()
  .refine((input) => input.to > input.from, "to must be after from")
  .refine((input) => input.to - input.from <= MAX_RANGE_MS, "range cannot exceed 62 days");

const blockSchema = z.object({
  threadId: z.string(),
  start: z.number(),
  end: z.number(),
  activeMs: z.number().nonnegative(),
  turnCount: z.number().int().positive(),
  ongoing: z.boolean(),
});

export const activitySchema = z.object({
  from: z.number(),
  to: z.number(),
  mergeGapMinutes: z.number().int(),
  generatedAt: z.number(),
  syncedAt: z.number().nullable(),
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
  threads: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      title: z.string(),
      status: z.string(),
      archived: z.boolean(),
      parentThreadId: z.string().nullable(),
    }),
  ),
  blocks: z.array(blockSchema),
});

export const rpcContract = defineRpcContract({
  activity: { input: rangeInputSchema, output: activitySchema },
});

type Activity = z.infer<typeof activitySchema>;
type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;
type Sdk = BbPluginApi["sdk"];
type ThreadSummary = Awaited<ReturnType<Sdk["threads"]["list"]>>[number];
type ThreadMeta = Pick<
  ThreadSummary,
  "id" | "projectId" | "title" | "status" | "archivedAt" | "parentThreadId" | "updatedAt"
>;
type TurnEvent = Awaited<ReturnType<Sdk["threads"]["events"]["list"]>>[number];

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT,
    status TEXT NOT NULL,
    archived_at INTEGER,
    parent_thread_id TEXT,
    updated_at INTEGER NOT NULL,
    synced_updated_at INTEGER,
    last_seq INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS turns (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    PRIMARY KEY (thread_id, turn_id)
  )`,
  `CREATE INDEX IF NOT EXISTS turns_started_at ON turns (started_at)`,
  `CREATE INDEX IF NOT EXISTS turns_thread_started_at ON turns (thread_id, started_at)`,
  `CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  )`,
];

type ThreadRow = {
  id: string;
  project_id: string;
  title: string | null;
  status: string;
  archived_at: number | null;
  parent_thread_id: string | null;
  updated_at: number;
  synced_updated_at: number | null;
  last_seq: number;
};

type TurnRow = { thread_id: string; started_at: number; ended_at: number | null };

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function upsertThread(db: PluginDatabase, thread: ThreadMeta): void {
  db.prepare(
    `INSERT INTO threads (id, project_id, title, status, archived_at, parent_thread_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id,
       title = excluded.title,
       status = excluded.status,
       archived_at = excluded.archived_at,
       parent_thread_id = excluded.parent_thread_id,
       updated_at = MAX(threads.updated_at, excluded.updated_at)`,
  ).run(
    thread.id,
    thread.projectId,
    thread.title,
    thread.status,
    thread.archivedAt,
    thread.parentThreadId,
    thread.updatedAt,
  );
}

function deleteThread(db: PluginDatabase, threadId: string): void {
  db.prepare("DELETE FROM turns WHERE thread_id = ?").run(threadId);
  db.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
}

/** Records turn events and returns whether any calendar data changed. */
export function applyTurnEvents(
  db: PluginDatabase,
  threadId: string,
  events: readonly TurnEvent[],
): boolean {
  let changed = false;
  const start = db.prepare(
    `INSERT INTO turns (thread_id, turn_id, started_at, ended_at) VALUES (?, ?, ?, NULL)
     ON CONFLICT(thread_id, turn_id) DO NOTHING`,
  );
  const complete = db.prepare(
    `INSERT INTO turns (thread_id, turn_id, started_at, ended_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(thread_id, turn_id) DO UPDATE SET ended_at = excluded.ended_at
     WHERE turns.ended_at IS NULL OR turns.ended_at <> excluded.ended_at`,
  );
  const completeLatestOpen = db.prepare(
    `UPDATE turns SET ended_at = ?
      WHERE thread_id = ? AND ended_at IS NULL AND started_at <= ?`,
  );
  db.transaction(() => {
    for (const event of events) {
      const turnId = event.scope.kind === "turn" ? event.scope.turnId : null;
      let changes = 0;
      if (event.type === "turn/started") {
        changes = start.run(threadId, turnId ?? `seq:${event.seq}`, event.createdAt).changes;
      } else if (event.type === "turn/completed") {
        changes = turnId
          ? complete.run(threadId, turnId, event.createdAt, event.createdAt).changes
          : completeLatestOpen.run(event.createdAt, threadId, event.createdAt).changes;
      }
      if (changes > 0) changed = true;
    }
  })();
  return changed;
}

/**
 * Reads the stored turns that overlap `[from, to)`. A turn left open by a
 * thread that is no longer running (a crash, a lost completion event) ends at
 * the thread's last update instead of growing forever.
 */
function readTurns(db: PluginDatabase, from: number, to: number): TurnInterval[] {
  const rows = db
    .prepare(
      `SELECT turns.thread_id, turns.started_at, turns.ended_at,
              threads.status, threads.updated_at,
              (SELECT MIN(next.started_at) FROM turns AS next
                WHERE next.thread_id = turns.thread_id AND next.started_at > turns.started_at
              ) AS next_started_at
         FROM turns JOIN threads ON threads.id = turns.thread_id
        WHERE turns.started_at < ? AND (turns.ended_at IS NULL OR turns.ended_at >= ?)`,
    )
    .all(to, from) as Array<
    TurnRow & { status: string; updated_at: number; next_started_at: number | null }
  >;
  return rows.map((row) => {
    if (row.ended_at !== null) {
      return { threadId: row.thread_id, start: row.started_at, end: row.ended_at };
    }
    if (RUNNING_STATUSES.has(row.status) && row.next_started_at === null) {
      return { threadId: row.thread_id, start: row.started_at, end: null };
    }
    const cap = Math.min(row.next_started_at ?? Infinity, row.updated_at);
    return { threadId: row.thread_id, start: row.started_at, end: Math.max(row.started_at, cap) };
  });
}

function threadTitle(row: Pick<ThreadRow, "id" | "title">): string {
  return row.title?.trim() || `Untitled thread (${row.id})`;
}

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  let fullSync: Promise<void> | null = null;
  const threadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let signalTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const readSyncedAt = (): number | null => {
    const row = db.prepare("SELECT value FROM sync_state WHERE key = 'synced_at'").get() as
      | { value: number }
      | undefined;
    return row?.value ?? null;
  };

  const signalChange = () => {
    if (disposed || signalTimer) return;
    signalTimer = setTimeout(() => {
      signalTimer = null;
      bb.realtime.publish(CHANGE_CHANNEL, { at: Date.now() });
    }, CHANGE_SIGNAL_DEBOUNCE_MS);
  };

  /** Pulls the turn events recorded since the last sync of one thread. */
  const syncThreadEvents = async (thread: ThreadMeta): Promise<boolean> => {
    const row = db.prepare("SELECT last_seq FROM threads WHERE id = ?").get(thread.id) as
      | { last_seq: number }
      | undefined;
    let cursor = row?.last_seq ?? 0;
    let changed = false;
    for (;;) {
      const page = await bb.sdk.threads.events.list({
        threadId: thread.id,
        afterSeq: String(cursor),
        limit: String(EVENT_PAGE_SIZE),
        types: [...TURN_EVENT_TYPES],
      });
      if (page.length > 0) {
        changed = applyTurnEvents(db, thread.id, page) || changed;
        cursor = Math.max(cursor, ...page.map((event) => event.seq));
      }
      if (page.length < EVENT_PAGE_SIZE) break;
    }
    db.prepare(
      `UPDATE threads SET last_seq = MAX(last_seq, ?), synced_updated_at = ? WHERE id = ?`,
    ).run(cursor, thread.updatedAt, thread.id);
    return changed;
  };

  const listThreads = async (): Promise<ThreadSummary[]> => {
    const threads: ThreadSummary[] = [];
    for (const archived of [false, true]) {
      for (let offset = 0; ; offset += THREAD_PAGE_SIZE) {
        const page = await bb.sdk.threads.list({ archived, limit: THREAD_PAGE_SIZE, offset });
        threads.push(...page);
        if (page.length < THREAD_PAGE_SIZE) break;
      }
    }
    return threads;
  };

  const runFullSync = async (): Promise<void> => {
    const startedAt = Date.now();
    const threads = await listThreads();
    const known = new Map(
      (db.prepare("SELECT id, synced_updated_at FROM threads").all() as ThreadRow[]).map((row) => [
        row.id,
        row.synced_updated_at,
      ]),
    );
    const listed = new Set(threads.map((thread) => thread.id));
    let changed = false;

    db.transaction(() => {
      for (const thread of threads) upsertThread(db, thread);
      // Deleted (and newly hidden) threads drop out of the lists.
      for (const id of known.keys()) {
        if (!listed.has(id)) {
          deleteThread(db, id);
          changed = true;
        }
      }
    })();

    const stale = threads.filter(
      (thread) => known.get(thread.id) !== thread.updatedAt || RUNNING_STATUSES.has(thread.status),
    );
    await mapWithConcurrency(stale, SYNC_CONCURRENCY, async (thread) => {
      try {
        changed = (await syncThreadEvents(thread)) || changed;
      } catch (cause) {
        bb.log.warn(`Could not read turn history for ${thread.id}: ${errorMessage(cause)}`);
      }
    });

    db.prepare(
      "INSERT INTO sync_state (key, value) VALUES ('synced_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(startedAt);
    if (stale.length > 0) {
      bb.log.info(`Synced turn history for ${stale.length} of ${threads.length} threads`);
    }
    if (changed) signalChange();
  };

  const syncAll = (): Promise<void> => {
    fullSync ??= runFullSync().finally(() => {
      fullSync = null;
    });
    return fullSync;
  };

  const ensureFresh = async (): Promise<void> => {
    const syncedAt = readSyncedAt();
    if (syncedAt === null || Date.now() - syncedAt > FRESH_SYNC_MS) await syncAll();
  };

  /** Lifecycle events keep the index current between full syncs. */
  const scheduleThreadSync = (thread: ThreadMeta & { visibility: string }) => {
    if (disposed || thread.visibility === "hidden") return;
    upsertThread(db, thread);
    signalChange();
    const pending = threadTimers.get(thread.id);
    if (pending) clearTimeout(pending);
    threadTimers.set(
      thread.id,
      setTimeout(() => {
        threadTimers.delete(thread.id);
        syncThreadEvents(thread).then(
          (changed) => {
            if (changed) signalChange();
          },
          (cause) =>
            bb.log.warn(`Could not read turn history for ${thread.id}: ${errorMessage(cause)}`),
        );
      }, THREAD_SYNC_DEBOUNCE_MS),
    );
  };

  for (const event of [
    "thread.active",
    "thread.idle",
    "thread.failed",
    "thread.archived",
    "thread.unarchived",
  ] as const) {
    bb.events.on(event, ({ thread }) => scheduleThreadSync(thread));
  }
  bb.events.on("thread.deleted", ({ thread }) => {
    deleteThread(db, thread.id);
    signalChange();
  });

  const queryActivity = async (
    from: number,
    to: number,
    mergeGapMinutes: MergeGapMinutes,
  ): Promise<Activity> => {
    await ensureFresh();
    const now = Date.now();
    const blocks = buildBlocks(readTurns(db, from, to), {
      from,
      to,
      mergeGapMs: mergeGapMinutes * MINUTE_MS,
      now,
    });
    const threadIds = [...new Set(blocks.map((block) => block.threadId))];
    const threadRows =
      threadIds.length === 0
        ? []
        : (db
            .prepare(`SELECT * FROM threads WHERE id IN (${threadIds.map(() => "?").join(", ")})`)
            .all(...threadIds) as ThreadRow[]);
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    return {
      from,
      to,
      mergeGapMinutes,
      generatedAt: now,
      syncedAt: readSyncedAt(),
      projects: projects.map((project) => ({ id: project.id, name: project.name })),
      threads: threadRows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        title: threadTitle(row),
        status: row.status,
        archived: row.archived_at !== null,
        parentThreadId: row.parent_thread_id,
      })),
      blocks,
    };
  };

  bb.rpc.register(rpcContract, {
    activity: ({ from, to, mergeGapMinutes }) =>
      queryActivity(from, to, mergeGapMinutes as MergeGapMinutes),
  });

  // Backfill once at load so the first page view does not wait for it.
  bb.background.service("backfill", {
    async start(signal) {
      try {
        await syncAll();
      } catch (cause) {
        if (!signal.aborted)
          bb.log.warn(`Initial turn history sync failed: ${errorMessage(cause)}`);
      }
    },
  });

  bb.cli.register({
    name: "agent-calendar",
    summary: "Show what your agents worked on and when",
    commands: [
      {
        name: "timesheet",
        summary: "Hours per thread and day for a week",
        usage:
          "bb agent-calendar [timesheet] [--week this|last|YYYY-MM-DD] [--gap 15|30|60|120] [--json]",
      },
      {
        name: "log",
        summary: "Chronological work blocks for a day or a week",
        usage:
          "bb agent-calendar log [--day today|yesterday|YYYY-MM-DD | --week this|last|YYYY-MM-DD] [--gap 15|30|60|120] [--json]",
      },
    ],
    async run(argv) {
      const parsed = parseCliArgs(argv);
      if (parsed.kind === "help") return { exitCode: 0, stdout: CLI_USAGE };
      if (parsed.kind === "error")
        return { exitCode: 2, stderr: `${parsed.message}\n${CLI_USAGE}` };

      const { command, range, gap, json } = parsed;
      const activity = await queryActivity(range.from, range.to, gap);
      if (command === "timesheet") {
        const days = Math.round((range.to - range.from) / DAY_MS);
        const boundaries = dayBoundaries(range.from, days);
        const rows = buildTimesheet(activity.blocks, boundaries);
        if (json) {
          return {
            exitCode: 0,
            stdout: boundedJson({ ...describeActivity(activity, range, gap), rows }),
          };
        }
        return { exitCode: 0, stdout: formatTimesheet(activity, range, gap, boundaries, rows) };
      }
      if (json) {
        return {
          exitCode: 0,
          stdout: boundedJson({
            ...describeActivity(activity, range, gap),
            blocks: activity.blocks,
          }),
        };
      }
      return { exitCode: 0, stdout: formatLog(activity, range, gap) };
    },
  });

  bb.onDispose(() => {
    disposed = true;
    for (const timer of threadTimers.values()) clearTimeout(timer);
    threadTimers.clear();
    if (signalTimer) clearTimeout(signalTimer);
  });
}

// ---------------------------------------------------------------------------
// CLI

const CLI_USAGE = [
  "Usage: bb agent-calendar [timesheet|log] [options]",
  "",
  "  timesheet   Hours per thread and day for a week (default)",
  "  log         Chronological work blocks for a day or a week",
  "",
  "Options:",
  "  --week this|last|YYYY-MM-DD   Week (Monday to Sunday) containing that date",
  "  --day today|yesterday|YYYY-MM-DD   One day (log only; default for log: today)",
  `  --gap ${MERGE_GAP_MINUTES.join("|")}   Merge turns of a thread separated by at most this many idle minutes (default ${DEFAULT_MERGE_GAP_MINUTES})`,
  "  --json                        Print machine-readable JSON",
  "",
  "Times use the bb server's local time zone.",
].join("\n");

type CliRange = { from: number; to: number; label: string };
type ParsedCli =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | {
      kind: "run";
      command: "timesheet" | "log";
      range: CliRange;
      gap: MergeGapMinutes;
      json: boolean;
    };

/** Local midnight for `YYYY-MM-DD`, or null when it is not a real date. */
function parseLocalDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date.getTime();
}

const dayLabel = (t: number) =>
  new Date(t).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

function weekRange(value: string, now: number): CliRange | null {
  const anchor =
    value === "this" ? now : value === "last" ? addDays(now, -7) : parseLocalDate(value);
  if (anchor === null) return null;
  const from = startOfWeek(anchor);
  const to = addDays(from, 7);
  return { from, to, label: `${dayLabel(from)} – ${dayLabel(addDays(from, 6))}` };
}

function dayRange(value: string, now: number): CliRange | null {
  const anchor =
    value === "today" ? now : value === "yesterday" ? addDays(now, -1) : parseLocalDate(value);
  if (anchor === null) return null;
  const from = startOfDay(anchor);
  return { from, to: addDays(from, 1), label: dayLabel(from) };
}

export function parseCliArgs(argv: readonly string[], now = Date.now()): ParsedCli {
  let json = false;
  let gap: MergeGapMinutes = DEFAULT_MERGE_GAP_MINUTES;
  let week: string | null = null;
  let day: string | null = null;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const option = /^(--[a-z]+)(?:=(.*))?$/.exec(arg);
    const takeValue = () => option?.[2] ?? argv[++index];
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--json") {
      json = true;
    } else if (option?.[1] === "--week") {
      week = takeValue() ?? "";
    } else if (option?.[1] === "--day") {
      day = takeValue() ?? "";
    } else if (option?.[1] === "--gap") {
      const value = takeValue();
      const minutes = Number(value);
      if (!isMergeGapMinutes(minutes)) {
        return {
          kind: "error",
          message: `Invalid --gap value: ${value ?? "(missing)"} (expected ${MERGE_GAP_MINUTES.join(", ")})`,
        };
      }
      gap = minutes;
    } else if (arg.startsWith("-")) {
      return { kind: "error", message: `Unknown option: ${arg}` };
    } else {
      positional.push(arg);
    }
  }

  const command = positional[0] ?? "timesheet";
  if (positional.length > 1 || (command !== "timesheet" && command !== "log")) {
    return { kind: "error", message: `Unknown command: ${positional.join(" ")}` };
  }
  if (week !== null && day !== null) {
    return { kind: "error", message: "Use either --week or --day, not both" };
  }
  if (command === "timesheet" && day !== null) {
    return { kind: "error", message: "timesheet covers a week; use --week" };
  }

  let range: CliRange | null;
  if (day !== null) {
    range = dayRange(day, now);
    if (!range) return { kind: "error", message: `Invalid --day value: ${day || "(missing)"}` };
  } else if (week !== null || command === "timesheet") {
    range = weekRange(week ?? "this", now);
    if (!range) return { kind: "error", message: `Invalid --week value: ${week || "(missing)"}` };
  } else {
    range = dayRange("today", now);
  }
  return { kind: "run", command, range: range!, gap, json };
}

const MAX_CLI_ROWS = 80;
const MAX_CLI_BLOCKS = 200;
const MAX_CLI_BYTES = 60_000;

function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The JSON envelope: the range plus the threads and projects it mentions. */
function describeActivity(activity: Activity, range: CliRange, gap: MergeGapMinutes) {
  const projectIds = new Set(activity.threads.map((thread) => thread.projectId));
  return {
    from: range.from,
    to: range.to,
    timeZone: timeZone(),
    mergeGapMinutes: gap,
    projects: activity.projects.filter((project) => projectIds.has(project.id)),
    threads: activity.threads,
  };
}

function boundedJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= MAX_CLI_BYTES) return text;
  return JSON.stringify(value);
}

function clip(text: string, width: number): string {
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, width - 1)}…`;
}

function formatTimesheet(
  activity: Activity,
  range: CliRange,
  gap: MergeGapMinutes,
  boundaries: readonly number[],
  rows: ReturnType<typeof buildTimesheet>,
): string {
  const header = [
    `Agent time sheet · ${range.label} (${timeZone()})`,
    `Turns merged across idle gaps up to ${gap}m · blocks rounded to quarter hours · hours in decimals`,
  ];
  if (rows.length === 0) return [...header, "", "No agent activity in this week."].join("\n");

  const threads = new Map(activity.threads.map((thread) => [thread.id, thread]));
  const projectNames = new Map(activity.projects.map((project) => [project.id, project.name]));
  const days = boundaries
    .slice(0, -1)
    .map((t) => new Date(t).toLocaleDateString("en-US", { weekday: "short" }));
  const titleWidth = 44;
  const cell = (value: string) => value.padStart(6);
  const lines = [
    ...header,
    "",
    `${"Thread".padEnd(titleWidth)}${days.map(cell).join("")}${cell("Total")}`,
  ];

  const byProject = new Map<string, typeof rows>();
  for (const row of rows) {
    const projectId = threads.get(row.threadId)?.projectId ?? "";
    byProject.set(projectId, [...(byProject.get(projectId) ?? []), row]);
  }
  let shown = 0;
  for (const [projectId, projectRows] of byProject) {
    if (shown >= MAX_CLI_ROWS) break;
    lines.push(projectNames.get(projectId) ?? projectId);
    for (const row of projectRows) {
      if (shown >= MAX_CLI_ROWS) break;
      const title = `  ${threads.get(row.threadId)?.title ?? row.threadId} (${row.threadId})`;
      lines.push(
        `${clip(title, titleWidth)}${row.dayMs.map((ms) => cell(formatHours(ms))).join("")}${cell(formatHours(row.totalMs))}`,
      );
      shown += 1;
    }
  }
  if (rows.length > shown) lines.push(`  … ${rows.length - shown} more threads (use --json)`);

  const dayTotals = boundaries
    .slice(0, -1)
    .map((_, day) => rows.reduce((sum, row) => sum + row.dayMs[day]!, 0));
  const total = dayTotals.reduce((sum, ms) => sum + ms, 0);
  const active = rows.reduce((sum, row) => sum + row.activeMs, 0);
  lines.push(
    `${"Total".padEnd(titleWidth)}${dayTotals.map((ms) => cell(formatHours(ms) || "0")).join("")}${cell(formatHours(total))}`,
    "",
    `${rows.length === 1 ? "1 thread" : `${rows.length} threads`} · ${formatHours(total)}h on the calendar · ${formatHours(active) || "0"}h of agent turns`,
  );
  return lines.join("\n");
}

function formatLog(activity: Activity, range: CliRange, gap: MergeGapMinutes): string {
  const header = [
    `Agent activity · ${range.label} (${timeZone()})`,
    `Turns merged across idle gaps up to ${gap}m · blocks rounded to quarter hours`,
  ];
  if (activity.blocks.length === 0) return [...header, "", "No agent activity."].join("\n");

  const threads = new Map(activity.threads.map((thread) => [thread.id, thread]));
  const projectNames = new Map(activity.projects.map((project) => [project.id, project.name]));
  const time = (t: number) =>
    new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const lines = [...header];
  let currentDay = -1;
  for (const block of activity.blocks.slice(0, MAX_CLI_BLOCKS)) {
    const day = startOfDay(block.start);
    if (day !== currentDay) {
      currentDay = day;
      lines.push(
        "",
        new Date(day).toLocaleDateString("en-US", {
          weekday: "long",
          month: "short",
          day: "numeric",
        }),
      );
    }
    const thread = threads.get(block.threadId);
    const project = thread ? (projectNames.get(thread.projectId) ?? thread.projectId) : "";
    const span = `${time(block.start)}–${block.end - day >= DAY_MS ? "24:00" : time(block.end)}`;
    lines.push(
      `  ${span}  ${`${formatHours(block.end - block.start)}h`.padStart(6)}  ${clip(project, 22)}  ${thread?.title ?? block.threadId} (${block.threadId})${block.ongoing ? " · running" : ""}`,
    );
  }
  if (activity.blocks.length > MAX_CLI_BLOCKS) {
    lines.push("", `… ${activity.blocks.length - MAX_CLI_BLOCKS} more blocks (use --json)`);
  }
  return lines.join("\n");
}

export type { Activity, ActivityBlock };
