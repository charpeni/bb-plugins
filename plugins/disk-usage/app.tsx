import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";

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
            {result.entries.length === 0 && (
              <p className="mt-3 rounded-lg border bg-card p-4 text-sm text-muted-foreground">
                This directory is empty.
              </p>
            )}
            {result.omittedEntryCount > 0 && (
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
