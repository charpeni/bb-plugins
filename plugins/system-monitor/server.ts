import { readFile, statfs } from "node:fs/promises";
import {
  arch,
  cpus,
  freemem,
  homedir,
  hostname,
  loadavg,
  platform,
  release,
  totalmem,
  uptime,
} from "node:os";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const SAMPLE_DURATION_MS = 200;
const SAMPLE_INTERVAL_MS = 30_000;
const RETENTION_MS = 31 * 86_400_000;

const HISTORY_RANGES = {
  "1d": { windowMs: 86_400_000, bucketMs: 300_000 },
  "7d": { windowMs: 7 * 86_400_000, bucketMs: 1_800_000 },
  "30d": { windowMs: 30 * 86_400_000, bucketMs: 7_200_000 },
} as const;

const usageSchema = z.object({
  usedBytes: z.number().int().nonnegative(),
  availableBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  usedPercent: z.number().min(0).max(100),
});

export const statsSchema = z.object({
  sampledAt: z.number().int().nonnegative(),
  hostname: z.string(),
  platform: z.string(),
  release: z.string(),
  architecture: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  cpu: z.object({
    usagePercent: z.number().min(0).max(100),
    // usagePercent split into user (user + nice) and system (sys + irq) time.
    userPercent: z.number().min(0).max(100),
    systemPercent: z.number().min(0).max(100),
    logicalCores: z.number().int().positive(),
    model: z.string(),
    speedMHz: z.number().positive().nullable(),
  }),
  memory: usageSchema.extend({
    // Reclaimable page cache and buffers, counted in availableBytes rather than usedBytes.
    // Hypervisors such as Proxmox report usedBytes + cacheBytes as the guest's usage.
    // Null when the platform does not expose it.
    cacheBytes: z.number().int().nonnegative().nullable(),
  }),
  disk: usageSchema.extend({ path: z.string() }),
  loadAverage: z.tuple([z.number(), z.number(), z.number()]),
});

export const historyRangeSchema = z.enum(["1d", "7d", "30d"]);

export const historySchema = z.object({
  range: historyRangeSchema,
  windowMs: z.number().int().positive(),
  bucketMs: z.number().int().positive(),
  sampleIntervalMs: z.number().int().positive(),
  earliestSampledAt: z.number().int().nonnegative().nullable(),
  points: z.array(
    z.object({
      t: z.number().int().nonnegative(),
      cpuPercent: z.number().min(0).max(100),
      memoryPercent: z.number().min(0).max(100),
      // File cache on top of memoryPercent; null for buckets recorded before it was tracked.
      memoryCachePercent: z.number().min(0).max(100).nullable(),
      diskPercent: z.number().min(0).max(100),
    }),
  ),
});

export const rpcContract = defineRpcContract({
  stats: { input: z.null(), output: statsSchema },
  history: { input: z.object({ range: historyRangeSchema }).strict(), output: historySchema },
});

