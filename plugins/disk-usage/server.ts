import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { formatAgo, formatBytes, resolveScanPath, scanPath, type ScanResult } from "./scan.js";

const CACHE_LIMIT = 100;
export const PROGRESS_CHANNEL = "progress";

export const entrySchema = z.object({
  name: z.string(),
  kind: z.enum(["directory", "file", "other"]),
  bytes: z.number().int().nonnegative(),
  entryCount: z.number().int().nonnegative(),
});

export const scanSchema = z.object({
  path: z.string(),
  parentPath: z.string().nullable(),
  totalBytes: z.number().int().nonnegative(),
  entryCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  omittedEntryCount: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  scannedAt: z.number().int().nonnegative(),
  fromCache: z.boolean(),
  entries: z.array(entrySchema),
});

export const rpcContract = defineRpcContract({
  scan: {
    input: z
      .object({
        path: z.string().nullable(),
        refresh: z.boolean().optional(),
        scanId: z.string().max(128).nullable().optional(),
      })
      .strict(),
    output: scanSchema,
  },
});

function formatScan(result: ScanResult & { fromCache: boolean }, top: number): string {
  const seconds = (result.durationMs / 1000).toFixed(result.durationMs >= 10_000 ? 0 : 1);
  const origin = result.fromCache
    ? `cached ${formatAgo(Date.now() - result.scannedAt)} ago — pass --refresh for a fresh scan`
    : `scanned in ${seconds}s`;
  const lines = [
    `${result.path} — ${formatBytes(result.totalBytes)} in ${result.entryCount.toLocaleString("en-US")} entries (${origin})`,
  ];
  if (result.truncated) {
    lines.push(`Warning: scan truncated after visiting the entry budget; sizes are partial.`);
  }
  if (result.skippedCount > 0) {
    lines.push(
      `Note: ${result.skippedCount.toLocaleString("en-US")} entries were unreadable and skipped.`,
    );
  }
  lines.push("");

  for (const entry of result.entries.slice(0, top)) {
    const share = result.totalBytes > 0 ? (entry.bytes / result.totalBytes) * 100 : 0;
    const suffix = entry.kind === "directory" ? "/" : "";
    lines.push(
      `${share.toFixed(1).padStart(5)}%  ${formatBytes(entry.bytes).padStart(9)}  ${entry.name}${suffix}`,
    );
  }
  const shown = Math.min(top, result.entries.length);
  const hidden = result.entries.length - shown + result.omittedEntryCount;
  if (hidden > 0) lines.push(`… and ${hidden.toLocaleString("en-US")} smaller entries`);
  return lines.join("\n");
}

const USAGE = "Usage: bb disk-usage [path] [--top N] [--json] [--refresh]";

export default function plugin(bb: BbPluginApi) {
  // Last completed scan per resolved path, insertion-ordered for LRU eviction.
  const cache = new Map<string, ScanResult>();
  // Concurrent requests for the same path join one walk instead of racing.
  const inFlight = new Map<string, Promise<ScanResult>>();

  function remember(result: ScanResult): void {
    cache.delete(result.path);
    cache.set(result.path, result);
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  async function getScan(
    requestedPath: string | null,
    options: { refresh: boolean; scanId: string | null },
  ): Promise<ScanResult & { fromCache: boolean }> {
    const target = resolveScanPath(requestedPath);

    if (!options.refresh) {
      const cached = cache.get(target);
      if (cached) return { ...cached, fromCache: true };
    }

    let pending = inFlight.get(target);
    if (!pending) {
      pending = scanPath(target, {
        onProgress: (progress) =>
          bb.realtime.publish(PROGRESS_CHANNEL, {
            scanId: options.scanId,
            path: target,
            ...progress,
          }),
      })
        .then((result) => {
          remember(result);
          return result;
        })
        .finally(() => inFlight.delete(target));
      inFlight.set(target, pending);
    }

    return { ...(await pending), fromCache: false };
  }

  bb.rpc.register(rpcContract, {
    scan: ({ path, refresh, scanId }) =>
      getScan(path, { refresh: refresh ?? false, scanId: scanId ?? null }),
  });

  bb.cli.register({
    name: "disk-usage",
    summary: "Show what's taking up disk space on the bb server host",
    commands: [
      {
        name: "scan",
        summary:
          "Scan a directory (default: the server home directory) and list the largest entries",
        usage: "bb disk-usage [path] [--top N] [--json] [--refresh]",
      },
    ],
    async run(argv) {
      if (argv.includes("--help") || argv.includes("-h")) {
        return {
          exitCode: 0,
          stdout: `${USAGE}\n\nScans the filesystem of the host running the bb server and lists the largest entries per directory. Symlinks are never followed. Results are cached per path until --refresh.`,
        };
      }

      let top = 20;
      const positional: string[] = [];
      for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]!;
        if (argument === "--json" || argument === "--refresh") continue;
        if (argument === "--top") {
          const value = Number(argv[index + 1]);
          if (!Number.isInteger(value) || value <= 0) {
            return { exitCode: 2, stderr: `--top expects a positive integer\n${USAGE}` };
          }
          top = value;
          index += 1;
          continue;
        }
        if (argument.startsWith("-")) {
          return { exitCode: 2, stderr: `Unknown option: ${argument}\n${USAGE}` };
        }
        positional.push(argument);
      }
      if (positional[0] === "scan") positional.shift();
      if (positional.length > 1) {
        return { exitCode: 2, stderr: `Too many arguments: ${positional.join(" ")}\n${USAGE}` };
      }

      let result: ScanResult & { fromCache: boolean };
      try {
        result = await getScan(positional[0] ?? null, {
          refresh: argv.includes("--refresh"),
          scanId: null,
        });
      } catch (cause) {
        return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
      }

      return {
        exitCode: 0,
        stdout: argv.includes("--json") ? JSON.stringify(result, null, 2) : formatScan(result, top),
      };
    },
  });
}
