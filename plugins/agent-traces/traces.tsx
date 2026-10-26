/**
 * The Traces page: every thread in the sidebar, the busiest recent ones side
 * by side at the root, and a thread's whole trace with room to read it.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_usePluginId,
  experimental_useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  ExperimentalPageTitle,
  PluginNavPanelProps,
  PluginRpcResult,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { emptyTotals, PHASES } from "./breakdown.js";
import { formatSubPath, parseSubPath, TRACES_PATH, type Screen } from "./routes.js";
import type { rpcContract } from "./server.js";
import { ThreadTrace, useCatchUp, useNow, useTraceLabels, type Back } from "./thread-trace.js";
import { formatDuration, TRACE_CHANNEL } from "./trace.js";
import { BreakdownBar, Notice, Stats, Tabs, ToolButton, useColors } from "./ui.js";
import { errorMessage } from "./util.js";

type Totals = PluginRpcResult<(typeof rpcContract)["threadTotals"]>["rows"][number];

const PAGE_SIZE = 25;
const SIDEBAR_THREADS_PER_PROJECT = 10;
// Totals are read a few threads per call, two calls at a time, so rows fill in as they land.
const TOTALS_BATCH = 5;
const TOTALS_CALLS = 2;
// Running threads signal about once a second; their rows refresh at most this often.
const SIGNAL_REFRESH_MS = 3_000;
const BUSY = new Set(["starting", "active", "stopping"]);

// ---------------------------------------------------------------------------
// Which threads to list, shared by the sidebar and the page and kept across visits.

interface ListOptions {
  archived: boolean;
  hidden: boolean;
}

const OPTIONS_KEY = "agent-traces.traces.list";
const optionListeners = new Set<() => void>();
let listOptions: ListOptions = readListOptions();

function readListOptions(): ListOptions {
  try {
    const saved = JSON.parse(window.localStorage.getItem(OPTIONS_KEY) ?? "{}") as Partial<
      Record<keyof ListOptions, unknown>
    >;
    return { archived: saved.archived === true, hidden: saved.hidden === true };
  } catch {
    return { archived: false, hidden: false };
  }
}

function setListOptions(next: ListOptions) {
  listOptions = next;
  try {
    window.localStorage.setItem(OPTIONS_KEY, JSON.stringify(next));
  } catch {
    // Private windows can refuse storage; the choice still holds until reload.
  }
  for (const listener of optionListeners) listener();
}

function useListOptions(): ListOptions {
  return useSyncExternalStore(
    (listener) => {
      optionListeners.add(listener);
      return () => {
        optionListeners.delete(listener);
      };
    },
    () => listOptions,
  );
}

function isBusy(thread: PluginSidebarThread): boolean {
  return BUSY.has(thread.status);
}

/** Last time anything happened in the thread, as far as the list knows. */
function lastActivity(thread: PluginSidebarThread): number {
  return Math.max(thread.updatedAt, thread.latestAttentionAt);
}

/** Working threads first, then the most recently active. */
function byActivity(a: PluginSidebarThread, b: PluginSidebarThread): number {
  return Number(isBusy(b)) - Number(isBusy(a)) || lastActivity(b) - lastActivity(a);
}

function useThreads() {
  const options = useListOptions();
  const state = experimental_useSidebarThreads(
    options.archived ? { experimental_lifecycles: ["active", "archived"] } : undefined,
  );
  const threads = useMemo(
    () =>
      state.threads
        .filter(
          (thread) =>
            (options.hidden || !thread.isHidden) && (options.archived || !thread.isArchived),
        )
        .sort(byActivity),
    [state.threads, options],
  );
  const projects = useMemo(
    () => new Map(state.projects.map((project) => [project.id, project.name])),
    [state.projects],
  );
  const byId = useMemo(
    () => new Map(state.threads.map((thread) => [thread.id, thread])),
    [state.threads],
  );
  return { state, threads, projects, options, byId };
}

