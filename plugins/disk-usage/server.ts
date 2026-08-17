import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { formatBytes, scanPath, type ScanResult } from "./scan.js";

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
  entries: z.array(entrySchema),
});

export const rpcContract = defineRpcContract({
  scan: {
    input: z.object({ path: z.string().nullable() }).strict(),
    output: scanSchema,
  },
});

function formatScan(result: ScanResult, top: number): string {
  const seconds = (result.durationMs / 1000).toFixed(result.durationMs >= 10_000 ? 0 : 1);
  const lines = [
    `${result.path} — ${formatBytes(result.totalBytes)} in ${result.entryCount.toLocaleString("en-US")} entries (scanned in ${seconds}s)`,
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

const USAGE = "Usage: bb disk-usage [path] [--top N] [--json]";

export default function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    scan: ({ path }) => scanPath(path),
  });

  bb.cli.register({
    name: "disk-usage",
    summary: "Show what's taking up disk space on the bb server host",
    commands: [
      {
        name: "scan",
        summary:
          "Scan a directory (default: the server home directory) and list the largest entries",
        usage: "bb disk-usage [path] [--top N] [--json]",
      },
    ],
    async run(argv) {
      if (argv.includes("--help") || argv.includes("-h")) {
        return {
          exitCode: 0,
          stdout: `${USAGE}\n\nScans the filesystem of the host running the bb server and lists the largest entries per directory. Symlinks are never followed.`,
        };
      }

      let top = 20;
      const positional: string[] = [];
      for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]!;
        if (argument === "--json") continue;
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

      let result: ScanResult;
      try {
        result = await scanPath(positional[0] ?? null);
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
