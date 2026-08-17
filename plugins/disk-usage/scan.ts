import type { Dirent } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Bounds a runaway scan (e.g. `/` on a busy host): once the budget is spent
// the walk stops descending and the result is flagged truncated.
export const MAX_VISITED_ENTRIES = 500_000;
export const MAX_RETURNED_ENTRIES = 100;

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

interface WalkBudget {
  remaining: number;
  skipped: number;
  truncated: boolean;
  // Hardlinked inodes (nlink > 1) are counted once, keyed by dev:ino.
  seenHardlinks: Set<string>;
}

async function fileBytes(path: string, budget: WalkBudget): Promise<number> {
  try {
    const stats = await lstat(path);
    if (stats.nlink > 1) {
      const key = `${stats.dev}:${stats.ino}`;
      if (budget.seenHardlinks.has(key)) return 0;
      budget.seenHardlinks.add(key);
    }
    // Allocated blocks measure real disk usage (sparse files); fall back to
    // apparent size on filesystems that report no blocks for inline data.
    return stats.blocks > 0 ? stats.blocks * 512 : stats.size;
  } catch {
    budget.skipped += 1;
    return 0;
  }
}

async function readEntries(path: string, budget: WalkBudget): Promise<Dirent[] | null> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    budget.skipped += 1;
    return null;
  }
}

async function walkTree(
  path: string,
  budget: WalkBudget,
): Promise<{ bytes: number; entryCount: number }> {
  const dirents = await readEntries(path, budget);
  if (dirents === null) return { bytes: 0, entryCount: 0 };

  let bytes = 0;
  let entryCount = 0;
  const subdirectories: string[] = [];
  const files: string[] = [];

  for (const dirent of dirents) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    budget.remaining -= 1;
    entryCount += 1;
    // Symlinks are never followed; they and special files count as entries
    // without measured bytes.
    if (dirent.isDirectory()) subdirectories.push(join(path, dirent.name));
    else if (dirent.isFile()) files.push(join(path, dirent.name));
  }

  const sizes = await Promise.all(files.map((filePath) => fileBytes(filePath, budget)));
  for (const size of sizes) bytes += size;

  for (const subdirectory of subdirectories) {
    const sub = await walkTree(subdirectory, budget);
    bytes += sub.bytes;
    entryCount += sub.entryCount;
  }

  return { bytes, entryCount };
}

export async function scanPath(requestedPath: string | null): Promise<ScanResult> {
  const startedAt = Date.now();
  const trimmed = requestedPath?.trim();
  const path = resolve(trimmed ? trimmed : homedir());

  let rootStats;
  try {
    rootStats = await stat(path);
  } catch {
    throw new Error(`Cannot access ${path}`);
  }
  if (!rootStats.isDirectory()) throw new Error(`Not a directory: ${path}`);

  const budget: WalkBudget = {
    remaining: MAX_VISITED_ENTRIES,
    skipped: 0,
    truncated: false,
    seenHardlinks: new Set(),
  };

  const dirents = await readdir(path, { withFileTypes: true });
  const entries: ScanEntry[] = [];
  let totalBytes = 0;
  let entryCount = 0;

  for (const dirent of dirents) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    budget.remaining -= 1;
    entryCount += 1;
    const childPath = join(path, dirent.name);

    if (dirent.isDirectory()) {
      const sub = await walkTree(childPath, budget);
      entries.push({
        name: dirent.name,
        kind: "directory",
        bytes: sub.bytes,
        entryCount: sub.entryCount,
      });
      totalBytes += sub.bytes;
      entryCount += sub.entryCount;
    } else if (dirent.isFile()) {
      const bytes = await fileBytes(childPath, budget);
      entries.push({ name: dirent.name, kind: "file", bytes, entryCount: 0 });
      totalBytes += bytes;
    } else {
      entries.push({ name: dirent.name, kind: "other", bytes: 0, entryCount: 0 });
    }
  }

  entries.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const returned = entries.slice(0, MAX_RETURNED_ENTRIES);
  const parentPath = dirname(path);

  return {
    path,
    parentPath: parentPath === path ? null : parentPath,
    totalBytes,
    entryCount,
    skippedCount: budget.skipped,
    truncated: budget.truncated,
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
