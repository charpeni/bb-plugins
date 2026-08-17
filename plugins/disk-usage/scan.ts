import type { Dirent } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Bounds a runaway scan (e.g. `/` on a busy host): once the budget is spent
// the walk stops descending and the result is flagged truncated.
export const MAX_VISITED_ENTRIES = 500_000;
export const MAX_RETURNED_ENTRIES = 100;
// Directory reads run concurrently up to this cap; fs work funnels through
// libuv's threadpool anyway, so more slots buy queueing, not throughput.
const WALK_CONCURRENCY = 16;
const PROGRESS_INTERVAL_MS = 200;

export type ScanEntryKind = "directory" | "file" | "other";

export interface ScanEntry {
  name: string;
  kind: ScanEntryKind;
  bytes: number;
  entryCount: number;
}

export interface ScanResult {
  path: string;
  parentPath: string | null;
  totalBytes: number;
  entryCount: number;
  skippedCount: number;
  truncated: boolean;
  omittedEntryCount: number;
  durationMs: number;
  scannedAt: number;
  entries: ScanEntry[];
}

export interface ScanProgress {
  visitedCount: number;
  totalBytes: number;
  skippedCount: number;
  currentPath: string;
  elapsedMs: number;
}

export interface ScanOptions {
  onProgress?: (progress: ScanProgress) => void;
}

class Semaphore {
  private readonly queue: (() => void)[] = [];
  private available: number;

  constructor(slots: number) {
    this.available = slots;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((release) => this.queue.push(release));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.available += 1;
  }
}

interface WalkContext {
  remaining: number;
  skipped: number;
  truncated: boolean;
  // Hardlinked inodes (nlink > 1) are counted once, keyed by dev:ino.
  seenHardlinks: Set<string>;
  semaphore: Semaphore;
  bytesSoFar: number;
  currentPath: string;
  startedAt: number;
  lastReportAt: number;
  onProgress?: (progress: ScanProgress) => void;
}

function reportProgress(context: WalkContext, force = false): void {
  if (!context.onProgress) return;
  const now = Date.now();
  if (!force && now - context.lastReportAt < PROGRESS_INTERVAL_MS) return;
  context.lastReportAt = now;
  context.onProgress({
    visitedCount: MAX_VISITED_ENTRIES - context.remaining,
    totalBytes: context.bytesSoFar,
    skippedCount: context.skipped,
    currentPath: context.currentPath,
    elapsedMs: now - context.startedAt,
  });
}

async function fileBytes(path: string, context: WalkContext): Promise<number> {
  try {
    const stats = await lstat(path);
    if (stats.nlink > 1) {
      const key = `${stats.dev}:${stats.ino}`;
      if (context.seenHardlinks.has(key)) return 0;
      context.seenHardlinks.add(key);
    }
    // Allocated blocks measure real disk usage (sparse files); fall back to
    // apparent size on filesystems that report no blocks for inline data.
    const bytes = stats.blocks > 0 ? stats.blocks * 512 : stats.size;
    context.bytesSoFar += bytes;
    return bytes;
  } catch {
    context.skipped += 1;
    return 0;
  }
}

async function readEntries(path: string, context: WalkContext): Promise<Dirent[] | null> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    context.skipped += 1;
    return null;
  }
}

async function walkTree(
  path: string,
  context: WalkContext,
): Promise<{ bytes: number; entryCount: number }> {
  context.currentPath = path;
  reportProgress(context);

  let bytes = 0;
  let entryCount = 0;
  const subdirectories: string[] = [];

  // The slot covers this directory's readdir + file stats; it is released
  // before recursing so waiting children can never deadlock the pool.
  await context.semaphore.acquire();
  try {
    const dirents = await readEntries(path, context);
    if (dirents === null) return { bytes: 0, entryCount: 0 };

    const files: string[] = [];
    for (const dirent of dirents) {
      if (context.remaining <= 0) {
        context.truncated = true;
        break;
      }
      context.remaining -= 1;
      entryCount += 1;
      // Symlinks are never followed; they and special files count as entries
      // without measured bytes.
      if (dirent.isDirectory()) subdirectories.push(join(path, dirent.name));
      else if (dirent.isFile()) files.push(join(path, dirent.name));
    }

    const sizes = await Promise.all(files.map((filePath) => fileBytes(filePath, context)));
    for (const size of sizes) bytes += size;
  } finally {
    context.semaphore.release();
  }

  const subResults = await Promise.all(
    subdirectories.map((subdirectory) => walkTree(subdirectory, context)),
  );
  for (const sub of subResults) {
    bytes += sub.bytes;
    entryCount += sub.entryCount;
  }

  return { bytes, entryCount };
}

async function measureChild(
  parentPath: string,
  dirent: Dirent,
  context: WalkContext,
): Promise<ScanEntry> {
  const name = dirent.name;
  const childPath = join(parentPath, name);
  const kind: ScanEntryKind = dirent.isDirectory()
    ? "directory"
    : dirent.isFile()
      ? "file"
      : "other";

  if (context.remaining <= 0) {
    context.truncated = true;
    return { name, kind, bytes: 0, entryCount: 0 };
  }
  context.remaining -= 1;

  if (kind === "directory") {
    const sub = await walkTree(childPath, context);
    return { name, kind, bytes: sub.bytes, entryCount: sub.entryCount };
  }
  if (kind === "file") {
    return { name, kind, bytes: await fileBytes(childPath, context), entryCount: 0 };
  }
  return { name, kind, bytes: 0, entryCount: 0 };
}

export function resolveScanPath(requestedPath: string | null): string {
  const trimmed = requestedPath?.trim();
  return resolve(trimmed ? trimmed : homedir());
}

export async function scanPath(
  requestedPath: string | null,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const startedAt = Date.now();
  const path = resolveScanPath(requestedPath);

  let rootStats;
  try {
    rootStats = await stat(path);
  } catch {
    throw new Error(`Cannot access ${path}`);
  }
  if (!rootStats.isDirectory()) throw new Error(`Not a directory: ${path}`);

  const context: WalkContext = {
    remaining: MAX_VISITED_ENTRIES,
    skipped: 0,
    truncated: false,
    seenHardlinks: new Set(),
    semaphore: new Semaphore(WALK_CONCURRENCY),
    bytesSoFar: 0,
    currentPath: path,
    startedAt,
    lastReportAt: 0,
    onProgress: options.onProgress,
  };
  reportProgress(context, true);

  const dirents = await readdir(path, { withFileTypes: true });
  const entries = await Promise.all(dirents.map((dirent) => measureChild(path, dirent, context)));

  let totalBytes = 0;
  let entryCount = entries.length;
  for (const entry of entries) {
    totalBytes += entry.bytes;
    entryCount += entry.entryCount;
  }

  entries.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const returned = entries.slice(0, MAX_RETURNED_ENTRIES);
  const parentPath = dirname(path);

  return {
    path,
    parentPath: parentPath === path ? null : parentPath,
    totalBytes,
    entryCount,
    skippedCount: context.skipped,
    truncated: context.truncated,
    omittedEntryCount: entries.length - returned.length,
    durationMs: Date.now() - startedAt,
    scannedAt: Date.now(),
    entries: returned,
  };
}

export function formatBytes(bytes: number): string {
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

export function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
