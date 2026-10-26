import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import {
  experimental_copyToClipboard,
  experimental_saveFile,
  UrlLink,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { isToolCall, laneBreakdown, turnStats, waitsOnUser, type Segment } from "./breakdown.js";
import { BackLink } from "./overview.js";
import type { rpcContract } from "./server.js";
import type { Back, Target } from "./thread-trace.js";
import { formatDuration, formatTokens } from "./trace.js";
import {
  BreakdownBar,
  Menu,
  OpenInPageButton,
  PanelLayout,
  PromptText,
  Stats,
  StatusDot,
  ToolButton,
  useColors,
} from "./ui.js";
import { errorMessage, plural } from "./util.js";
import {
  clampWindow,
  fitRange,
  formatTick,
  fullWindow,
  isFull,
  panBy,
  ticksFor,
  zoomAt,
  type TimeWindow,
} from "./view.js";

type Trace = PluginRpcResult<(typeof rpcContract)["trace"]>;
type TurnSummary = Trace["turns"][number];
export type Focus = NonNullable<Trace["focus"]>;
type SpanRow = Focus["spans"][number];
type SpanDetails = PluginRpcResult<(typeof rpcContract)["span"]>;

interface Row {
  span: SpanRow;
  depth: number;
  childCount: number;
  open: boolean;
}

const NAME_WIDTH_KEY = "trace-waterfall.name-width";
const DEFAULT_NAME_WIDTH = 240;
const MIN_NAME_WIDTH = 140;
const MAX_NAME_WIDTH = 520;
const SLOW_MS = 1_000;
const BUTTON_ZOOM = 0.5;
const WHEEL_ZOOM_RATE = 0.0025;
const DRAG_THRESHOLD_PX = 3;
const STATUS_MESSAGE_MS = 4_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** bb's own message link: the chat scrolls to `#msg=` on arrival. */
function messageLink(projectId: string, threadId: string, seq: number): string {
  const thread =
    projectId === "proj_personal"
      ? `/threads/${threadId}`
      : `/projects/${projectId}/threads/${threadId}`;
  return `${thread}#msg=${seq}`;
}

const isLane = (span: SpanRow) => span.kind === "subagent" || span.kind === "thread";
/** The id of the thread a top-level child-thread row stands for. */
const childThreadOf = (span: SpanRow) =>
  span.kind === "thread" && !span.id.includes("/") ? span.id.slice("thread:".length) : null;

/**
 * The text a row shows after the span's name: a command without its program,
 * so `git` is not said twice, and nothing for a subagent beyond being one.
 */
function rowDetail(span: SpanRow): string {
  if (span.kind === "subagent") return span.background ? "background" : "";
  return span.kind === "command" && span.detail.startsWith(`${span.name} `)
    ? span.detail.slice(span.name.length + 1)
    : span.detail;
}

/**
 * Rows in display order. While filtering, a subagent or child thread shows
 * when it or any of its spans match, and opens to show the matching ones.
 */
function buildRows(
  children: ReadonlyMap<string | null, SpanRow[]>,
  lane: string | null,
  depth: number,
  expanded: ReadonlySet<string>,
  matches: ((span: SpanRow) => boolean) | null,
): Row[] {
  const rows: Row[] = [];
  for (const span of children.get(lane) ?? []) {
    const childCount = isLane(span) ? (children.get(span.id)?.length ?? 0) : 0;
    const wantsChildren = childCount > 0 && (matches !== null || expanded.has(span.id));
    const nested = wantsChildren ? buildRows(children, span.id, depth + 1, expanded, matches) : [];
    if (matches && !matches(span) && nested.length === 0) continue;
    const open = nested.length > 0;
    rows.push({ span, depth, childCount, open }, ...nested);
  }
  return rows;
}

function useNameWidth() {
  const [width, setWidth] = useState(() => {
    const stored = Number(globalThis.localStorage?.getItem(NAME_WIDTH_KEY));
    return stored >= MIN_NAME_WIDTH && stored <= MAX_NAME_WIDTH ? stored : DEFAULT_NAME_WIDTH;
  });
  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(NAME_WIDTH_KEY, String(width));
    } catch {
      // Storage can be unavailable; the width just resets next time.
    }
  }, [width]);
  return [width, setWidth] as const;
}

/** A status line for an action that finished, cleared after a few seconds. */
function useStatusMessage() {
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), STATUS_MESSAGE_MS);
    return () => window.clearTimeout(timer);
  }, [message]);
  return [message, setMessage] as const;
}

