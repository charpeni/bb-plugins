import { useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";

type SystemStats = PluginRpcResult<(typeof rpcContract)["stats"]>;
type SystemHistory = PluginRpcResult<(typeof rpcContract)["history"]>;
type HistoryRange = SystemHistory["range"];
type HistoryPoint = SystemHistory["points"][number];
type MetricKey = "cpuPercent" | "memoryPercent" | "diskPercent";

const HISTORY_RANGES: Array<{ id: HistoryRange; label: string }> = [
  { id: "1d", label: "1D" },
  { id: "7d", label: "7D" },
  { id: "30d", label: "30D" },
];

const RANGE_STORAGE_KEY = "system-monitor.history-range";

const SPARK_HEIGHT = 48;
const SPARK_TOP = 4;
const SPARK_BOTTOM = 4;
const GAP_FACTOR = 2.5;

function loadStoredRange(): HistoryRange {
  try {
    const stored = window.localStorage.getItem(RANGE_STORAGE_KEY);
    if (stored === "1d" || stored === "7d" || stored === "30d") return stored;
  } catch {
    // Storage can be unavailable (private browsing, blocked cookies); fall through.
  }
  return "1d";
}

function storeRange(range: HistoryRange): void {
  try {
    window.localStorage.setItem(RANGE_STORAGE_KEY, range);
  } catch {
    // Best effort only.
  }
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function formatBytesPair(used: number, total: number): string {
  const usedFormatted = formatBytes(used);
  const totalFormatted = formatBytes(total);
  const usedUnit = usedFormatted.split(" ")[1];
  const totalUnit = totalFormatted.split(" ")[1];
  if (usedUnit === totalUnit) return `${usedFormatted.split(" ")[0]} / ${totalFormatted}`;
  return `${usedFormatted} / ${totalFormatted}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", `${minutes}m`]
    .filter(Boolean)
    .join(" ");
}

function formatPointTime(t: number): string {
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function bucketLabel(bucketMs: number): string {
  if (bucketMs < 3_600_000) return `${Math.round(bucketMs / 60_000)}-minute`;
  return `${Math.round(bucketMs / 3_600_000)}-hour`;
}

function useMeasuredWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function CompactStat({
  label,
  value,
  sub,
  title,
}: {
  label: string;
  value: string;
  sub?: string;
  title?: string;
}) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5 shadow-sm" title={title}>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 truncate text-lg font-semibold">{value}</p>
      {sub && <p className="mt-1 truncate text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function RangeToggle({
  value,
  onChange,
}: {
  value: HistoryRange;
  onChange: (next: HistoryRange) => void;
}) {
  return (
    <div
      role="group"
      aria-label="History range"
      className="flex shrink-0 items-center gap-0.5 rounded-lg border bg-surface-recessed p-0.5"
    >
      {HISTORY_RANGES.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={option.id === value}
          onClick={() => onChange(option.id)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            option.id === value
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type ChartHover = { t: number; source: MetricKey } | null;

function Sparkline({
  label,
  metricKey,
  points,
  bucketMs,
  domain,
  hover,
  onHover,
}: {
  label: string;
  metricKey: MetricKey;
  points: HistoryPoint[];
  bucketMs: number;
  domain: [number, number];
  hover: ChartHover;
  onHover: (t: number | null, source: MetricKey) => void;
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  const [domainStart, domainEnd] = domain;
  const x = (t: number) => ((t - domainStart) / (domainEnd - domainStart)) * width;
  const y = (value: number) =>
    SPARK_TOP + (1 - value / 100) * (SPARK_HEIGHT - SPARK_TOP - SPARK_BOTTOM);
  const baselineY = y(0);

  const segments = useMemo(() => {
    const result: HistoryPoint[][] = [];
    let current: HistoryPoint[] = [];
    for (const point of points) {
      const previous = current[current.length - 1];
      if (previous && point.t - previous.t > bucketMs * GAP_FACTOR) {
        result.push(current);
        current = [];
      }
      current.push(point);
    }
    if (current.length > 0) result.push(current);
    return result;
  }, [points, bucketMs]);

  const hoverPoint = hover ? points.find((point) => point.t === hover.t) : undefined;
  const latest = points[points.length - 1];

  function linePath(segment: HistoryPoint[]): string {
    return segment
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"}${x(point.t).toFixed(1)},${y(point[metricKey]).toFixed(1)}`,
      )
      .join(" ");
  }

  function areaPath(segment: HistoryPoint[]): string {
    const first = segment[0];
    const last = segment[segment.length - 1];
    return `${linePath(segment)} L${x(last.t).toFixed(1)},${baselineY} L${x(first.t).toFixed(1)},${baselineY} Z`;
  }

  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (points.length === 0 || width <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const t = domainStart + ((event.clientX - rect.left) / width) * (domainEnd - domainStart);
    let nearest = points[0];
    for (const point of points) {
      if (Math.abs(point.t - t) < Math.abs(nearest.t - t)) nearest = point;
    }
    onHover(nearest.t, metricKey);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (points.length === 0) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = hover ? points.findIndex((point) => point.t === hover.t) : -1;
    const next =
      index === -1
        ? points.length - 1
        : Math.min(points.length - 1, Math.max(0, index + (event.key === "ArrowRight" ? 1 : -1)));
    onHover(points[next].t, metricKey);
  }

  const isTooltipSource = hover?.source === metricKey && hoverPoint !== undefined;
  const tooltipX = hoverPoint ? x(hoverPoint.t) : 0;
  const tooltipOnLeft = tooltipX > width * 0.55;

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="img"
      aria-label={`${label} trend${latest ? `, latest ${latest[metricKey].toFixed(1)}%` : ""}`}
      className="relative rounded-md outline-none focus-visible:ring-2 focus-visible:ring-primary"
      onKeyDown={handleKeyDown}
      onFocus={() => {
        if (latest) onHover(latest.t, metricKey);
      }}
      onBlur={() => onHover(null, metricKey)}
    >
      {width > 0 && (
        <svg
          width={width}
          height={SPARK_HEIGHT}
          className="block"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => onHover(null, metricKey)}
        >
          <line
            x1={0}
            x2={width}
            y1={baselineY}
            y2={baselineY}
            stroke="var(--border)"
            strokeWidth={1}
          />
          {segments.map((segment, index) =>
            segment.length === 1 ? (
              <circle
                key={index}
                cx={x(segment[0].t)}
                cy={y(segment[0][metricKey])}
                r={2.5}
                fill="var(--primary)"
              />
            ) : (
              <g key={index}>
                <path d={areaPath(segment)} fill="var(--primary)" fillOpacity={0.1} />
                <path
                  d={linePath(segment)}
                  fill="none"
                  stroke="var(--primary)"
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            ),
          )}
          {latest && (
            <circle
              cx={x(latest.t)}
              cy={y(latest[metricKey])}
              r={3}
              fill="var(--primary)"
              stroke="var(--card)"
              strokeWidth={2}
            />
          )}
          {hoverPoint && (
            <g>
              <line
                x1={x(hoverPoint.t)}
                x2={x(hoverPoint.t)}
                y1={0}
                y2={baselineY}
                stroke="var(--muted-foreground)"
                strokeOpacity={0.4}
                strokeWidth={1}
              />
              <circle
                cx={x(hoverPoint.t)}
                cy={y(hoverPoint[metricKey])}
                r={3.5}
                fill="var(--primary)"
                stroke="var(--card)"
                strokeWidth={2}
              />
            </g>
          )}
        </svg>
      )}
      {isTooltipSource && hoverPoint && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border bg-card px-2.5 py-1.5 shadow-md"
          style={{
            left: tooltipOnLeft ? tooltipX - 8 : tooltipX + 8,
            top: -4,
            transform: tooltipOnLeft ? "translate(-100%, -100%)" : "translateY(-100%)",
          }}
        >
          <p className="whitespace-nowrap text-[11px] text-muted-foreground">
            {formatPointTime(hoverPoint.t)}
          </p>
          <p className="whitespace-nowrap text-xs">
            <span className="font-semibold tabular-nums">{hoverPoint[metricKey].toFixed(1)}%</span>{" "}
            <span className="text-muted-foreground">{label}</span>
          </p>
        </div>
      )}
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  title,
  metricKey,
  history,
  domain,
  hover,
  onHover,
  emptyNote,
}: {
  label: string;
  value: string;
  detail?: string;
  title?: string;
  metricKey: MetricKey;
  history: SystemHistory | null;
  domain: [number, number] | null;
  hover: ChartHover;
  onHover: (t: number | null, source: MetricKey) => void;
  emptyNote: string;
}) {
  const points = history?.points ?? [];

  const summary = useMemo(() => {
    if (points.length === 0) return null;
    const values = points.map((point) => point[metricKey]);
    const average = values.reduce((sum, current) => sum + current, 0) / values.length;
    const peak = Math.max(...values);
    return { average, peak };
  }, [points, metricKey]);

  return (
    <article className="rounded-xl border bg-card p-4 shadow-sm" title={title}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </h2>
        {detail && <p className="truncate text-xs text-muted-foreground">{detail}</p>}
      </div>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      <div className="mt-3">
        {history && points.length > 0 && domain ? (
          <Sparkline
            label={label}
            metricKey={metricKey}
            points={points}
            bucketMs={history.bucketMs}
            domain={domain}
            hover={hover}
            onHover={onHover}
          />
        ) : (
          <div
            className="flex items-center justify-center rounded-md bg-surface-recessed px-3 text-center text-xs text-muted-foreground"
            style={{ height: SPARK_HEIGHT }}
          >
            {emptyNote}
          </div>
        )}
      </div>
      <p className="mt-2 text-xs tabular-nums text-muted-foreground">
        {summary ? `avg ${summary.average.toFixed(1)}% · max ${summary.peak.toFixed(1)}%` : " "}
      </p>
    </article>
  );
}

function SystemMonitorPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<HistoryRange>(loadStoredRange);
  const [snapshot, setSnapshot] = useState<{ range: HistoryRange; data: SystemHistory } | null>(
    null,
  );
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [hover, setHover] = useState<ChartHover>(null);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const next = await rpc.call("stats", null);
        if (!cancelled) {
          setStats(next);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [rpc]);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const data = await rpc.call("history", { range });
        if (!cancelled) {
          setSnapshot({ range, data });
          setHistoryError(null);
        }
      } catch (cause) {
        if (!cancelled) {
          setHistoryError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [rpc, range]);

  const history = snapshot?.data ?? null;
  const isStale = snapshot !== null && snapshot.range !== range;

  const domain = useMemo<[number, number] | null>(() => {
    if (!history || history.points.length === 0) return null;
    const first = history.points[0];
    const last = history.points[history.points.length - 1];
    const end = last.t + history.bucketMs;
    const fullStart = end - history.windowMs;
    const start = Math.min(first.t > fullStart ? first.t : fullStart, end - history.bucketMs);
    return [start, end];
  }, [history]);

  const emptyNote = historyError
    ? "History unavailable"
    : history && history.points.length === 0
      ? "No history yet"
      : "Loading history...";

  if (!stats) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-sm rounded-xl border bg-card p-6 text-center shadow-sm">
          <div className="mx-auto size-3 animate-pulse rounded-full bg-primary" />
          <p className="mt-4 text-sm font-medium">
            {error ? "Could not read system metrics" : "Sampling system metrics"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {error ?? "Measuring CPU activity over a short interval..."}
          </p>
        </div>
      </div>
    );
  }

  const onHover = (t: number | null, source: MetricKey) =>
    setHover(t === null ? null : { t, source });

  return (
    <div className="h-full overflow-y-auto bg-background">
      <main className="mx-auto w-full max-w-6xl p-4 md:p-6">
        <header className="mb-4 flex flex-col gap-2 pt-12 sm:flex-row sm:items-center sm:justify-between md:pt-0">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-success shadow-[0_0_0_3px_color-mix(in_oklab,var(--success)_18%,transparent)]" />
            <p className="text-sm font-medium">{stats.hostname}</p>
            <p className="text-sm text-muted-foreground">bb server host</p>
          </div>
          <p className="text-xs tabular-nums text-muted-foreground">
            Updated {new Date(stats.sampledAt).toLocaleTimeString()}
            {error ? " / refresh delayed" : " / refreshes every 5s"}
          </p>
        </header>

        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="truncate text-xs text-muted-foreground">
            {history
              ? `Trends: sampled every ${Math.round(history.sampleIntervalMs / 1000)}s, shown as ${bucketLabel(history.bucketMs)} averages`
              : historyError
                ? `Could not load history: ${historyError}`
                : "Trends"}
          </p>
          <RangeToggle
            value={range}
            onChange={(next) => {
              setRange(next);
              storeRange(next);
              setHover(null);
            }}
          />
        </div>

        <section
          className={`grid gap-3 transition-opacity duration-300 md:grid-cols-3 ${isStale ? "opacity-60" : ""}`}
        >
          <MetricCard
            label="CPU"
            value={`${stats.cpu.usagePercent.toFixed(1)}%`}
            detail={`${stats.cpu.logicalCores} cores${stats.cpu.speedMHz === null ? "" : ` · ${(stats.cpu.speedMHz / 1000).toFixed(2)} GHz`}`}
            title={stats.cpu.model}
            metricKey="cpuPercent"
            history={history}
            domain={domain}
            hover={hover}
            onHover={onHover}
            emptyNote={emptyNote}
          />
          <MetricCard
            label="Memory"
            value={`${stats.memory.usedPercent.toFixed(1)}%`}
            detail={formatBytesPair(stats.memory.usedBytes, stats.memory.totalBytes)}
            metricKey="memoryPercent"
            history={history}
            domain={domain}
            hover={hover}
            onHover={onHover}
            emptyNote={emptyNote}
          />
          <MetricCard
            label="Disk"
            value={`${stats.disk.usedPercent.toFixed(1)}%`}
            detail={`${formatBytes(stats.disk.availableBytes)} free`}
            title={stats.disk.path}
            metricKey="diskPercent"
            history={history}
            domain={domain}
            hover={hover}
            onHover={onHover}
            emptyNote={emptyNote}
          />
        </section>

        <section className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <CompactStat
            label="Load"
            value={stats.loadAverage[0].toFixed(2)}
            sub={`5m ${stats.loadAverage[1].toFixed(2)} · 15m ${stats.loadAverage[2].toFixed(2)}`}
          />
          <CompactStat label="Uptime" value={formatUptime(stats.uptimeSeconds)} />
          <CompactStat
            label="System"
            value={`${stats.platform} ${stats.architecture}`}
            sub={stats.release}
          />
        </section>

        {history && history.points.length > 0 && (
          <p className="mt-4 text-xs text-muted-foreground">
            {history.earliestSampledAt !== null
              ? `Collecting since ${formatPointTime(history.earliestSampledAt)}`
              : ""}
            {historyError ? " · latest refresh failed, retrying" : ""}
          </p>
        )}
      </main>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "system-monitor",
    title: "System Monitor",
    icon: "ChartColumn",
    path: "stats",
    component: SystemMonitorPanel,
  });
});