function ago(at: number, now: number): string {
  const seconds = Math.max(0, (now - at) / 1_000);
  if (seconds < 60) return "now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The time, refreshed every `intervalMs`, for "3h ago" labels. */
function useClock(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function agoLabel(at: number, now: number): string {
  const short = ago(at, now);
  // "26m ago", but a date stays a date.
  return short === "now" ? "just now" : /^\d+[mhd]$/.test(short) ? `${short} ago` : short;
}

function useOpen() {
  const navigate = useBbNavigate();
  return (threadId: string | null, screen?: Screen) =>
    navigate.toPluginPanel(TRACES_PATH, { subPath: formatSubPath(threadId, screen) });
}

// ---------------------------------------------------------------------------
// Sidebar: every thread, by project, the way bb's own list reads.

interface Node {
  thread: PluginSidebarThread;
  children: Node[];
}

/**
 * Spawned threads sit under the thread that spawned them, when it is listed
 * too. Siblings keep the order they came in, most recently active first.
 */
function forest(threads: readonly PluginSidebarThread[]): Node[] {
  const nodes = new Map(threads.map((thread) => [thread.id, { thread, children: [] as Node[] }]));
  const roots: Node[] = [];
  for (const node of nodes.values()) {
    const parent = node.thread.parentThreadId ? nodes.get(node.thread.parentThreadId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function contains(node: Node, threadId: string | null): boolean {
  return (
    threadId !== null &&
    (node.thread.id === threadId || node.children.some((child) => contains(child, threadId)))
  );
}

function SidebarRow({
  node,
  depth,
  selected,
  now,
  onOpen,
}: {
  node: Node;
  depth: number;
  selected: string | null;
  now: number;
  onOpen: (threadId: string) => void;
}) {
  const { thread } = node;
  const active = thread.id === selected;
  return (
    <>
      <li>
        <button
          type="button"
          onClick={() => onOpen(thread.id)}
          aria-current={active ? "page" : undefined}
          title={thread.displayTitle}
          className={`flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-[13px] transition-colors ${
            active
              ? "bg-accent text-foreground"
              : "text-foreground/85 hover:bg-muted hover:text-foreground"
          }`}
          style={{ paddingLeft: `${0.5 + Math.min(depth, 3) * 0.875}rem` }}
        >
          <span
            className="flex size-4 shrink-0 items-center justify-center"
            aria-label={thread.indicatorLabel ?? undefined}
          >
            {thread.indicator === "none" && !thread.isArchived ? (
              depth > 0 ? (
                <span className="text-[11px] text-muted-foreground">↳</span>
              ) : null
            ) : (
              <ThreadStatusGlyph
                indicator={thread.indicator}
                archived={thread.isArchived}
                size="compact"
              />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate">{thread.displayTitle}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {isBusy(thread) ? "running" : ago(lastActivity(thread), now)}
          </span>
        </button>
      </li>
      {node.children.map((child) => (
        <SidebarRow
          key={child.thread.id}
          node={child}
          depth={depth + 1}
          selected={selected}
          now={now}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}

function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-3.5 accent-current"
      />
      {children}
    </label>
  );
}

export function TracesSidebar({ subPath }: PluginNavPanelProps) {
  const selected = parseSubPath(subPath).threadId;
  const open = useOpen();
  const { state, threads, projects, options } = useThreads();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const now = useClock(30_000);

  const needle = query.trim().toLowerCase();
  const matching = needle
    ? threads.filter(
        (thread) =>
          thread.displayTitle.toLowerCase().includes(needle) || thread.id.includes(needle),
      )
    : threads;
  // Projects in the order their threads were last active.
  const groups = new Map<string, PluginSidebarThread[]>();
  for (const thread of matching) {
    const group = groups.get(thread.projectId) ?? [];
    group.push(thread);
    groups.set(thread.projectId, group);
  }
  const toggle = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };

  return (
    // bb's sidebar scrolls and pads this; the search and the toggles stay in view.
    <div className="flex flex-col text-sm">
      <div className="sticky top-0 z-10 flex flex-col gap-1 bg-sidebar pt-1 pb-1">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              setQuery("");
            }
          }}
          placeholder="Filter threads"
          aria-label="Filter threads"
          className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
        />
        <button
          type="button"
          onClick={() => open(null)}
          aria-current={selected === null ? "page" : undefined}
          className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-left text-[13px] ${
            selected === null
              ? "bg-accent text-foreground"
              : "text-foreground/85 hover:bg-muted hover:text-foreground"
          }`}
        >
          <span className="flex-1">All threads</span>
          <span className="text-[11px] tabular-nums text-muted-foreground">{threads.length}</span>
        </button>
      </div>
      <div className="pb-2">
        {state.status === "loading" ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">Loading threads…</p>
        ) : state.status === "error" ? (
          <p className="px-2 py-3 text-xs text-destructive">Could not load the threads.</p>
        ) : matching.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            {needle ? "No thread matches." : "No threads yet."}
          </p>
        ) : null}
        {[...groups].map(([projectId, group]) => {
          const isCollapsed = collapsed.has(projectId) && !needle;
          const roots = forest(group);
          const all = expanded.has(projectId) || needle !== "";
          const shown = roots.filter(
            (root, index) => all || index < SIDEBAR_THREADS_PER_PROJECT || contains(root, selected),
          );
          const hiddenCount = roots.length - shown.length;
          return (
            <section key={projectId} className="mt-2 first:mt-1">
              <button
                type="button"
                onClick={() => setCollapsed(toggle(collapsed, projectId))}
                aria-expanded={!isCollapsed}
                className="flex h-6 w-full items-center gap-1 rounded-md px-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <span className="w-3 text-[10px]">{isCollapsed ? "▸" : "▾"}</span>
                <span className="min-w-0 flex-1 truncate">
                  {projects.get(projectId) ?? "Project"}
                </span>
                <span className="tabular-nums">{group.length}</span>
              </button>
              {isCollapsed ? null : (
                <ul className="flex flex-col gap-px">
                  {shown.map((node) => (
                    <SidebarRow
                      key={node.thread.id}
                      node={node}
                      depth={0}
                      selected={selected}
                      now={now}
                      onOpen={(threadId) => open(threadId)}
                    />
                  ))}
                  {hiddenCount > 0 ? (
                    <li>
                      <button
                        type="button"
                        onClick={() => setExpanded(toggle(expanded, projectId))}
                        className="h-6 w-full rounded-md px-2 pl-7 text-left text-xs text-muted-foreground hover:text-foreground"
                      >
                        Show {hiddenCount} more
                      </button>
                    </li>
                  ) : null}
                </ul>
              )}
            </section>
          );
        })}
        {options.archived && state.experimental_archived?.hasNextPage ? (
          <button
            type="button"
            disabled={state.experimental_archived.isFetchingNextPage}
            onClick={() => void state.experimental_archived?.fetchNextPage()}
            className="mt-2 h-7 w-full rounded-md text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {state.experimental_archived.isFetchingNextPage
              ? "Loading archived threads…"
              : "Load more archived threads"}
          </button>
        ) : null}
      </div>
      <div className="sticky bottom-0 z-10 -mb-2.5 flex items-center gap-3 border-t border-border bg-sidebar px-2 py-2">
        <Toggle
          checked={options.archived}
          onChange={(archived) => setListOptions({ ...options, archived })}
        >
          Archived
        </Toggle>
        <Toggle
          checked={options.hidden}
          onChange={(hidden) => setListOptions({ ...options, hidden })}
        >
          Hidden
        </Toggle>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The root: the most recent threads with their totals, to see where the time went.

function versionOf(thread: PluginSidebarThread): string {
  return `${thread.updatedAt}:${thread.status}`;
}

interface TotalsRow {
  version: string;
  totals: Totals;
  /** When the server read them, to keep a running thread's time ticking. */
  at: number;
}

/** Each listed thread's totals, read a few at a time and again whenever it changes. */
function useThreadTotals(threads: readonly PluginSidebarThread[]) {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<ReadonlyMap<string, TotalsRow>>(new Map());
  const inFlight = useRef(new Set<string>());
  const calls = useRef(0);
  const signaled = useRef(new Set<string>());
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const wanted = threads.filter((thread) => {
      if (inFlight.current.has(thread.id)) return false;
      const row = rows.get(thread.id);
      return !row || row.version !== versionOf(thread) || signaled.current.has(thread.id);
    });
    while (wanted.length > 0 && calls.current < TOTALS_CALLS) {
      const batch = wanted.splice(0, TOTALS_BATCH);
      const versions = new Map(batch.map((thread) => [thread.id, versionOf(thread)]));
      for (const thread of batch) {
        inFlight.current.add(thread.id);
        signaled.current.delete(thread.id);
      }
      calls.current++;
      const settle = (update: (next: Map<string, TotalsRow>) => void) => {
        calls.current--;
        for (const thread of batch) inFlight.current.delete(thread.id);
        if (!mounted.current) return;
        setRows((previous) => {
          const next = new Map(previous);
          update(next);
          return next;
        });
      };
      rpc
        .call("threadTotals", {
          threads: batch.map((thread) => ({ threadId: thread.id, version: versionOf(thread) })),
        })
        .then(
          ({ generatedAt, rows: totals }) =>
            settle((next) => {
              for (const row of totals) {
                next.set(row.threadId, {
                  version: versions.get(row.threadId) ?? "",
                  totals: row,
                  at: generatedAt,
                });
              }
            }),
          (cause) =>
            // Remembered with its version, so a failing thread is not asked for again until it changes.
            settle((next) => {
              for (const thread of batch) {
                next.set(thread.id, {
                  version: versions.get(thread.id) ?? "",
                  totals: { ...emptyRow(thread.id), error: errorMessage(cause) },
                  at: Date.now(),
                });
              }
            }),
        );
    }
  }, [rpc, threads, rows, tick]);

  // Running threads signal their changes; batch them so a busy thread does not ask every second.
  const pending = useRef<number | null>(null);
  useRealtime(TRACE_CHANNEL, (payload) => {
    const changed = (payload as { threadId?: unknown } | null)?.threadId;
    if (typeof changed !== "string" || !threads.some((thread) => thread.id === changed)) return;
    signaled.current.add(changed);
    if (pending.current !== null) return;
    pending.current = window.setTimeout(() => {
      pending.current = null;
      setTick((value) => value + 1);
    }, SIGNAL_REFRESH_MS);
  });
  useEffect(
    () => () => {
      if (pending.current !== null) window.clearTimeout(pending.current);
    },
    [],
  );
  useCatchUp(() => {
    for (const thread of threads) signaled.current.add(thread.id);
    setTick((value) => value + 1);
  });

  return rows;
}

function emptyRow(threadId: string): Totals {
  return {
    threadId,
    error: null,
    turns: 0,
    activeMs: 0,
    phases: emptyTotals(),
    toolCalls: 0,
    subagents: 0,
    errors: 0,
    longestTurnMs: 0,
    runningSince: null,
    lastTurnAt: null,
  };
}

function activeAt(row: TotalsRow, now: number): number {
  return row.totals.activeMs + (row.totals.runningSince !== null ? Math.max(0, now - row.at) : 0);
}

type Sort = "recent" | "longest";

function AllThreads() {
  const open = useOpen();
  const { state, threads, projects } = useThreads();
  const { phases: colors } = useColors();
  const [projectId, setProjectId] = useState<string>("");
  const [sort, setSort] = useState<Sort>("recent");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const listed = useMemo(
    () => (projectId ? threads.filter((thread) => thread.projectId === projectId) : threads),
    [threads, projectId],
  );
  const shown = useMemo(() => listed.slice(0, limit), [listed, limit]);
  const rows = useThreadTotals(shown);
  const running = shown.some((thread) => rows.get(thread.id)?.totals.runningSince != null);
  const now = useNow(running);

  if (state.status === "loading") return <Notice>Loading threads…</Notice>;
  if (state.status === "error") return <Notice>Could not load the threads.</Notice>;

  const loaded = shown.flatMap((thread) => {
    const row = rows.get(thread.id);
    return row && !row.totals.error ? [row] : [];
  });
  const phases = emptyTotals();
  let active = 0;
  let turns = 0;
  let calls = 0;
  let subagents = 0;
  let errors = 0;
  for (const row of loaded) {
    active += activeAt(row, now);
    turns += row.totals.turns;
    calls += row.totals.toolCalls;
    subagents += row.totals.subagents;
    errors += row.totals.errors;
    for (const phase of PHASES) phases[phase] += row.totals.phases[phase];
  }
  const longest = Math.max(1, ...loaded.map((row) => activeAt(row, now)));
  const ordered =
    sort === "recent"
      ? shown
      : [...shown].sort(
          (a, b) =>
            (rows.has(b.id) ? activeAt(rows.get(b.id)!, now) : -1) -
            (rows.has(a.id) ? activeAt(rows.get(a.id)!, now) : -1),
        );
  const projectOptions = [...new Set(threads.map((thread) => thread.projectId))];
  const reading = shown.filter((thread) => !rows.has(thread.id)).length;

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <div className="flex shrink-0 flex-col gap-3 px-4 pt-4 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setLimit(PAGE_SIZE);
            }}
            aria-label="Project"
            className="h-7 rounded-md border border-border bg-background px-2 text-xs"
          >
            <option value="">All projects</option>
            {projectOptions.map((id) => (
              <option key={id} value={id}>
                {projects.get(id) ?? id}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">
            {shown.length < listed.length
              ? `The ${shown.length} most recent of ${listed.length} threads`
              : `${listed.length} thread${listed.length === 1 ? "" : "s"}`}
            {reading > 0 ? ` · reading ${reading}…` : ""}
          </span>
          <span className="ml-auto" />
          <Tabs
            value={sort}
            onChange={setSort}
            options={[
              { value: "recent", label: "Recent" },
              { value: "longest", label: "Most time" },
            ]}
          />
        </div>
        <Stats
          items={[
            {
              label: "Active time",
              value: formatDuration(active),
              hint: "Time agents spent on these threads' turns, waits included",
            },
            { label: "Threads", value: String(shown.length) },
            { label: "Turns", value: String(turns) },
            { label: "Tool calls", value: String(calls) },
            { label: "Subagents", value: String(subagents) },
            { label: "Errors", value: String(errors), alert: errors > 0 },
          ]}
        />
        <BreakdownBar phases={phases} total={active} />
      </div>
      <div className="@container min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {listed.length === 0 ? (
          <Notice>No threads here yet.</Notice>
        ) : (
          <ul className="flex flex-col">
            <li
              aria-hidden
              className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_auto] gap-3 bg-background px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground @2xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto]"
            >
              <span>Thread</span>
              <span className="hidden @2xl:block">Where the time went</span>
              <Numbers turns="Turns" active="Active" calls="Calls" errors="Errors" />
            </li>
            {ordered.map((thread) => {
              const row = rows.get(thread.id);
              const totals = row?.totals;
              const activeMs = row ? activeAt(row, now) : 0;
              return (
                <li key={thread.id}>
                  <button
                    type="button"
                    onClick={() => open(thread.id)}
                    title={thread.displayTitle}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted @2xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto]"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="flex size-4 shrink-0 items-center justify-center">
                        <ThreadStatusGlyph
                          indicator={thread.indicator}
                          archived={thread.isArchived}
                          size="compact"
                        />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{thread.displayTitle}</span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {projects.get(thread.projectId) ?? "Project"} ·{" "}
                          {isBusy(thread) ? "running" : agoLabel(lastActivity(thread), now)}
                          {thread.parentThreadId ? " · spawned" : ""}
                        </span>
                      </span>
                    </span>
                    <span className="hidden min-w-0 items-center @2xl:flex">
                      {totals && !totals.error && activeMs > 0 ? (
                        <span
                          className="flex h-2.5 overflow-hidden rounded-sm"
                          style={{ width: `${Math.max(2, (100 * activeMs) / longest)}%` }}
                        >
                          {PHASES.map((phase) =>
                            totals.phases[phase] > 0 ? (
                              <span
                                key={phase}
                                style={{ flex: totals.phases[phase], background: colors[phase] }}
                              />
                            ) : null,
                          )}
                        </span>
                      ) : null}
                    </span>
                    {!totals ? (
                      <Numbers turns="…" active="…" calls="…" errors="…" muted />
                    ) : totals.error ? (
                      <span
                        className="w-[15rem] truncate text-right text-xs text-destructive"
                        title={totals.error}
                      >
                        Could not read the trace
                      </span>
                    ) : (
                      <Numbers
                        turns={String(totals.turns)}
                        active={formatDuration(activeMs)}
                        calls={String(totals.toolCalls)}
                        errors={String(totals.errors)}
                        alert={totals.errors > 0}
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {shown.length < listed.length ? (
          <div className="flex justify-center pt-2">
            <ToolButton onClick={() => setLimit(limit + PAGE_SIZE)}>
              Show {Math.min(PAGE_SIZE, listed.length - shown.length)} more
            </ToolButton>
          </div>
        ) : null}
      </div>
      <p className="shrink-0 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        Bars show each thread's time by phase, scaled to the one that took longest. Pick a thread to
        see its turns.
      </p>
    </div>
  );
}

function Numbers({
  turns,
  active,
  calls,
  errors,
  muted,
  alert,
}: {
  turns: string;
  active: string;
  calls: string;
  errors: string;
  muted?: boolean;
  alert?: boolean;
}) {
  return (
    <span
      className={`grid grid-cols-[3rem_5rem_3.5rem_3.5rem] text-right text-xs tabular-nums ${
        muted ? "text-muted-foreground" : ""
      }`}
    >
      <span>{turns}</span>
      <span>{active}</span>
      <span>{calls}</span>
      <span className={alert ? "text-destructive" : ""}>{errors}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// The page and its header.

export function TracesPage({ subPath }: PluginNavPanelProps) {
  const route = parseSubPath(subPath);
  const open = useOpen();
  const { byId } = useThreads();
  // Where a spawned thread was opened from, to go back to that same view.
  const [origin, setOrigin] = useState<{
    threadId: string;
    from: { threadId: string; screen: Screen; title: string };
  } | null>(null);
  if (route.threadId === null) return <AllThreads />;
  const { threadId } = route;
  const thread = byId.get(threadId);
  const parent = thread?.parentThreadId ? byId.get(thread.parentThreadId) : undefined;
  const from = origin?.threadId === threadId ? origin.from : null;
  const back: Back | null = from
    ? { label: from.title, onBack: () => open(from.threadId, from.screen) }
    : parent
      ? { label: parent.displayTitle, onBack: () => open(parent.id) }
      : null;
  return (
    <ThreadTrace
      key={threadId}
      target={{ threadId }}
      back={back}
      screen={route.screen}
      onScreen={(screen) => open(threadId, screen)}
      onOpenThread={(next, screen) => {
        setOrigin({
          threadId: next.threadId,
          from: { threadId, screen, title: next.fromTitle ?? "the thread" },
        });
        open(
          next.threadId,
          next.turnId ? { kind: "turn", turnId: next.turnId, spanId: next.spanId } : undefined,
        );
      }}
    />
  );
}

/** The page header's actions: jump to the conversation behind the trace. */
export function TracesHeader({ subPath }: PluginNavPanelProps) {
  const { threadId } = parseSubPath(subPath);
  const navigate = useBbNavigate();
  if (!threadId) return null;
  return (
    <ToolButton onClick={() => navigate.toThread(threadId)} title="Open the conversation">
      Open thread
    </ToolButton>
  );
}

/** "Traces › Fix the checkout › Turn #4" in the header and the window title. */
export function useTracesPageTitle({ subPath }: PluginNavPanelProps): ExperimentalPageTitle | null {
  const route = parseSubPath(subPath);
  const pluginId = experimental_usePluginId();
  const { byId } = useThreads();
  const labels = useTraceLabels();
  if (route.threadId === null) return null;
  const { threadId, screen } = route;
  const title = byId.get(threadId)?.displayTitle ?? labels.title(threadId) ?? "Thread";
  const turn = (turnId: string) => {
    const index = labels.turn(threadId, turnId);
    return index === null ? "turn" : `#${index}`;
  };
  const leaf =
    screen.kind === "commands"
      ? "Commands"
      : screen.kind === "turn"
        ? `Turn ${turn(screen.turnId)}`
        : screen.kind === "compare"
          ? `Turn ${turn(screen.a)} vs ${turn(screen.b)}`
          : null;
  return {
    breadcrumbs: leaf
      ? [
          { label: title, to: `/plugins/${pluginId}/${TRACES_PATH}/${formatSubPath(threadId)}` },
          { label: leaf },
        ]
      : [{ label: title }],
    windowTitle: `${leaf ? `${leaf} · ` : ""}${title} · Traces`,
  };
}