/** Copy, download, or send a turn as OpenTelemetry, or save it as a standalone page. */
function ExportMenu({
  threadId,
  turnId,
  onStatus,
}: {
  threadId: string;
  turnId: string;
  onStatus: (message: { text: string; error: boolean }) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [endpoint, setEndpoint] = useState(false);
  useEffect(() => {
    rpc.call("exportConfig", {}).then(
      (config) => setEndpoint(config.endpointConfigured),
      () => setEndpoint(false),
    );
  }, [rpc]);
  const run = (task: () => Promise<string>) => {
    task().then(
      (text) => onStatus({ text, error: false }),
      (cause) => onStatus({ text: errorMessage(cause), error: true }),
    );
  };
  const exported = (format: "otlp" | "html") =>
    rpc.call("exportTurn", { threadId, turnId, format });
  const download = (format: "otlp" | "html") =>
    run(async () => {
      const file = await exported(format);
      const outcome = await experimental_saveFile({
        fileName: file.fileName,
        blob: new Blob([file.content], { type: file.mimeType }),
      });
      return outcome === "started" ? `Saved ${file.fileName}` : "Could not start the download";
    });
  return (
    <Menu
      label="Export"
      items={[
        {
          label: "Copy as OpenTelemetry JSON",
          onSelect: () =>
            run(async () => {
              const file = await exported("otlp");
              return (await experimental_copyToClipboard({ text: file.content }))
                ? "Copied the OTLP/JSON"
                : "Could not copy";
            }),
        },
        { label: "Download OpenTelemetry JSON", onSelect: () => download("otlp") },
        { label: "Download HTML snapshot", onSelect: () => download("html") },
        {
          label: "Send to OTLP endpoint",
          disabled: !endpoint,
          hint: endpoint
            ? undefined
            : "Set the OTLP endpoint in Settings → Plugins → Trace Waterfall",
          onSelect: () =>
            run(async () => {
              const result = await rpc.call("sendTurn", { threadId, turnId });
              if (!result.ok) throw new Error(result.message);
              return result.message;
            }),
        },
      ]}
    />
  );
}

export function TurnView({
  threadId,
  projectId,
  summary,
  focus,
  now,
  notice,
  back,
  initialSpanId,
  onBack,
  onPrevious,
  onNext,
  liveTurn,
  onOpenThread,
}: {
  threadId: string;
  projectId: string | null;
  summary: TurnSummary;
  focus: Focus | null;
  now: number;
  notice: string | null;
  back: Back | null;
  initialSpanId: string | undefined;
  onBack: (() => void) | null;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  /** A newer turn that is running, so the view never jumps to it on its own. */
  liveTurn: { index: number; open: () => void } | null;
  onOpenThread: (target: Omit<Target, "fromTitle">) => void;
}) {
  const [status, setStatus] = useStatusMessage();
  const header = (
    <>
      <BackLink back={back} />
      {notice ? <p className="text-xs text-destructive">{notice}</p> : null}
      <div className="flex min-w-0 items-center gap-1.5">
        {onBack ? (
          <ToolButton onClick={onBack} title="All turns">
            ← All turns
          </ToolButton>
        ) : null}
        <ToolButton onClick={() => onPrevious?.()} disabled={!onPrevious} title="Previous turn">
          ‹
        </ToolButton>
        <ToolButton onClick={() => onNext?.()} disabled={!onNext} title="Next turn">
          ›
        </ToolButton>
        <span className="ml-1 shrink-0 text-xs tabular-nums text-muted-foreground">
          Turn #{summary.index}
        </span>
        <StatusDot status={summary.status} />
        <PromptText prompt={summary.prompt} sender={summary.sender} />
        <span className="ml-auto" />
        {liveTurn ? (
          <button
            type="button"
            onClick={liveTurn.open}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <StatusDot status="running" />
            Turn #{liveTurn.index} is running
          </button>
        ) : null}
        <ExportMenu threadId={threadId} turnId={summary.id} onStatus={setStatus} />
        <OpenInPageButton />
      </div>
      {status ? (
        <p
          className={`-mt-1 text-xs ${status.error ? "text-destructive" : "text-muted-foreground"}`}
        >
          {status.text}
        </p>
      ) : null}
    </>
  );
  if (!focus) {
    return (
      <PanelLayout header={header}>
        <p className="px-3 text-xs text-muted-foreground">Reading the turn…</p>
      </PanelLayout>
    );
  }
  return (
    <Waterfall
      key={focus.id}
      threadId={threadId}
      projectId={projectId}
      focus={focus}
      now={now}
      header={header}
      initialSpanId={initialSpanId}
      onOpenThread={onOpenThread}
    />
  );
}

function Waterfall({
  threadId,
  projectId,
  focus,
  now,
  header,
  initialSpanId,
  onOpenThread,
}: {
  threadId: string;
  projectId: string | null;
  focus: Focus;
  now: number;
  header: ReactNode;
  initialSpanId: string | undefined;
  onOpenThread: (target: Omit<Target, "fromTitle">) => void;
}) {
  const colors = useColors();
  const [zoom, setZoom] = useState<TimeWindow | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialSpanId ?? null);
  // Open the lanes around a span opened from elsewhere, so it is in view.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    const open = new Set<string>();
    let parent = focus.spans.find((span) => span.id === initialSpanId)?.parentId ?? null;
    while (parent) {
      open.add(parent);
      parent = focus.spans.find((span) => span.id === parent)?.parentId ?? null;
    }
    return open;
  });
  const [query, setQuery] = useState("");
  const [slowOnly, setSlowOnly] = useState(false);
  const [nameWidth, setNameWidth] = useNameWidth();
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const running = focus.end === null;
  const start = focus.start;
  // The turn sets the scale; work that outlived it points past the edge.
  const total = Math.max(1, (focus.end ?? now) - start);
  const view = zoom ? clampWindow(zoom, total) : fullWindow(total);
  const zoomed = !isFull(view, total);
  const showWindow = (next: TimeWindow) => setZoom(isFull(next, total) ? null : next);

  // The wheel listener lives outside React's render cycle, so it reads these.
  const live = useRef({ view, total });
  live.current = { view, total };

  const children = useMemo(() => {
    const byParent = new Map<string | null, SpanRow[]>();
    for (const span of focus.spans) {
      const list = byParent.get(span.parentId) ?? [];
      list.push(span);
      byParent.set(span.parentId, list);
    }
    return byParent;
  }, [focus.spans]);

  const needle = query.trim().toLowerCase();
  const filtering = needle !== "" || slowOnly;
  const rows = useMemo(() => {
    const matches = filtering
      ? (span: SpanRow) =>
          (!needle || `${span.name} ${span.detail}`.toLowerCase().includes(needle)) &&
          (!slowOnly || isLane(span) || span.end === null || span.end - span.start >= SLOW_MS)
      : null;
    return buildRows(children, null, 1, expanded, matches);
  }, [children, expanded, filtering, needle, slowOnly]);

  const stats = turnStats(focus, now);
  // Child threads' calls count in their own trace, as in the Tool calls stat.
  const ownCall = (span: SpanRow) => isToolCall(span) && !span.parentId?.startsWith("thread:");
  const calls = focus.spans.filter(ownCall).length;
  const shownCalls = rows.filter((row) => ownCall(row.span)).length;
  const slowest = focus.spans.reduce<SpanRow | null>((best, span) => {
    if (!isToolCall(span) || span.background || span.end === null) return best;
    if (span.parentId?.startsWith("thread:") || waitsOnUser(span, focus.spans, now)) return best;
    return !best || span.end - span.start > best.end! - best.start ? span : best;
  }, null);
  const selected = selectedId ? (focus.spans.find((span) => span.id === selectedId) ?? null) : null;

  const zoomToSpan = (span: SpanRow) =>
    showWindow(fitRange(span.start - start, (span.end ?? now) - start, total));
  const toggle = (spanId: string, open: boolean) => {
    const next = new Set(expanded);
    if (open) next.add(spanId);
    else next.delete(spanId);
    setExpanded(next);
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const track = trackRef.current?.getBoundingClientRect();
      if (!track || track.width <= 0) return;
      const { view: current, total: span } = live.current;
      const scale = event.deltaMode === 1 ? 16 : 1;
      const commit = (next: TimeWindow) => {
        // Several wheel events can land before the next render; chain them.
        live.current = { view: next, total: span };
        setZoom(isFull(next, span) ? null : next);
      };
      // Trackpad pinches arrive as ctrl + wheel.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const anchor = clamp((event.clientX - track.left) / track.width, 0, 1);
        commit(zoomAt(current, span, anchor, Math.exp(event.deltaY * scale * WHEEL_ZOOM_RATE)));
        return;
      }
      const sideways = event.shiftKey
        ? event.deltaY || event.deltaX
        : Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : 0;
      if (!sideways || isFull(current, span)) return;
      event.preventDefault();
      commit(
        panBy(current, span, ((sideways * scale) / track.width) * (current.to - current.from)),
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const row = scrollRef.current?.querySelector(`[data-row-id="${CSS.escape(selectedId)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const index = rows.findIndex((row) => row.span.id === selectedId);
    const row = index >= 0 ? rows[index] : null;
    const handled = (() => {
      switch (event.key) {
        case "ArrowDown":
          setSelectedId(rows[Math.min(index + 1, rows.length - 1)]?.span.id ?? null);
          return true;
        case "ArrowUp":
          setSelectedId(rows[Math.max(index - 1, 0)]?.span.id ?? null);
          return true;
        case "ArrowRight":
          if (row && row.childCount > 0 && !row.open && !filtering) toggle(row.span.id, true);
          return true;
        case "ArrowLeft":
          if (row?.open && !filtering) toggle(row.span.id, false);
          else if (row?.span.parentId) setSelectedId(row.span.parentId);
          return true;
        case "Enter":
          if (row) zoomToSpan(row.span);
          return true;
        case "+":
        case "=":
          showWindow(zoomAt(view, total, 0.5, BUTTON_ZOOM));
          return true;
        case "-":
          showWindow(zoomAt(view, total, 0.5, 1 / BUTTON_ZOOM));
          return true;
        case "0":
          setZoom(null);
          return true;
        case "Escape":
          if (selectedId) setSelectedId(null);
          else if (zoomed) setZoom(null);
          else return false;
          return true;
        default:
          return false;
      }
    })();
    if (handled) event.preventDefault();
  };

  const xo = (offset: number) => ((offset - view.from) / (view.to - view.from)) * 100;
  const { step, ticks } = ticksFor(view);

  const gridLines = (
    <>
      {ticks.map((tick) => (
        <span
          key={tick}
          className="absolute inset-y-0 border-l border-dashed border-border opacity-60"
          style={{ left: `${xo(tick)}%` }}
        />
      ))}
      {running ? (
        <span
          className="absolute inset-y-0 border-l border-primary"
          style={{ left: `${xo(now - start)}%` }}
        />
      ) : null}
    </>
  );

  /** What the span's own bar looks like, by kind. */
  const barColor = (span: SpanRow): { background: string; opacity: number } => {
    if (span.status === "failed" || span.kind === "error")
      return { background: colors.failed, opacity: 0.9 };
    if (span.kind === "waiting") return { background: colors.phases.waiting, opacity: 0.85 };
    if (span.kind === "compaction") return { background: colors.phases.compaction, opacity: 0.85 };
    if (span.kind === "startup") return { background: colors.phases.startup, opacity: 0.85 };
    return { background: colors.phases.tools, opacity: span.background ? 0.4 : 0.85 };
  };

  /** A lane's time by phase, or for a child thread, its calls; on any timeline scale. */
  const segments = (lane: SpanRow | null, x: (offset: number) => number) => {
    if (lane?.kind === "thread") {
      return (children.get(lane.id) ?? []).map((span) => {
        const left = x(span.start - start);
        const right = x((span.end ?? now) - start);
        return (
          <span
            key={span.id}
            className="absolute top-[7px] h-2.5"
            style={{ left: `${left}%`, width: `max(1px, ${right - left}%)`, ...barColor(span) }}
          />
        );
      });
    }
    return laneBreakdown(focus, lane?.id ?? null, now).segments.map((segment: Segment) => (
      <span
        key={`${segment.phase}-${segment.start}`}
        className="absolute top-[7px] h-2.5"
        style={{
          left: `${x(segment.start - start)}%`,
          width: `${x(segment.end - start) - x(segment.start - start)}%`,
          background:
            segment.phase === "subagents"
              ? "var(--muted-foreground)"
              : colors.phases[segment.phase],
          opacity: segment.phase === "subagents" ? 0.3 : 0.8,
        }}
      />
    ));
  };

  /** A span's duration beside its bar, or pinned to the edge it went past. */
  const label = (from: number, to: number, content: ReactNode) => {
    const left = xo(from);
    const right = xo(to);
    const offLeft = right < 0;
    const offRight = left > 100;
    const inside = !offLeft && !offRight && right > 72 && left < 25;
    const position = offLeft
      ? { left: "4px" }
      : offRight
        ? { right: "4px" }
        : right <= 72
          ? { left: `calc(${right}% + 6px)` }
          : left >= 25
            ? { right: `calc(${100 - left}% + 6px)` }
            : { left: `calc(${Math.max(left, 0)}% + 4px)` };
    return (
      <span
        className={`pointer-events-none absolute top-[3px] whitespace-nowrap text-[11px] tabular-nums text-muted-foreground ${
          inside || offLeft || offRight ? "rounded bg-background/85 px-1" : ""
        }`}
        style={position}
      >
        {offLeft ? "← " : null}
        {content}
        {offRight ? " →" : null}
      </span>
    );
  };

  const columns = { gridTemplateColumns: `${nameWidth}px minmax(0, 1fr)` };

  const spanRow = ({ span, depth, childCount, open }: Row) => {
    const from = span.start - start;
    const to = (span.end ?? now) - start;
    const isSelected = span.id === selectedId;
    const bar = isLane(span) ? (
      <>
        <span
          className={`absolute top-[6px] box-border h-3 rounded-[3px] border bg-muted ${
            span.kind === "thread"
              ? "border-dashed border-muted-foreground/70"
              : "border-muted-foreground/50"
          }`}
          style={{ left: `${xo(from)}%`, width: `${xo(to) - xo(from)}%` }}
        />
        {open ? null : segments(span, xo)}
      </>
    ) : (
      <span
        className={`absolute top-[7px] h-2.5 rounded-[3px] ${span.end === null ? "animate-pulse" : ""}`}
        style={{
          left: `${xo(from)}%`,
          width: span.kind === "error" ? "3px" : `max(2px, ${xo(to) - xo(from)}%)`,
          ...barColor(span),
        }}
      />
    );
    const exit = span.exitCode !== null && span.exitCode !== 0 ? ` · exit ${span.exitCode}` : "";
    return (
      <div
        key={span.id}
        data-row-id={span.id}
        aria-selected={isSelected}
        className={`grid h-6 scroll-mt-16 items-center ${isSelected ? "bg-accent" : "hover:bg-muted/60"}`}
        style={columns}
        onClick={() => setSelectedId(span.id)}
        onDoubleClick={() => zoomToSpan(span)}
      >
        <div
          className="flex min-w-0 items-center pr-2 text-[12.5px]"
          style={{ paddingLeft: depth * 14 }}
          title={`${span.name} ${span.detail}`}
        >
          {childCount > 0 ? (
            <button
              type="button"
              aria-label={open ? "Collapse" : "Expand"}
              disabled={filtering}
              className="w-3.5 shrink-0 text-muted-foreground disabled:opacity-50"
              onClick={(event) => {
                event.stopPropagation();
                toggle(span.id, !open);
              }}
            >
              {open ? "▾" : "▸"}
            </button>
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          {span.kind === "thread" ? (
            <span className="mr-1 shrink-0 text-muted-foreground">↳</span>
          ) : null}
          <span
            className={`shrink-0 ${isLane(span) ? "font-medium" : ""} ${span.kind === "error" ? "text-destructive" : ""}`}
          >
            {span.name}
          </span>
          <span className="ml-1.5 truncate text-muted-foreground">{rowDetail(span)}</span>
          {childCount > 0 && !open ? (
            <span className="ml-1.5 shrink-0 rounded bg-muted px-1 text-[10.5px] text-muted-foreground">
              +{childCount}
            </span>
          ) : null}
        </div>
        <div className="relative h-full overflow-hidden border-l border-border">
          {gridLines}
          {bar}
          {label(
            from,
            to,
            <>
              {span.kind === "error" ? span.detail.slice(0, 60) : formatDuration(to - from)}
              {span.tokens !== null ? ` · ${formatTokens(span.tokens)} tok` : ""}
              {exit}
              {span === slowest ? (
                <span className="ml-1.5 rounded-[3px] border border-warning px-1 text-[9px] font-semibold tracking-wider text-warning-text">
                  SLOWEST
                </span>
              ) : null}
            </>,
          )}
        </div>
      </div>
    );
  };

  const fullX = (offset: number) => (offset / total) * 100;

  return (
    <PanelLayout
      header={
        <>
          {header}
          <Stats
            items={[
              { label: "Duration", value: formatDuration(stats.durationMs) },
              { label: "Tool calls", value: String(stats.toolCalls) },
              { label: "Subagents", value: String(stats.subagents) },
              ...(stats.childThreads > 0
                ? [
                    {
                      label: "Threads",
                      value: String(stats.childThreads),
                      hint: "Threads this turn spawned",
                    },
                  ]
                : []),
              ...(stats.subagentTokens !== null
                ? [
                    {
                      label: "Tokens",
                      value: formatTokens(stats.subagentTokens),
                      hint: "Tokens reported by subagents",
                    },
                  ]
                : []),
              { label: "Errors", value: String(stats.errors), alert: stats.errors > 0 },
            ]}
          />
          <BreakdownBar phases={stats.phases} total={stats.durationMs} />
          <div className="flex items-center gap-1.5">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter spans"
              aria-label="Filter spans"
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
            />
            <ToolButton
              pressed={slowOnly}
              onClick={() => setSlowOnly(!slowOnly)}
              title="Only spans that took a second or more"
            >
              ≥ 1s
            </ToolButton>
            <ToolButton
              onClick={() => showWindow(zoomAt(view, total, 0.5, 1 / BUTTON_ZOOM))}
              disabled={!zoomed}
              title="Zoom out (-)"
            >
              −
            </ToolButton>
            <ToolButton
              onClick={() => showWindow(zoomAt(view, total, 0.5, BUTTON_ZOOM))}
              title="Zoom in (+)"
            >
              +
            </ToolButton>
            <ToolButton
              onClick={() => setZoom(null)}
              disabled={!zoomed}
              title="Show the whole turn (0)"
            >
              Fit
            </ToolButton>
          </div>
        </>
      }
      footer={
        selected ? (
          <Details
            key={selected.id}
            threadId={threadId}
            projectId={projectId}
            span={selected}
            start={start}
            now={now}
            parent={
              selected.parentId
                ? (focus.spans.find((span) => span.id === selected.parentId) ?? null)
                : null
            }
            onZoom={() => zoomToSpan(selected)}
            onClose={() => setSelectedId(null)}
            onOpenThread={onOpenThread}
          />
        ) : (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">
            Select a span for its output · drag the minimap or Ctrl/⌘ + scroll to zoom · Shift +
            scroll to pan · ↑↓ to step
          </p>
        )
      }
    >
      <div
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3 outline-none"
      >
        <div className="sticky top-0 z-10 flex flex-col gap-1 bg-sidebar pb-1">
          <Minimap total={total} view={view} zoomed={zoomed} onChange={showWindow}>
            <span
              className="absolute top-[7px] box-border h-3 w-full rounded-[3px] border border-muted-foreground/40"
              style={{ left: 0 }}
            />
            {segments(null, fullX)}
            {running ? (
              <span
                className="absolute inset-y-0 border-l border-primary"
                style={{ left: `${fullX(now - start)}%` }}
              />
            ) : null}
          </Minimap>
          <div className="grid h-5 items-end text-[11px] text-muted-foreground" style={columns}>
            <div className="relative h-full">
              <span className="text-[10px] font-medium uppercase tracking-wider">
                {filtering ? `${shownCalls} of ${plural(calls, "call")}` : "Span"}
              </span>
              <ColumnResizer width={nameWidth} onResize={setNameWidth} />
            </div>
            <div ref={trackRef} className="relative h-full overflow-hidden">
              {/* A label this close to the edge would be cut off; its grid line stays. */}
              {ticks
                .filter((tick) => xo(tick) <= 92)
                .map((tick) => (
                  <span
                    key={tick}
                    className="absolute top-0 whitespace-nowrap pl-1 tabular-nums"
                    style={{ left: `${xo(tick)}%` }}
                  >
                    {formatTick(tick, step)}
                  </span>
                ))}
            </div>
          </div>
        </div>
        <div
          className="grid h-6 items-center"
          style={columns}
          title="The turn's own agent, by phase"
        >
          <div className="flex min-w-0 items-center pr-2 text-[12.5px]">
            <span className="w-3.5 shrink-0" />
            <span className="font-medium">Agent</span>
            <span className="ml-1.5 text-muted-foreground">main</span>
          </div>
          <div className="relative h-full overflow-hidden border-l border-border">
            {gridLines}
            <span
              className="absolute top-[6px] box-border h-3 rounded-[3px] border border-muted-foreground/50 bg-muted"
              style={{ left: `${xo(0)}%`, width: `${xo(total) - xo(0)}%` }}
            />
            {segments(null, xo)}
          </div>
        </div>
        {rows.map(spanRow)}
        {rows.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">No spans match.</p>
        ) : null}
      </div>
    </PanelLayout>
  );
}

/**
 * The whole turn at a glance. Drag across it to pick a range and zoom to it on
 * release, drag the highlighted window to pan, or click to center the window.
 */
function Minimap({
  total,
  view,
  zoomed,
  onChange,
  children,
}: {
  total: number;
  view: TimeWindow;
  zoomed: boolean;
  onChange: (window: TimeWindow) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [brush, setBrush] = useState<TimeWindow | null>(null);
  const drag = useRef<{
    mode: "pan" | "brush";
    originX: number;
    originView: TimeWindow;
    anchor: number;
  } | null>(null);

  const offsetAt = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return clamp((clientX - rect.left) / rect.width, 0, 1) * total;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = offsetAt(event.clientX);
    drag.current = {
      mode: zoomed && at >= view.from && at <= view.to ? "pan" : "brush",
      originX: event.clientX,
      originView: view,
      anchor: at,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    const width = ref.current?.getBoundingClientRect().width ?? 0;
    if (!state || width <= 0) return;
    const dx = event.clientX - state.originX;
    if (state.mode === "pan") {
      onChange(panBy(state.originView, total, (dx / width) * total));
    } else if (Math.abs(dx) > DRAG_THRESHOLD_PX) {
      // Zooming while the range is still a sliver would flash a huge zoom; wait for release.
      const at = offsetAt(event.clientX);
      setBrush({ from: Math.min(state.anchor, at), to: Math.max(state.anchor, at) });
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    drag.current = null;
    setBrush(null);
    if (!state || state.mode !== "brush") return;
    if (brush) onChange(clampWindow(brush, total));
    else if (zoomed && Math.abs(event.clientX - state.originX) <= DRAG_THRESHOLD_PX) {
      onChange(panBy(view, total, state.anchor - (view.from + view.to) / 2));
    }
  };

  const windowLeft = (view.from / total) * 100;
  const windowRight = (view.to / total) * 100;
  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Visible part of the turn"
      aria-valuemin={0}
      aria-valuemax={Math.round(total)}
      aria-valuenow={Math.round(view.from)}
      title="Drag across to zoom into a range · drag the window to pan"
      className={`relative h-7 touch-none select-none overflow-hidden rounded-md border border-border ${zoomed ? "cursor-grab" : "cursor-crosshair"}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        drag.current = null;
        setBrush(null);
      }}
    >
      {children}
      {brush ? (
        <span
          className="absolute inset-y-0 z-10 border-x-2 border-primary/70 bg-primary/15"
          style={{
            left: `${(brush.from / total) * 100}%`,
            width: `${((brush.to - brush.from) / total) * 100}%`,
          }}
        />
      ) : null}
      {zoomed ? (
        <>
          <span
            className="absolute inset-y-0 left-0 bg-background/60"
            style={{ width: `${windowLeft}%` }}
          />
          <span
            className="absolute inset-y-0 right-0 bg-background/60"
            style={{ width: `${100 - windowRight}%` }}
          />
          <span
            className="absolute inset-y-0 rounded-sm border-2 border-primary/70"
            style={{ left: `${windowLeft}%`, width: `${windowRight - windowLeft}%` }}
          />
        </>
      ) : null}
    </div>
  );
}

