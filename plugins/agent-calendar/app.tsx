import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_useCodeTheme,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";
import {
  addDays,
  buildTimesheet,
  CHANGE_CHANNEL,
  dayBoundaries,
  DEFAULT_MERGE_GAP_MINUTES,
  formatDuration,
  formatHours,
  groupBlocks,
  isMergeGapMinutes,
  MERGE_GAP_MINUTES,
  MINUTE_MS,
  startOfDay,
  startOfWeek,
  type ActivityBlock,
  type GroupBlock,
  type MergeGapMinutes,
  type TimesheetRow,
} from "./activity.js";

type Activity = PluginRpcResult<(typeof rpcContract)["activity"]>;
type ActivityThread = Activity["threads"][number];
type View = "calendar" | "timesheet";
type Grouping = "project" | "thread";
type ProjectStyle = { id: string; name: string; color: string; order: number };

const VIEW_STORAGE_KEY = "agent-calendar.view";
const GAP_STORAGE_KEY = "agent-calendar.merge-gap";
const GROUPING_STORAGE_KEY = "agent-calendar.grouping";

const HOUR_PX = 48;
const DAY_MINUTES = 24 * 60;
const POPOVER_WIDTH = 280;
const POPOVER_THREAD_PREVIEW = 6;

// Fixed-order categorical palette, validated for CVD separation in both modes.
// Projects past the eighth fold into a neutral "other" color.
const PALETTE = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
} as const;
const OTHER_COLOR = "#898781";