type CpuTicks = { user: number; system: number; idle: number; total: number };
type SystemStats = z.infer<typeof statsSchema>;
type SystemHistory = z.infer<typeof historySchema>;
type HistoryRange = z.infer<typeof historyRangeSchema>;
type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS samples (
    sampled_at INTEGER PRIMARY KEY,
    cpu_percent REAL NOT NULL,
    memory_percent REAL NOT NULL,
    disk_percent REAL NOT NULL
  )`,
  `ALTER TABLE samples ADD COLUMN memory_cache_percent REAL`,
];

function cpuTicks(): CpuTicks {
  let user = 0;
  let system = 0;
  let idle = 0;
  for (const cpu of cpus()) {
    user += cpu.times.user + cpu.times.nice;
    system += cpu.times.sys + cpu.times.irq;
    idle += cpu.times.idle;
  }
  return { user, system, idle, total: user + system + idle };
}

function percent(used: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepUntilAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function cpuSpeedMHz(cpuList: ReturnType<typeof cpus>): Promise<number | null> {
  const reportedSpeeds = cpuList.map((cpu) => cpu.speed).filter((speed) => speed > 0);
  if (reportedSpeeds.length > 0) {
    return reportedSpeeds.reduce((sum, speed) => sum + speed, 0) / reportedSpeeds.length;
  }

  if (platform() !== "linux") return null;
  try {
    const cpuInfo = await readFile("/proc/cpuinfo", "utf8");
    const speeds = Array.from(cpuInfo.matchAll(/^cpu MHz\s*:\s*([\d.]+)$/gim), (match) =>
      Number(match[1]),
    ).filter((speed) => Number.isFinite(speed) && speed > 0);
    if (speeds.length === 0) return null;
    return speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length;
  } catch {
    return null;
  }
}

async function readMemory(): Promise<{ total: number; available: number; cache: number | null }> {
  const fallback = { total: totalmem(), available: freemem(), cache: null };
  if (platform() !== "linux") return fallback;
  try {
    const memInfo = await readFile("/proc/meminfo", "utf8");
    const field = (name: string) => {
      const match = memInfo.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, "m"));
      return match ? Number(match[1]) * 1024 : null;
    };
    const total = field("MemTotal");
    const free = field("MemFree");
    const available = field("MemAvailable");
    if (total === null || free === null || available === null) return fallback;
    // MemAvailable is MemFree plus what the kernel can reclaim (page cache, reclaimable slab),
    // so the difference is exactly the cache that `MemTotal - MemFree` tools count as used.
    return { total, available, cache: Math.max(0, available - free) };
  } catch {
    return fallback;
  }
}

async function collectStats(): Promise<SystemStats> {
  const before = cpuTicks();
  const diskPath = homedir();
  const diskPromise = statfs(diskPath, { bigint: true });
  await sleep(SAMPLE_DURATION_MS);
  const after = cpuTicks();
  const disk = await diskPromise;

  const cpuTotal = after.total - before.total;
  const cpuUser = percent(after.user - before.user, cpuTotal);
  const cpuSystem = percent(after.system - before.system, cpuTotal);

  const memory = await readMemory();
  const memoryUsed = Math.max(0, memory.total - memory.available);

  const diskTotal = Number(disk.bsize * disk.blocks);
  const diskAvailable = Number(disk.bsize * disk.bavail);
  const diskUsed = diskTotal - diskAvailable;
  const cpuList = cpus();
  const speedMHz = await cpuSpeedMHz(cpuList);
  const [oneMinute = 0, fiveMinutes = 0, fifteenMinutes = 0] = loadavg();

  return {
    sampledAt: Date.now(),
    hostname: hostname(),
    platform: platform(),
    release: release(),
    architecture: arch(),
    uptimeSeconds: uptime(),
    cpu: {
      usagePercent: clampPercent(cpuUser + cpuSystem),
      userPercent: cpuUser,
      systemPercent: cpuSystem,
      logicalCores: Math.max(1, cpuList.length),
      model: cpuList[0]?.model.trim() || "Unknown CPU",
      speedMHz,
    },
    memory: {
      usedBytes: memoryUsed,
      availableBytes: memory.available,
      totalBytes: memory.total,
      usedPercent: percent(memoryUsed, memory.total),
      cacheBytes: memory.cache,
    },
    disk: {
      path: diskPath,
      usedBytes: diskUsed,
      availableBytes: diskAvailable,
      totalBytes: diskTotal,
      usedPercent: percent(diskUsed, diskTotal),
    },
    loadAverage: [oneMinute, fiveMinutes, fifteenMinutes],
  };
}

async function recordSample(db: PluginDatabase): Promise<void> {
  const stats = await collectStats();
  const { cacheBytes, totalBytes } = stats.memory;
  db.prepare(
    "INSERT OR REPLACE INTO samples (sampled_at, cpu_percent, memory_percent, memory_cache_percent, disk_percent) VALUES (?, ?, ?, ?, ?)",
  ).run(
    stats.sampledAt,
    stats.cpu.usagePercent,
    stats.memory.usedPercent,
    cacheBytes === null ? null : percent(cacheBytes, totalBytes),
    stats.disk.usedPercent,
  );
  db.prepare("DELETE FROM samples WHERE sampled_at < ?").run(stats.sampledAt - RETENTION_MS);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function queryHistory(db: PluginDatabase, range: HistoryRange, now = Date.now()): SystemHistory {
  const { windowMs, bucketMs } = HISTORY_RANGES[range];
  const rows = db
    .prepare(
      `SELECT CAST(sampled_at / ? AS INTEGER) * ? AS bucket_start,
              AVG(cpu_percent) AS cpu_percent,
              AVG(memory_percent) AS memory_percent,
              AVG(memory_cache_percent) AS memory_cache_percent,
              AVG(disk_percent) AS disk_percent
         FROM samples
        WHERE sampled_at >= ?
        GROUP BY bucket_start
        ORDER BY bucket_start`,
    )
    .all(bucketMs, bucketMs, now - windowMs) as Array<{
    bucket_start: number;
    cpu_percent: number;
    memory_percent: number;
    memory_cache_percent: number | null;
    disk_percent: number;
  }>;
  const { earliest } = db.prepare("SELECT MIN(sampled_at) AS earliest FROM samples").get() as {
    earliest: number | null;
  };

  return {
    range,
    windowMs,
    bucketMs,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    earliestSampledAt: earliest,
    points: rows.map((row) => ({
      t: row.bucket_start,
      cpuPercent: clampPercent(row.cpu_percent),
      memoryPercent: clampPercent(row.memory_percent),
      memoryCachePercent:
        row.memory_cache_percent === null ? null : clampPercent(row.memory_cache_percent),
      diskPercent: clampPercent(row.disk_percent),
    })),
  };
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

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", `${minutes}m`]
    .filter(Boolean)
    .join(" ");
}

function formatStats(stats: SystemStats): string {
  return [
    `Host      ${stats.hostname} (${stats.platform} ${stats.architecture})`,
    `CPU       ${stats.cpu.usagePercent.toFixed(1)}% (${stats.cpu.userPercent.toFixed(1)}% user, ${stats.cpu.systemPercent.toFixed(1)}% system) / ${stats.cpu.logicalCores} logical cores / ${stats.cpu.speedMHz === null ? "speed unavailable" : `${Math.round(stats.cpu.speedMHz)} MHz`}`,
    `Memory    ${formatBytes(stats.memory.usedBytes)} / ${formatBytes(stats.memory.totalBytes)} (${stats.memory.usedPercent.toFixed(1)}%)${stats.memory.cacheBytes === null ? "" : ` + ${formatBytes(stats.memory.cacheBytes)} file cache`}`,
    `Disk      ${formatBytes(stats.disk.availableBytes)} available / ${formatBytes(stats.disk.totalBytes)} (${stats.disk.usedPercent.toFixed(1)}% used)`,
    `Load      ${stats.loadAverage.map((value) => value.toFixed(2)).join("  ")}`,
    `Uptime    ${formatUptime(stats.uptimeSeconds)}`,
  ].join("\n");
}

function formatHistory(history: SystemHistory): string {
  if (history.points.length === 0) {
    return "No history recorded yet. Samples are collected every 30s while the plugin is loaded.";
  }
  const summarize = (values: number[]) => {
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const peak = Math.max(...values);
    return `avg ${average.toFixed(1)}%  max ${peak.toFixed(1)}%`;
  };
  const cacheValues = history.points.flatMap((point) =>
    point.memoryCachePercent === null ? [] : [point.memoryCachePercent],
  );
  const bucketLabel =
    history.bucketMs < 3_600_000
      ? `${history.bucketMs / 60_000} min`
      : `${history.bucketMs / 3_600_000} h`;
  return [
    `History   ${history.range} / ${history.points.length} buckets of ${bucketLabel}`,
    `CPU       ${summarize(history.points.map((point) => point.cpuPercent))}`,
    `Memory    ${summarize(history.points.map((point) => point.memoryPercent))}`,
    cacheValues.length === 0 ? "" : `  + cache ${summarize(cacheValues)}`,
    `Disk      ${summarize(history.points.map((point) => point.diskPercent))}`,
    history.earliestSampledAt === null
      ? ""
      : `Since     ${new Date(history.earliestSampledAt).toLocaleString()}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const CLI_USAGE = [
  "Usage: bb system-monitor [show|history] [--json]",
  "",
  "  show      Print the current machine statistics (default)",
  "  history   Summarize recorded history (--range 1d|7d|30d, default 1d)",
].join("\n");

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  bb.rpc.register(rpcContract, {
    stats: collectStats,
    history: ({ range }) => queryHistory(db, range),
  });

  bb.background.service("sampler", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await recordSample(db);
        } catch (cause) {
          if (signal.aborted) break;
          bb.log.warn(
            `Failed to record a metrics sample: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
        await sleepUntilAborted(SAMPLE_INTERVAL_MS, signal);
      }
    },
  });

  bb.cli.register({
    name: "system-monitor",
    summary: "Show CPU, memory, disk, load, and uptime for the bb server host",
    commands: [
      {
        name: "show",
        summary: "Print the current machine statistics",
        usage: "bb system-monitor [show] [--json]",
      },
      {
        name: "history",
        summary: "Summarize recorded CPU, memory, and disk history",
        usage: "bb system-monitor history [--range 1d|7d|30d] [--json]",
      },
    ],
    async run(argv) {
      let help = false;
      let json = false;
      let range: HistoryRange = "1d";
      const positional: string[] = [];
      const errors: string[] = [];
      for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]!;
        if (arg === "--help" || arg === "-h") {
          help = true;
        } else if (arg === "--json") {
          json = true;
        } else if (arg === "--range" || arg.startsWith("--range=")) {
          const value = arg.startsWith("--range=") ? arg.slice("--range=".length) : argv[++index];
          const parsed = historyRangeSchema.safeParse(value);
          if (parsed.success) range = parsed.data;
          else
            errors.push(`Invalid --range value: ${value ?? "(missing)"} (expected 1d, 7d, or 30d)`);
        } else if (!arg.startsWith("-")) {
          positional.push(arg);
        }
      }

      if (help) return { exitCode: 0, stdout: CLI_USAGE };
      if (errors.length > 0) return { exitCode: 2, stderr: `${errors.join("\n")}\n${CLI_USAGE}` };

      const command = positional[0] ?? "show";
      if (positional.length > 1 || (command !== "show" && command !== "history")) {
        return { exitCode: 2, stderr: `Unknown command: ${positional.join(" ")}\n${CLI_USAGE}` };
      }

      if (command === "history") {
        const history = queryHistory(db, range);
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify(history, null, 2) : formatHistory(history),
        };
      }

      const stats = await collectStats();
      return { exitCode: 0, stdout: json ? JSON.stringify(stats, null, 2) : formatStats(stats) };
    },
  });
}
