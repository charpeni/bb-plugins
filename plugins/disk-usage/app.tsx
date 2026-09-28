import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";
import { squarify } from "./treemap.js";

type ScanResult = PluginRpcResult<(typeof rpcContract)["scan"]>;
type ScanEntry = ScanResult["entries"][number];

interface ScanProgress {
  scanId: string | null;
  path: string;
  visitedCount: number;
  totalBytes: number;
  skippedCount: number;
  currentPath: string;
  elapsedMs: number;
}

type ViewMode = "list" | "treemap";

const VIEW_MODES: { id: ViewMode; label: string }[] = [
  { id: "list", label: "List" },
  { id: "treemap", label: "Treemap" },
];

const VIEW_STORAGE_KEY = "disk-usage.view";

// Tiles are inset by half the gap so neighbours sit GAP px apart.
const TILE_GAP = 2;
const TOOLTIP_OFFSET = 12;

function loadStoredView(): ViewMode {
  try {
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (stored === "list" || stored === "treemap") return stored;
  } catch {
    // Storage can be unavailable (private browsing, blocked cookies); fall through.
  }
  return "list";
}

function storeView(view: ViewMode): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Best effort only.
  }
}

function isScanProgress(payload: unknown): payload is ScanProgress {
  if (typeof payload !== "object" || payload === null) return false;
  const candidate = payload as Record<string, unknown>;
  return (
    typeof candidate.path === "string" &&
    typeof candidate.visitedCount === "number" &&
    typeof candidate.totalBytes === "number" &&
    typeof candidate.currentPath === "string"
  );
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

function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(-half)}`;
}

function barTone(share: number): string {
  if (share >= 50) return "bg-destructive";
  if (share >= 25) return "bg-attention";
  return "bg-primary";
}

function breadcrumbsOf(path: string): { label: string; path: string }[] {
  if (path === "/") return [{ label: "/", path: "/" }];
  const segments = path.split("/").filter(Boolean);
  const crumbs = [{ label: "/", path: "/" }];
  let current = "";
  for (const segment of segments) {
    current += `/${segment}`;
    crumbs.push({ label: segment, path: current });
  }
  return crumbs;
}

function ProgressDetails({ progress }: { progress: ScanProgress }) {
  return (
    <>
      <span className="tabular-nums">
        {formatCount(progress.visitedCount)} entries · {formatBytes(progress.totalBytes)} so far ·{" "}
        {(progress.elapsedMs / 1000).toFixed(0)}s
      </span>
      <span className="block truncate text-muted-foreground" title={progress.currentPath}>
        {truncateMiddle(progress.currentPath, 72)}
      </span>
    </>
  );
}

function EntryRow({
  entry,
  totalBytes,
  onOpen,
}: {
  entry: ScanEntry;
  totalBytes: number;
  onOpen: (name: string) => void;
}) {
  const share = totalBytes > 0 ? (entry.bytes / totalBytes) * 100 : 0;
  const isDirectory = entry.kind === "directory";

  return (
    <li className="group relative overflow-hidden rounded-lg border bg-card">
      <div
        className={`absolute inset-y-0 left-0 opacity-[0.12] transition-[width] duration-300 ${barTone(share)}`}
        style={{ width: `${Math.min(100, share)}%` }}
      />
      <div className="relative flex items-center gap-3 px-3 py-2">
        <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {share.toFixed(1)}%
        </span>
        <span className="w-20 shrink-0 text-right text-sm font-medium tabular-nums">
          {formatBytes(entry.bytes)}
        </span>
        {isDirectory ? (
          <button
            type="button"
            onClick={() => onOpen(entry.name)}
            className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline"
          >
            {entry.name}
            <span className="text-muted-foreground">/</span>
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
        )}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {isDirectory
            ? `${formatCount(entry.entryCount)} entries`
            : entry.kind === "other"
              ? "special"
              : ""}
        </span>
      </div>
    </li>
  );
}

function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (next: ViewMode) => void }) {
  return (
    <div
      role="group"
      aria-label="View"
      className="flex shrink-0 items-center gap-0.5 rounded-lg border bg-surface-recessed p-0.5"
    >
      {VIEW_MODES.map((option) => (
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

// "rest" stands in for the entries the server omitted past its return cap, so
// tile areas still add up to the directory total.
type TreemapTile =
  | { key: string; kind: "entry"; entry: ScanEntry; bytes: number }
  | { key: string; kind: "rest"; count: number; bytes: number };

const TILE_TONES: Record<ScanEntry["kind"] | "rest", string> = {
  directory:
    "border-file-accent/35 bg-file-accent/15 hover:bg-file-accent/25 focus-visible:bg-file-accent/25 cursor-pointer",
  file: "border-border bg-muted hover:bg-state-hover focus-visible:bg-state-hover",
  other: "border-border bg-muted hover:bg-state-hover focus-visible:bg-state-hover",
  rest: "border-dashed border-border bg-surface-recessed",
};

function tileName(tile: TreemapTile): string {
  if (tile.kind === "rest") return `${formatCount(tile.count)} smaller entries`;
  return tile.entry.kind === "directory" ? `${tile.entry.name}/` : tile.entry.name;
}

function tileDetail(tile: TreemapTile): string | null {
  if (tile.kind === "rest") return "Not listed individually";
  if (tile.entry.kind === "directory") return `${formatCount(tile.entry.entryCount)} entries`;
  if (tile.entry.kind === "other") return "Special file";
  return null;
}

function TreemapView({ result, onOpen }: { result: ScanResult; onOpen: (name: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([observed]) => {
      if (!observed) return;
      setSize({ width: observed.contentRect.width, height: observed.contentRect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => setHover(null), [result]);

  const tiles = useMemo(() => {
    const items: { value: number; data: TreemapTile }[] = result.entries.map((entry) => ({
      value: entry.bytes,
      data: { key: `entry:${entry.name}`, kind: "entry", entry, bytes: entry.bytes },
    }));
    const listedBytes = result.entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const restBytes = result.totalBytes - listedBytes;
    if (result.omittedEntryCount > 0 && restBytes > 0) {
      items.push({
        value: restBytes,
        data: { key: "rest", kind: "rest", count: result.omittedEntryCount, bytes: restBytes },
      });
    }
    return squarify(items, size.width, size.height);
  }, [result, size]);

  const emptyCount = result.entries.filter((entry) => entry.bytes === 0).length;
  const hovered = hover ? tiles.find((tile) => tile.data.key === hover.key) : undefined;
  const hasRest = tiles.some((tile) => tile.data.kind === "rest");

  const trackPointer = (key: string, clientX: number, clientY: number) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setHover({ key, x: clientX - bounds.left, y: clientY - bounds.top });
  };

  return (
    <div className="mt-3">
      <div className="rounded-xl border bg-card p-1">
        <div
          ref={containerRef}
          role="group"
          aria-label={`Treemap of ${result.path}`}
          onPointerLeave={() => setHover(null)}
          className="relative h-[min(60vh,32rem)] min-h-64 overflow-hidden"
        >
          {tiles.map(({ x, y, width, height, data: tile }) => {
            const tileWidth = Math.max(0, width - TILE_GAP);
            const tileHeight = Math.max(0, height - TILE_GAP);
            const showName = tileWidth >= 56 && tileHeight >= 24;
            const showSize = showName && tileHeight >= 42;
            const share = result.totalBytes > 0 ? (tile.bytes / result.totalBytes) * 100 : 0;
            const label = `${tileName(tile)}, ${formatBytes(tile.bytes)}, ${share.toFixed(1)}%`;
            const tone = TILE_TONES[tile.kind === "rest" ? "rest" : tile.entry.kind];
            const isDirectory = tile.kind === "entry" && tile.entry.kind === "directory";
            const className = `absolute flex flex-col justify-start overflow-hidden rounded-[4px] border px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${tone}`;
            const style = {
              left: x + TILE_GAP / 2,
              top: y + TILE_GAP / 2,
              width: tileWidth,
              height: tileHeight,
            };
            const content = showName && (
              <>
                <span className="block truncate text-xs font-medium">{tileName(tile)}</span>
                {showSize && (
                  <span className="block truncate text-xs tabular-nums text-muted-foreground">
                    {formatBytes(tile.bytes)}
                  </span>
                )}
              </>
            );
            const handlers = {
              onPointerMove: (event: PointerEvent) =>
                trackPointer(tile.key, event.clientX, event.clientY),
              onFocus: () => setHover({ key: tile.key, x: x + width / 2, y: y + height / 2 }),
              onBlur: () => setHover(null),
            };

            return isDirectory ? (
              <button
                key={tile.key}
                type="button"
                aria-label={`${label}. Open`}
                onClick={() => onOpen(tile.entry.name)}
                className={className}
                style={style}
                {...handlers}
              >
                {content}
              </button>
            ) : (
              <div
                key={tile.key}
                role="img"
                tabIndex={0}
                aria-label={label}
                className={className}
                style={style}
                {...handlers}
              >
                {content}
              </div>
            );
          })}

          {tiles.length === 0 && size.width > 0 && (
            <p className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Nothing here takes up disk space.
            </p>
          )}

          {hover && hovered && (
            <TreemapTooltip
              tile={hovered.data}
              totalBytes={result.totalBytes}
              x={hover.x}
              y={hover.y}
              flipX={hover.x > size.width / 2}
              flipY={hover.y > size.height / 2}
            />
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] border border-file-accent/35 bg-file-accent/15" />
          Directory (click to open)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] border bg-muted" />
          File
        </span>
        {hasRest && (
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[3px] border border-dashed bg-surface-recessed" />
            Smaller entries
          </span>
        )}
        {emptyCount > 0 && (
          <span className="ml-auto">
            {formatCount(emptyCount)} zero-byte {emptyCount === 1 ? "entry" : "entries"} not drawn
          </span>
        )}
      </div>
    </div>
  );
}

function TreemapTooltip({
  tile,
  totalBytes,
  x,
  y,
  flipX,
  flipY,
}: {
  tile: TreemapTile;
  totalBytes: number;
  x: number;
  y: number;
  flipX: boolean;
  flipY: boolean;
}) {
  const share = totalBytes > 0 ? (tile.bytes / totalBytes) * 100 : 0;
  const detail = tileDetail(tile);
  const translateX = flipX ? `calc(-100% - ${TOOLTIP_OFFSET}px)` : `${TOOLTIP_OFFSET}px`;
  const translateY = flipY ? `calc(-100% - ${TOOLTIP_OFFSET}px)` : `${TOOLTIP_OFFSET}px`;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-10 w-max max-w-64 rounded-lg border bg-popover px-2.5 py-1.5 text-popover-foreground shadow-md"
      style={{ left: x, top: y, transform: `translate(${translateX}, ${translateY})` }}
    >
      <p className="text-sm font-semibold tabular-nums">
        {formatBytes(tile.bytes)}{" "}
        <span className="font-normal text-muted-foreground">· {share.toFixed(1)}%</span>
      </p>
      <p className="truncate text-xs">{tileName(tile)}</p>
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

function DiskUsagePanel() {
  const rpc = useRpc<typeof rpcContract>();
  // null asks the server for its default (the server home directory).
  const [path, setPath] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(true);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [pathDraft, setPathDraft] = useState("");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [view, setView] = useState<ViewMode>(loadStoredView);
  const scanIdRef = useRef<string | null>(null);
  const forceRefreshRef = useRef(false);

  useRealtime("progress", (payload) => {
    if (isScanProgress(payload) && payload.scanId === scanIdRef.current) {
      setProgress(payload);
    }
  });

  useEffect(() => {
    let cancelled = false;
    const scanId = crypto.randomUUID();
    scanIdRef.current = scanId;
    const refresh = forceRefreshRef.current;
    forceRefreshRef.current = false;
    setIsScanning(true);
    setProgress(null);

    rpc
      .call("scan", { path, refresh, scanId })
      .then((next) => {
        if (cancelled) return;
        setResult(next);
        setError(null);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (cancelled) return;
        setIsScanning(false);
        setProgress(null);
        scanIdRef.current = null;
      });

    return () => {
      cancelled = true;
    };
  }, [rpc, path, refreshNonce]);

  const openChild = useCallback(
    (name: string) => {
      if (!result) return;
      setPath(result.path === "/" ? `/${name}` : `${result.path}/${name}`);
    },
    [result],
  );

  const crumbs = useMemo(() => (result ? breadcrumbsOf(result.path) : []), [result]);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <main className="mx-auto w-full max-w-4xl p-4 md:p-6">
        <header className="mb-4 flex flex-col gap-3 pt-12 sm:flex-row sm:items-end sm:justify-between md:pt-0">
          <p className="text-sm text-muted-foreground">
            What's taking up space on the bb server host. Click a directory to drill in.
          </p>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const target = pathDraft.trim();
              if (target) {
                setPath(target);
                setPathDraft("");
              }
            }}
          >
            <input
              value={pathDraft}
              onChange={(event) => setPathDraft(event.target.value)}
              placeholder="Scan a path…"
              spellCheck={false}
              className="h-8 w-44 rounded-md border bg-card px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button
              type="button"
              onClick={() => {
                forceRefreshRef.current = true;
                setRefreshNonce((nonce) => nonce + 1);
              }}
              disabled={isScanning}
              className="h-8 shrink-0 rounded-md border bg-card px-3 text-sm font-medium hover:bg-surface-recessed disabled:opacity-50"
            >
              {isScanning ? "Scanning…" : "Rescan"}
            </button>
          </form>
        </header>

        {error && (
          <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {!result && !error && (
          <div className="flex items-center justify-center rounded-xl border bg-card p-10">
            <div className="w-full max-w-md text-center">
              <div className="mx-auto size-3 animate-pulse rounded-full bg-primary" />
              <p className="mt-4 text-sm font-medium">Scanning disk usage</p>
              <div className="mt-1 text-sm text-muted-foreground">
                {progress ? (
                  <ProgressDetails progress={progress} />
                ) : (
                  "Walking the directory tree on the server host…"
                )}
              </div>
            </div>
          </div>
        )}

        {result && isScanning && (
          <div className="mb-3 flex items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm">
            <span className="size-2 shrink-0 animate-pulse rounded-full bg-primary" />
            <div className="min-w-0 flex-1">
              {progress ? <ProgressDetails progress={progress} /> : <span>Scanning…</span>}
            </div>
          </div>
        )}

        {result && (
          <section className={isScanning ? "opacity-60 transition-opacity" : "transition-opacity"}>
            <div className="rounded-xl border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="Path">
                  {crumbs.map((crumb, index) => (
                    <span key={crumb.path} className="flex items-center gap-1">
                      {index > 1 && <span className="text-muted-foreground">/</span>}
                      <button
                        type="button"
                        onClick={() => setPath(crumb.path)}
                        disabled={index === crumbs.length - 1}
                        className="rounded px-1 py-0.5 font-medium hover:bg-surface-recessed disabled:text-foreground disabled:hover:bg-transparent"
                      >
                        {crumb.label}
                      </button>
                    </span>
                  ))}
                </nav>
                <ViewToggle
                  value={view}
                  onChange={(next) => {
                    setView(next);
                    storeView(next);
                  }}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <p className="text-3xl font-semibold tabular-nums tracking-tight">
                  {formatBytes(result.totalBytes)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {formatCount(result.entryCount)} entries ·{" "}
                  {result.fromCache
                    ? `cached ${formatAgo(Date.now() - result.scannedAt)} ago`
                    : `scanned in ${(result.durationMs / 1000).toFixed(1)}s`}
                  {result.skippedCount > 0 && ` · ${formatCount(result.skippedCount)} unreadable`}
                </p>
              </div>
              {result.truncated && (
                <p className="mt-2 rounded-md bg-attention/10 px-2.5 py-1.5 text-sm text-attention">
                  Scan hit the entry budget — sizes below this point are partial.
                </p>
              )}
            </div>

            {result.entries.length === 0 ? (
              <p className="mt-3 rounded-lg border bg-card p-4 text-sm text-muted-foreground">
                This directory is empty.
              </p>
            ) : view === "treemap" ? (
              <TreemapView result={result} onOpen={openChild} />
            ) : (
              <ul className="mt-3 space-y-1.5">
                {result.entries.map((entry) => (
                  <EntryRow
                    key={entry.name}
                    entry={entry}
                    totalBytes={result.totalBytes}
                    onOpen={openChild}
                  />
                ))}
              </ul>
            )}
            {view === "list" && result.omittedEntryCount > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                … and {formatCount(result.omittedEntryCount)} smaller entries not shown.
              </p>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "disk-usage",
    title: "Disk Usage",
    icon: "Layers",
    path: "usage",
    component: DiskUsagePanel,
  });
});