/** Drag the edge of the name column to make room for longer commands. */
function ColumnResizer({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  const origin = useRef<{ x: number; width: number } | null>(null);
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the span column"
      className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none hover:bg-border"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        origin.current = { x: event.clientX, width };
      }}
      onPointerMove={(event) => {
        if (!origin.current) return;
        const next = origin.current.width + event.clientX - origin.current.x;
        onResize(clamp(Math.round(next), MIN_NAME_WIDTH, MAX_NAME_WIDTH));
      }}
      onPointerUp={() => {
        origin.current = null;
      }}
      onPointerCancel={() => {
        origin.current = null;
      }}
      onDoubleClick={() => onResize(DEFAULT_NAME_WIDTH)}
    />
  );
}

const KIND_LABELS: Record<SpanRow["kind"], string> = {
  command: "Command",
  tool: "Tool call",
  read: "File read",
  edit: "File edit",
  search: "Search",
  web: "Web",
  subagent: "Subagent",
  background: "Background task",
  thread: "Child thread",
  waiting: "Waiting on you",
  compaction: "Compaction",
  startup: "Starting",
  error: "Error",
};

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </span>
      {children}
    </div>
  );
}

const PRE =
  "max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted px-2 py-1.5 font-mono text-[11.5px] text-foreground";