function readStored<T>(key: string, parse: (value: string | null) => T | null, fallback: T): T {
  try {
    return parse(window.localStorage.getItem(key)) ?? fallback;
  } catch {
    // Storage can be unavailable (private browsing, blocked cookies).
    return fallback;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Best effort only.
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Minutes since local midnight, so DST days still line up with the hour grid. */
function wallMinutes(t: number, dayStart: number): number {
  if (t - dayStart >= 23 * 60 * MINUTE_MS && startOfDay(t) !== dayStart) return DAY_MINUTES;
  const date = new Date(t);
  return date.getHours() * 60 + date.getMinutes();
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const hourFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const longDayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const rangeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function formatSpan(start: number, end: number): string {
  return `${timeFormat.format(start)} – ${timeFormat.format(end)}`;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Calendar data for one range, refreshed whenever the server signals a change. */
function useActivity(from: number, to: number, gap: MergeGapMinutes) {
  const rpc = useRpc<typeof rpcContract>();
  const key = `${from}:${to}:${gap}`;
  const [snapshot, setSnapshot] = useState<{ key: string; data: Activity } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestRequest = useRef(0);

  const refresh = useCallback(() => {
    const request = ++latestRequest.current;
    rpc.call("activity", { from, to, mergeGapMinutes: gap }).then(
      (data) => {
        if (request !== latestRequest.current) return;
        setSnapshot({ key, data });
        setError(null);
      },
      (cause) => {
        if (request === latestRequest.current) setError(errorMessage(cause));
      },
    );
  }, [rpc, from, to, gap, key]);

  useEffect(refresh, [refresh]);
  useRealtime(CHANGE_CHANNEL, refresh);

  // Signals are not replayed, so catch up after the socket reconnects.
  const connection = useRealtimeConnectionState();
  const connectedBefore = useRef(false);
  useEffect(() => {
    if (connection !== "connected") return;
    if (connectedBefore.current) refresh();
    connectedBefore.current = true;
  }, [connection, refresh]);

  // Running blocks grow with the clock.
  useEffect(() => {
    if (Date.now() >= to) return;
    const timer = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(timer);
  }, [refresh, to]);

  return {
    data: snapshot?.data ?? null,
    isStale: snapshot !== null && snapshot.key !== key,
    error,
  };
}

/** Colors follow the project, in bb's project order, for the projects in view. */
function useProjectStyles(activity: Activity | null): Map<string, ProjectStyle> {
  const { mode } = experimental_useCodeTheme();
  return useMemo(() => {
    const styles = new Map<string, ProjectStyle>();
    if (!activity) return styles;
    const inView = new Set(activity.threads.map((thread) => thread.projectId));
    const ordered = activity.projects.filter((project) => inView.has(project.id));
    for (const thread of activity.threads) {
      if (!ordered.some((project) => project.id === thread.projectId)) {
        ordered.push({ id: thread.projectId, name: "Unknown project" });
      }
    }
    ordered.forEach((project, index) => {
      styles.set(project.id, {
        id: project.id,
        name: project.name,
        color: PALETTE[mode][index] ?? OTHER_COLOR,
        order: index,
      });
    });
    return styles;
  }, [activity, mode]);
}

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  title,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
  title?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      title={title}
      className="flex shrink-0 items-center gap-0.5 rounded-lg border bg-surface-recessed p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            option.value === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function IconButton({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Icon name={icon} className="size-4" aria-hidden />
    </button>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2.5 shrink-0 rounded-[3px]"
      style={{ backgroundColor: color }}
    />
  );
}

function RunningDot() {
  return (
    <span className="relative inline-flex size-2 shrink-0" aria-label="Running now">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
      <span className="relative inline-flex size-2 rounded-full bg-success" />
    </span>
  );
}

function peakParallel(blocks: readonly ActivityBlock[]): number {
  const edges = blocks.flatMap((block) => [
    { t: block.start, delta: 1 },
    { t: block.end, delta: -1 },
  ]);
  edges.sort((a, b) => a.t - b.t || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  for (const edge of edges) {
    current += edge.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

function Summary({ activity }: { activity: Activity }) {
  const calendarMs = activity.blocks.reduce((sum, block) => sum + block.end - block.start, 0);
  const activeMs = activity.blocks.reduce((sum, block) => sum + block.activeMs, 0);
  const stats = [
    { label: "Threads", value: String(activity.threads.length) },
    { label: "On the calendar", value: formatDuration(calendarMs) || "0m" },
    { label: "Agent turns", value: formatDuration(activeMs) || "0m" },
    { label: "Peak in parallel", value: String(peakParallel(activity.blocks)) },
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label} className="rounded-lg border bg-card px-3 py-2 shadow-sm">
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {stat.label}
          </dt>
          <dd className="mt-0.5 text-lg font-semibold">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Legend({
  activity,
  projects,
}: {
  activity: Activity;
  projects: Map<string, ProjectStyle>;
}) {
  const totals = new Map<string, number>();
  const threadProject = new Map(activity.threads.map((thread) => [thread.id, thread.projectId]));
  for (const block of activity.blocks) {
    const projectId = threadProject.get(block.threadId) ?? "";
    totals.set(projectId, (totals.get(projectId) ?? 0) + block.end - block.start);
  }
  const entries = [...projects.values()].sort((a, b) => a.order - b.order);
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs" aria-label="Projects">
      {entries.map((project) => (
        <li key={project.id} className="flex items-center gap-1.5">
          <Swatch color={project.color} />
          <span className="text-foreground">{project.name}</span>
          <span className="tabular-nums text-muted-foreground">
            {formatDuration(totals.get(project.id) ?? 0)}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Calendar view

/** One calendar entry: a project's or a thread's merged blocks, ready to draw. */
type Entry = GroupBlock & { projectId: string; title: string; detail: string };

type Segment = {
  entry: Entry;
  top: number;
  bottom: number;
  lane: number;
  lanes: number;
  /** Lanes the entry covers, widening into free lanes on its right. */
  span: number;
};

function buildEntries(
  activity: Activity,
  grouping: Grouping,
  gap: MergeGapMinutes,
  projects: Map<string, ProjectStyle>,
): Entry[] {
  const threads = new Map(activity.threads.map((thread) => [thread.id, thread]));
  const projectOf = (threadId: string) => threads.get(threadId)?.projectId ?? "";
  if (grouping === "project") {
    return groupBlocks(activity.blocks, projectOf, gap * MINUTE_MS).map((group) => ({
      ...group,
      projectId: group.key,
      title: projects.get(group.key)?.name ?? "Unknown project",
      detail: group.threads.length === 1 ? "1 thread" : `${group.threads.length} threads`,
    }));
  }
  // Thread blocks never touch, so a zero gap keeps them exactly as they are.
  return groupBlocks(activity.blocks, (threadId) => threadId, 0).map((group) => {
    const projectId = projectOf(group.key);
    return {
      ...group,
      projectId,
      title: threads.get(group.key)?.title ?? group.key,
      detail: projects.get(projectId)?.name ?? "Unknown project",
    };
  });
}

/** Side-by-side lanes for overlapping entries, like a calendar app. */
function layoutDay(entries: readonly Entry[], dayStart: number, dayEnd: number): Segment[] {
  const segments: Segment[] = entries
    .filter((entry) => entry.start < dayEnd && entry.end > dayStart)
    .map((entry) => {
      const top = wallMinutes(Math.max(entry.start, dayStart), dayStart);
      const bottom = Math.max(top + 15, wallMinutes(Math.min(entry.end, dayEnd), dayStart));
      return { entry, top, bottom: Math.min(bottom, DAY_MINUTES), lane: 0, lanes: 1, span: 1 };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);

  let cluster: Segment[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;
  const flush = () => {
    for (const segment of cluster) {
      segment.lanes = laneEnds.length;
      const blocked = (lane: number) =>
        cluster.some(
          (other) =>
            other.lane === lane && other.top < segment.bottom && other.bottom > segment.top,
        );
      while (segment.lane + segment.span < segment.lanes && !blocked(segment.lane + segment.span)) {
        segment.span += 1;
      }
    }
    cluster = [];
    laneEnds = [];
  };
  for (const segment of segments) {
    if (segment.top >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= segment.top);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(segment.bottom);
    } else {
      laneEnds[lane] = segment.bottom;
    }
    segment.lane = lane;
    cluster.push(segment);
    clusterEnd = Math.max(clusterEnd, segment.bottom);
  }
  flush();
  return segments;
}

type Popover = { entry: Entry; left: number; top: number; pinned: boolean };

function EntryPopover({
  popover,
  grouping,
  threads,
  projects,
  onOpen,
  onClose,
}: {
  popover: Popover;
  grouping: Grouping;
  threads: Map<string, ActivityThread>;
  projects: Map<string, ProjectStyle>;
  onOpen: (threadId: string) => void;
  onClose: () => void;
}) {
  const { entry, pinned } = popover;
  const project = projects.get(entry.projectId);
  const listed = pinned ? entry.threads : entry.threads.slice(0, POPOVER_THREAD_PREVIEW);
  const archived = grouping === "thread" && threads.get(entry.key)?.archived;
  return (
    <div
      role={pinned ? "dialog" : "tooltip"}
      aria-label={entry.title}
      data-agent-calendar-popover=""
      className={`absolute z-30 rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-lg ${pinned ? "" : "pointer-events-none"}`}
      style={{ left: popover.left, top: popover.top, width: POPOVER_WIDTH }}
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium leading-snug">{entry.title}</p>
        {pinned && <IconButton icon="X" label="Close" onClick={onClose} />}
      </div>
      <p className="mt-1 flex items-center gap-1.5 text-muted-foreground">
        <Swatch color={project?.color ?? OTHER_COLOR} />
        <span className="truncate">{entry.detail}</span>
        {archived && <span>· archived</span>}
      </p>
      <p className="mt-2 tabular-nums">
        {longDayFormat.format(entry.start)} · {formatSpan(entry.start, entry.end)}
      </p>
      <p className="mt-0.5 tabular-nums text-muted-foreground">
        {formatDuration(entry.end - entry.start)} on the calendar ·{" "}
        {formatDuration(entry.activeMs) || "<1m"} of agent turns
      </p>
      {entry.ongoing && (
        <p className="mt-2 flex items-center gap-1.5 font-medium">
          <RunningDot /> Running now
        </p>
      )}
      {grouping === "project" && (
        <ul className={`mt-2 space-y-px border-t pt-2 ${pinned ? "max-h-64 overflow-y-auto" : ""}`}>
          {listed.map((item) => {
            const title = threads.get(item.threadId)?.title ?? item.threadId;
            const content = (
              <>
                <span className="min-w-0 flex-1 truncate">{title}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatDuration(item.ms)}
                </span>
              </>
            );
            return (
              <li key={item.threadId}>
                {pinned ? (
                  <button
                    type="button"
                    onClick={() => onOpen(item.threadId)}
                    className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted"
                  >
                    {content}
                  </button>
                ) : (
                  <div className="flex items-center gap-2 px-1 py-0.5">{content}</div>
                )}
              </li>
            );
          })}
          {entry.threads.length > listed.length && (
            <li className="px-1 pt-0.5 text-muted-foreground">
              +{entry.threads.length - listed.length} more
            </li>
          )}
        </ul>
      )}
      {!pinned && (
        <p className="mt-2 text-muted-foreground">
          {grouping === "project" && entry.threads.length > 1
            ? "Click to pick a thread"
            : "Click to open the thread"}
        </p>
      )}
    </div>
  );
}

function CalendarView({
  activity,
  grouping,
  gap,
  weekStart,
  projects,
  now,
  onOpen,
}: {
  activity: Activity;
  grouping: Grouping;
  gap: MergeGapMinutes;
  weekStart: number;
  projects: Map<string, ProjectStyle>;
  now: number;
  onOpen: (threadId: string) => void;
}) {
  const boundaries = useMemo(() => dayBoundaries(weekStart, 7), [weekStart]);
  const threads = useMemo(
    () => new Map(activity.threads.map((thread) => [thread.id, thread])),
    [activity.threads],
  );
  const entries = useMemo(
    () => buildEntries(activity, grouping, gap, projects),
    [activity, grouping, gap, projects],
  );
  const days = useMemo(
    () =>
      boundaries.slice(0, -1).map((dayStart, index) => {
        const dayEnd = boundaries[index + 1]!;
        const totalMs = activity.blocks.reduce(
          (sum, block) =>
            sum + Math.max(0, Math.min(block.end, dayEnd) - Math.max(block.start, dayStart)),
          0,
        );
        return { dayStart, dayEnd, segments: layoutDay(entries, dayStart, dayEnd), totalMs };
      }),
    [activity.blocks, entries, boundaries],
  );
  const today = startOfDay(now);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledWeek = useRef<number | null>(null);
  const [popover, setPopover] = useState<Popover | null>(null);

  // Open each week on its first entry (or 8 AM), the way a calendar app does.
  useLayoutEffect(() => {
    if (scrolledWeek.current === weekStart) return;
    scrolledWeek.current = weekStart;
    const earliest = Math.min(8 * 60, ...days.flatMap((day) => day.segments.map((s) => s.top)));
    const frame = window.requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = Math.max(0, (earliest / 60 - 0.5) * HOUR_PX);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [days, weekStart]);

  useEffect(() => setPopover(null), [weekStart, grouping]);

  // A pinned popover closes on Escape or a click anywhere else.
  const pinned = popover?.pinned ?? false;
  useEffect(() => {
    if (!pinned) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPopover(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest("[data-agent-calendar-popover]")) setPopover(null);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [pinned]);

  const place = (entry: Entry, target: HTMLElement, pin: boolean): Popover | null => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return null;
    const area = wrapper.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const fitsRight = rect.right + 8 + POPOVER_WIDTH <= area.right;
    const left = fitsRight
      ? rect.right - area.left + 8
      : Math.max(0, rect.left - area.left - 8 - POPOVER_WIDTH);
    const top = Math.min(Math.max(0, rect.top - area.top), Math.max(0, area.height - 320));
    return { entry, left, top, pinned: pin };
  };

  const preview = (entry: Entry, target: HTMLElement) => {
    if (!pinned) setPopover(place(entry, target, false));
  };

  const activate = (entry: Entry, target: HTMLElement) => {
    if (grouping === "thread" || entry.threads.length === 1) {
      onOpen(entry.threads[0]!.threadId);
      return;
    }
    setPopover(place(entry, target, true));
  };

  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  const gridTemplate = { gridTemplateColumns: "3.25rem repeat(7, minmax(6.5rem, 1fr))" };

  return (
    <div ref={wrapperRef} className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto rounded-lg border bg-card"
        onScroll={() => setPopover(null)}
      >
        <div className="min-w-[49rem]">
          <div className="sticky top-0 z-20 grid border-b bg-card" style={gridTemplate}>
            <div />
            {days.map((day) => {
              const isToday = day.dayStart === today;
              return (
                <div key={day.dayStart} className="border-l px-2 py-2 text-center">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {weekdayFormat.format(day.dayStart)}
                  </p>
                  <p
                    className={`mx-auto mt-0.5 flex size-7 items-center justify-center rounded-full text-sm font-semibold ${
                      isToday ? "bg-primary text-primary-foreground" : ""
                    }`}
                  >
                    {new Date(day.dayStart).getDate()}
                  </p>
                  <p className="h-4 text-[11px] tabular-nums text-muted-foreground">
                    {formatHours(day.totalMs) && `${formatHours(day.totalMs)}h`}
                  </p>
                </div>
              );
            })}
          </div>

          <div className="relative grid" style={{ ...gridTemplate, height: 24 * HOUR_PX }}>
            <div className="relative">
              {hours.slice(1).map((hour) => (
                <span
                  key={hour}
                  className="absolute right-2 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground"
                  style={{ top: hour * HOUR_PX }}
                >
                  {hourFormat.format(new Date(2000, 0, 1, hour))}
                </span>
              ))}
            </div>
            {days.map((day) => {
              const weekday = new Date(day.dayStart).getDay();
              const isWeekend = weekday === 0 || weekday === 6;
              const showNow = now >= day.dayStart && now < day.dayEnd;
              return (
                <div
                  key={day.dayStart}
                  className={`relative border-l ${isWeekend ? "bg-muted/30" : ""}`}
                >
                  {hours.slice(1).map((hour) => (
                    <div
                      key={hour}
                      aria-hidden
                      className="absolute inset-x-0 border-t border-border/60"
                      style={{ top: hour * HOUR_PX }}
                    />
                  ))}
                  {day.segments.map((segment) => {
                    const { entry } = segment;
                    const color = projects.get(entry.projectId)?.color ?? OTHER_COLOR;
                    const height = ((segment.bottom - segment.top) / 60) * HOUR_PX - 2;
                    const lane = 100 / segment.lanes;
                    const isActive = popover?.entry === entry;
                    const style: CSSProperties = {
                      borderLeftColor: color,
                      backgroundColor: `color-mix(in oklab, ${color} ${isActive ? 30 : 18}%, transparent)`,
                      top: (segment.top / 60) * HOUR_PX + 1,
                      height,
                      left: `calc(${segment.lane * lane}% + 2px)`,
                      width: `calc(${segment.span * lane}% - 4px)`,
                    };
                    return (
                      <button
                        key={`${entry.key}:${entry.start}`}
                        type="button"
                        style={style}
                        onClick={(event) => activate(entry, event.currentTarget)}
                        onMouseEnter={(event) => preview(entry, event.currentTarget)}
                        onMouseLeave={() => {
                          if (!pinned) setPopover(null);
                        }}
                        onFocus={(event) => preview(entry, event.currentTarget)}
                        onBlur={() => {
                          if (!pinned) setPopover(null);
                        }}
                        aria-label={`${entry.title}, ${entry.detail}, ${longDayFormat.format(entry.start)} ${formatSpan(entry.start, entry.end)}`}
                        className="absolute z-10 overflow-hidden rounded-[4px] border-l-[3px] px-1.5 py-0.5 text-left text-[11px] leading-tight text-foreground transition-colors focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <span className="flex items-center gap-1">
                          {entry.ongoing && <RunningDot />}
                          <span className="truncate font-medium">{entry.title}</span>
                        </span>
                        {height >= 30 && (
                          <span className="block truncate tabular-nums text-muted-foreground">
                            {formatSpan(entry.start, entry.end)}
                          </span>
                        )}
                        {height >= 44 && (
                          <span className="block truncate text-muted-foreground">
                            {entry.detail}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {showNow && (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 z-20 h-0.5 bg-primary"
                      style={{ top: (wallMinutes(now, day.dayStart) / 60) * HOUR_PX }}
                    >
                      <span className="absolute -left-1 -top-1 size-2.5 rounded-full bg-primary" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {popover && (
        <EntryPopover
          popover={popover}
          grouping={grouping}
          threads={threads}
          projects={projects}
          onOpen={onOpen}
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Time sheet view

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function TimesheetView({
  activity,
  weekStart,
  projects,
  now,
  onOpen,
}: {
  activity: Activity;
  weekStart: number;
  projects: Map<string, ProjectStyle>;
  now: number;
  onOpen: (threadId: string) => void;
}) {
  const boundaries = useMemo(() => dayBoundaries(weekStart, 7), [weekStart]);
  const rows = useMemo(
    () => buildTimesheet(activity.blocks, boundaries),
    [activity.blocks, boundaries],
  );
  const threads = useMemo(
    () => new Map(activity.threads.map((thread) => [thread.id, thread])),
    [activity.threads],
  );
  const ongoing = useMemo(
    () => new Set(activity.blocks.filter((block) => block.ongoing).map((block) => block.threadId)),
    [activity.blocks],
  );
  const groups = useMemo(() => {
    const byProject = new Map<string, TimesheetRow[]>();
    for (const row of rows) {
      const projectId = threads.get(row.threadId)?.projectId ?? "";
      byProject.set(projectId, [...(byProject.get(projectId) ?? []), row]);
    }
    return [...byProject.entries()]
      .map(([projectId, projectRows]) => ({
        project: projects.get(projectId),
        projectId,
        rows: projectRows,
        dayMs: boundaries
          .slice(0, -1)
          .map((_, day) => projectRows.reduce((sum, row) => sum + row.dayMs[day]!, 0)),
        totalMs: projectRows.reduce((sum, row) => sum + row.totalMs, 0),
      }))
      .sort((a, b) => (a.project?.order ?? Infinity) - (b.project?.order ?? Infinity));
  }, [rows, threads, projects, boundaries]);
  const dayTotals = boundaries
    .slice(0, -1)
    .map((_, day) => rows.reduce((sum, row) => sum + row.dayMs[day]!, 0));
  const total = dayTotals.reduce((sum, ms) => sum + ms, 0);
  const today = startOfDay(now);
  const dayStarts = boundaries.slice(0, -1);
  const [copied, setCopied] = useState(false);

  const copyCsv = async () => {
    const header = [
      "Project",
      "Thread",
      "Thread ID",
      ...dayStarts.map((t) => longDayFormat.format(t)),
      "Total",
    ];
    const lines = [header];
    for (const group of groups) {
      for (const row of group.rows) {
        lines.push([
          group.project?.name ?? group.projectId,
          threads.get(row.threadId)?.title ?? row.threadId,
          row.threadId,
          ...row.dayMs.map((ms) => formatHours(ms) || "0"),
          formatHours(row.totalMs) || "0",
        ]);
      }
    }
    try {
      await navigator.clipboard.writeText(
        lines.map((line) => line.map(csvCell).join(",")).join("\n"),
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };

  const dayCell = (ms: number, dayStart: number, className = "") => (
    <td
      key={dayStart}
      className={`px-3 py-1.5 text-right tabular-nums ${dayStart === today ? "bg-primary/5" : ""} ${className}`}
    >
      {formatHours(ms) || <span className="text-muted-foreground/50">–</span>}
    </td>
  );

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-card">
      <table className="w-full min-w-[46rem] border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">Thread</th>
            {dayStarts.map((dayStart) => (
              <th
                key={dayStart}
                className={`w-[4.5rem] px-3 py-2 text-right font-medium ${dayStart === today ? "bg-primary/5 text-foreground" : ""}`}
              >
                {weekdayFormat.format(dayStart)} {new Date(dayStart).getDate()}
              </th>
            ))}
            <th className="w-20 px-3 py-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <GroupRows
              key={group.projectId}
              group={group}
              dayStarts={dayStarts}
              threads={threads}
              ongoing={ongoing}
              dayCell={dayCell}
              onOpen={onOpen}
            />
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t font-semibold">
            <td className="px-3 py-2">Total</td>
            {dayTotals.map((ms, day) => dayCell(ms, dayStarts[day]!, "py-2"))}
            <td className="px-3 py-2 text-right tabular-nums">{formatHours(total) || "0"}</td>
          </tr>
        </tfoot>
      </table>
      <div className="flex items-center justify-between gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
        <p>Decimal hours of calendar time per thread and day.</p>
        <button
          type="button"
          onClick={() => void copyCsv()}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-foreground transition-colors hover:bg-muted"
        >
          <Icon name={copied ? "Check" : "Copy"} className="size-3.5" aria-hidden />
          {copied ? "Copied" : "Copy as CSV"}
        </button>
      </div>
    </div>
  );
}

function GroupRows({
  group,
  dayStarts,
  threads,
  ongoing,
  dayCell,
  onOpen,
}: {
  group: {
    project: ProjectStyle | undefined;
    projectId: string;
    rows: TimesheetRow[];
    dayMs: number[];
    totalMs: number;
  };
  dayStarts: number[];
  threads: Map<string, ActivityThread>;
  ongoing: Set<string>;
  dayCell: (ms: number, dayStart: number, className?: string) => ReactNode;
  onOpen: (threadId: string) => void;
}) {
  return (
    <>
      <tr className="border-b bg-muted/40 font-medium">
        <td className="px-3 py-1.5">
          <span className="flex items-center gap-2">
            <Swatch color={group.project?.color ?? OTHER_COLOR} />
            {group.project?.name ?? "Unknown project"}
          </span>
        </td>
        {group.dayMs.map((ms, day) => dayCell(ms, dayStarts[day]!))}
        <td className="px-3 py-1.5 text-right tabular-nums">{formatHours(group.totalMs)}</td>
      </tr>
      {group.rows.map((row) => {
        const thread = threads.get(row.threadId);
        return (
          <tr key={row.threadId} className="border-b border-border/60 hover:bg-muted/30">
            <td className="max-w-0 py-1.5 pl-7 pr-3">
              <button
                type="button"
                onClick={() => onOpen(row.threadId)}
                title={`${thread?.title ?? row.threadId} · ${formatDuration(row.activeMs) || "<1m"} of agent turns`}
                className="flex w-full min-w-0 items-center gap-1.5 text-left hover:underline"
              >
                {ongoing.has(row.threadId) && <RunningDot />}
                <span className="truncate">{thread?.title ?? row.threadId}</span>
                {thread?.archived && (
                  <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground">
                    archived
                  </span>
                )}
              </button>
            </td>
            {row.dayMs.map((ms, day) => dayCell(ms, dayStarts[day]!))}
            <td className="px-3 py-1.5 text-right font-medium tabular-nums">
              {formatHours(row.totalMs)}
            </td>
          </tr>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Page

const VIEW_OPTIONS = [
  { value: "calendar", label: "Calendar" },
  { value: "timesheet", label: "Time sheet" },
] as const;

const GROUPING_OPTIONS = [
  { value: "project", label: "Projects" },
  { value: "thread", label: "Threads" },
] as const;

const GAP_OPTIONS = MERGE_GAP_MINUTES.map((minutes) => ({
  value: minutes,
  label: minutes < 60 ? `${minutes}m` : `${minutes / 60}h`,
}));

function AgentCalendarPage() {
  const navigate = useBbNavigate();
  const now = useNow(60_000);
  const [weekStart, setWeekStart] = useState(() => startOfWeek(Date.now()));
  const [view, setView] = useState<View>(() =>
    readStored<View>(
      VIEW_STORAGE_KEY,
      (value) => (value === "calendar" || value === "timesheet" ? value : null),
      "calendar",
    ),
  );
  const [gap, setGap] = useState<MergeGapMinutes>(() =>
    readStored<MergeGapMinutes>(
      GAP_STORAGE_KEY,
      (value) => {
        const minutes = Number(value);
        return isMergeGapMinutes(minutes) ? minutes : null;
      },
      DEFAULT_MERGE_GAP_MINUTES,
    ),
  );
  const [grouping, setGrouping] = useState<Grouping>(() =>
    readStored<Grouping>(
      GROUPING_STORAGE_KEY,
      (value) => (value === "project" || value === "thread" ? value : null),
      "project",
    ),
  );
  const weekEnd = addDays(weekStart, 7);
  const { data, isStale, error } = useActivity(weekStart, weekEnd, gap);
  const projects = useProjectStyles(data);
  const isCurrentWeek = weekStart === startOfWeek(now);
  const openThread = useCallback((threadId: string) => navigate.toThread(threadId), [navigate]);
  const weekLabel = rangeFormat.formatRange(weekStart, addDays(weekStart, 6));

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3 px-4 pb-4 pt-3 md:px-5 md:pt-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1">
          <IconButton
            icon="ChevronLeft"
            label="Previous week"
            onClick={() => setWeekStart((start) => addDays(start, -7))}
          />
          <button
            type="button"
            disabled={isCurrentWeek}
            onClick={() => setWeekStart(startOfWeek(Date.now()))}
            className="rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent"
          >
            This week
          </button>
          <IconButton
            icon="ChevronRight"
            label="Next week"
            onClick={() => setWeekStart((start) => addDays(start, 7))}
          />
        </div>
        <h1 className="text-sm font-semibold">{weekLabel}</h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {view === "calendar" && (
            <Segmented
              label="Group by"
              title="One entry per project, or one per thread"
              value={grouping}
              options={GROUPING_OPTIONS}
              onChange={(next) => {
                setGrouping(next);
                store(GROUPING_STORAGE_KEY, next);
              }}
            />
          )}
          <Segmented
            label="Merge idle gaps up to"
            title="Work separated by at most this much idle time becomes one block"
            value={gap}
            options={GAP_OPTIONS}
            onChange={(next) => {
              setGap(next);
              store(GAP_STORAGE_KEY, String(next));
            }}
          />
          <Segmented
            label="View"
            value={view}
            options={VIEW_OPTIONS}
            onChange={(next) => {
              setView(next);
              store(VIEW_STORAGE_KEY, next);
            }}
          />
        </div>
      </header>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {data ? `Refresh failed: ${error}` : error}
        </p>
      )}

      {!data ? (
        !error && <EmptyState>Reading thread history…</EmptyState>
      ) : (
        <div
          className={`flex min-h-0 flex-1 flex-col gap-3 transition-opacity duration-200 ${isStale ? "opacity-60" : ""}`}
        >
          <Summary activity={data} />
          {data.blocks.length === 0 ? (
            <EmptyState>
              No agent activity {isCurrentWeek ? "this week yet" : "this week"}. Blocks appear while
              threads are working.
            </EmptyState>
          ) : (
            <>
              <Legend activity={data} projects={projects} />
              {view === "calendar" ? (
                <CalendarView
                  activity={data}
                  grouping={grouping}
                  gap={gap}
                  weekStart={weekStart}
                  projects={projects}
                  now={now}
                  onOpen={openThread}
                />
              ) : (
                <TimesheetView
                  activity={data}
                  weekStart={weekStart}
                  projects={projects}
                  now={now}
                  onOpen={openThread}
                />
              )}
            </>
          )}
          <p className="text-xs text-muted-foreground">
            Work separated by up to {GAP_OPTIONS.find((option) => option.value === gap)?.label} of
            idle time shares one block, rounded out to quarter hours.
            {view === "calendar" && grouping === "project"
              ? " Hours count each thread, so parallel agents add up."
              : ""}
          </p>
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "agent-calendar",
    title: "Agent Calendar",
    icon: "CalendarDays",
    path: "calendar",
    component: AgentCalendarPage,
  });
});