function Details({
  threadId,
  projectId,
  span,
  start,
  now,
  parent,
  onZoom,
  onClose,
  onOpenThread,
}: {
  threadId: string;
  projectId: string | null;
  span: SpanRow;
  start: number;
  now: number;
  parent: SpanRow | null;
  onZoom: () => void;
  onClose: () => void;
  onOpenThread: (target: Omit<Target, "fromTitle">) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [copied, setCopied] = useState(false);
  const [details, setDetails] = useState<SpanDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const childThread = childThreadOf(span);
  const hasOutput = !isLane(span) || span.kind === "subagent";

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  // Output lives in the event that ended the span; read it once it has ended.
  useEffect(() => {
    if (!hasOutput || span.end === null) return;
    let cancelled = false;
    setLoading(true);
    rpc.call("span", { threadId, spanId: span.id }).then(
      (result) => {
        if (cancelled) return;
        setDetails(result);
        setLoading(false);
      },
      () => {
        if (!cancelled) setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, span.id, span.end, hasOutput]);

  const exitCode = details?.exitCode ?? span.exitCode;
  const error = details?.error ?? span.error;
  const facts: Array<[string, string]> = [
    ["Started", `+${formatDuration(span.start - start)}`],
    [
      "Duration",
      formatDuration((span.end ?? now) - span.start) + (span.end === null ? " so far" : ""),
    ],
    ["Status", span.status],
    ...(exitCode !== null ? ([["Exit code", String(exitCode)]] as Array<[string, string]>) : []),
    ...(parent ? ([["Inside", parent.name]] as Array<[string, string]>) : []),
    ...(span.tokens !== null
      ? ([["Tokens", formatTokens(span.tokens)]] as Array<[string, string]>)
      : []),
    ...(span.background ? ([["Runs", "alongside the agent"]] as Array<[string, string]>) : []),
  ];
  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot status={span.status} />
        <span className="truncate font-medium">{span.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{KIND_LABELS[span.kind]}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {childThread ? (
            <>
              <ToolButton
                onClick={() => onOpenThread({ threadId: childThread })}
                title="Show this thread's trace here"
              >
                Open trace
              </ToolButton>
              <ToolButton
                onClick={() => navigate.toThread(childThread, { split: true })}
                title="Open the thread beside this one"
              >
                Open thread
              </ToolButton>
            </>
          ) : null}
          {span.chatSeq !== null && projectId ? (
            <UrlLink
              href={messageLink(projectId, threadId, span.chatSeq)}
              className="flex h-7 items-center rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Jump to the reply that followed this span"
            >
              Show in chat
            </UrlLink>
          ) : null}
          <ToolButton onClick={onZoom} title="Zoom to this span (Enter)">
            Zoom
          </ToolButton>
          {span.detail ? (
            <ToolButton
              onClick={() => {
                void experimental_copyToClipboard({ text: span.detail }).then(setCopied);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </ToolButton>
          ) : null}
          <ToolButton onClick={onClose} title="Close (Esc)">
            ✕
          </ToolButton>
        </span>
      </div>
      {span.detail ? <pre className={PRE}>{span.detail}</pre> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
        {facts.map(([term, value]) => (
          <div key={term} className="flex gap-1.5">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {loading && !details ? (
        <p className="text-xs text-muted-foreground">Reading its output…</p>
      ) : null}
      {details?.summary ? (
        <Block title="Summary">
          <p className="whitespace-pre-wrap text-xs">{details.summary}</p>
        </Block>
      ) : null}
      {details?.output ? (
        <Block title={details.outputTruncated ? "Output · last lines" : "Output"}>
          <pre className={PRE}>{details.output}</pre>
        </Block>
      ) : null}
      {details?.arguments ? (
        <Block title="Arguments">
          <pre className={PRE}>{details.arguments}</pre>
        </Block>
      ) : null}
      {details && details.files.length > 0 ? (
        <Block title="Files">
          <ul className="text-xs">
            {details.files.map((file) => (
              <li key={file.path} className="truncate font-mono text-[11.5px]">
                <span className="text-muted-foreground">{file.kind}</span> {file.path}
              </li>
            ))}
          </ul>
        </Block>
      ) : null}
    </div>
  );
}
