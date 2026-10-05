import { readFile } from "node:fs/promises";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { historySchema, statsSchema } from "./server";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const DAY_MS = 86_400_000;
const GIB = 1024 ** 3;

async function loadPlugin() {
  const host = createFakePluginHost({ pluginId: "system-monitor" });
  await plugin(host.bb);
  return host;
}

function insertSample(
  host: Awaited<ReturnType<typeof loadPlugin>>,
  sampledAt: number,
  cpu: number,
  memory: number,
  disk: number,
  memoryCache: number | null = null,
) {
  host.bb.storage
    .database()
    .prepare(
      "INSERT INTO samples (sampled_at, cpu_percent, memory_percent, memory_cache_percent, disk_percent) VALUES (?, ?, ?, ?, ?)",
    )
    .run(sampledAt, cpu, memory, memoryCache, disk);
}

describe("System Monitor", () => {
  afterEach(() => {
    vi.mocked(readFile).mockRestore();
  });

  it("returns a schema-valid host snapshot over RPC", async () => {
    const { harness } = await loadPlugin();
    const stats = statsSchema.parse(await harness.callRpc("stats", null));

    expect(stats.hostname).not.toBe("");
    expect(stats.cpu.logicalCores).toBeGreaterThan(0);
    expect(stats.cpu.usagePercent).toBeGreaterThanOrEqual(0);
    expect(stats.cpu.usagePercent).toBeLessThanOrEqual(100);
    expect(stats.cpu.userPercent + stats.cpu.systemPercent).toBeCloseTo(stats.cpu.usagePercent);
    expect(stats.memory.totalBytes).toBeGreaterThan(0);
    expect(stats.disk.totalBytes).toBeGreaterThan(0);
    expect(stats.loadAverage).toHaveLength(3);
  });

  it.runIf(process.platform === "linux")(
    "splits Linux memory into application usage and reclaimable cache",
    async () => {
      const kib = (gib: number) => gib * 1024 * 1024;
      const { readFile: actualReadFile } =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(readFile).mockImplementation((async (path: string, options?: unknown) =>
        path === "/proc/meminfo"
          ? [
              `MemTotal:       ${kib(64)} kB`,
              `MemFree:        ${kib(16)} kB`,
              `MemAvailable:   ${kib(52)} kB`,
              `Buffers:        ${kib(8)} kB`,
              "",
            ].join("\n")
          : actualReadFile(path, options as never)) as typeof readFile);

      const { harness } = await loadPlugin();
      const stats = statsSchema.parse(await harness.callRpc("stats", null));

      expect(stats.memory).toEqual({
        usedBytes: 12 * GIB,
        availableBytes: 52 * GIB,
        totalBytes: 64 * GIB,
        usedPercent: 18.75,
        cacheBytes: 36 * GIB,
      });

      const human = await harness.runCli([]);
      expect(human.stdout).toContain("12.0 GiB / 64.0 GiB (18.8%) + 36.0 GiB file cache");
    },
  );

  it("registers the system-monitor CLI with human and JSON output", async () => {
    const { harness } = await loadPlugin();
    expect(harness.registrations.cli?.name).toBe("system-monitor");

    const human = await harness.runCli([]);
    expect(human).toMatchObject({ exitCode: 0 });
    expect(human.stdout).toContain("CPU");
    expect(human.stdout).toContain("Memory");

    const json = await harness.runCli(["--json"]);
    expect(json.exitCode).toBe(0);
    expect(() => statsSchema.parse(JSON.parse(json.stdout))).not.toThrow();
  });

  it("returns an empty history payload before any samples exist", async () => {
    const { harness } = await loadPlugin();
    const history = historySchema.parse(await harness.callRpc("history", { range: "1d" }));

    expect(history.points).toEqual([]);
    expect(history.earliestSampledAt).toBeNull();
    expect(history.windowMs).toBe(DAY_MS);
  });

  it("buckets recorded samples into per-range averages", async () => {
    const host = await loadPlugin();
    const bucketMs = 300_000;
    const base = (Math.floor(Date.now() / bucketMs) - 2) * bucketMs;
    const oldSampleAt = Date.now() - 2 * DAY_MS;
    insertSample(host, base, 10, 40, 70);
    insertSample(host, base + 30_000, 20, 60, 70, 30);
    insertSample(host, base + bucketMs, 50, 50, 71);
    insertSample(host, oldSampleAt, 99, 98, 97);

    const day = historySchema.parse(await host.harness.callRpc("history", { range: "1d" }));
    expect(day.bucketMs).toBe(bucketMs);
    expect(day.points).toHaveLength(2);
    expect(day.points[0]).toMatchObject({
      t: base,
      cpuPercent: 15,
      memoryPercent: 50,
      // Samples recorded before cache tracking are ignored rather than averaged in as 0.
      memoryCachePercent: 30,
      diskPercent: 70,
    });
    expect(day.points[1]).toMatchObject({
      t: base + bucketMs,
      cpuPercent: 50,
      memoryCachePercent: null,
    });

    const week = historySchema.parse(await host.harness.callRpc("history", { range: "7d" }));
    expect(week.points[0]?.cpuPercent).toBe(99);
    expect(week.earliestSampledAt).toBe(oldSampleAt);
  });

  it("records samples via the background service and prunes expired rows", async () => {
    const host = await loadPlugin();
    const db = host.bb.storage.database();
    const stale = Date.now() - 40 * DAY_MS;
    insertSample(host, stale, 1, 1, 1);

    const service = host.harness.runService("sampler");
    await expect
      .poll(
        () =>
          (
            db.prepare("SELECT COUNT(*) AS count FROM samples WHERE sampled_at > ?").get(stale) as {
              count: number;
            }
          ).count,
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);
    service.controller.abort();
    await service.done;

    if (process.platform === "linux") {
      const { cache } = db
        .prepare(
          "SELECT memory_cache_percent AS cache FROM samples ORDER BY sampled_at DESC LIMIT 1",
        )
        .get() as { cache: number | null };
      expect(cache).not.toBeNull();
    }

    const staleRows = db
      .prepare("SELECT COUNT(*) AS count FROM samples WHERE sampled_at = ?")
      .get(stale) as { count: number };
    expect(staleRows.count).toBe(0);

    const history = historySchema.parse(await host.harness.callRpc("history", { range: "1d" }));
    expect(history.points.length).toBeGreaterThan(0);
  });

  it("serves history through the CLI", async () => {
    const host = await loadPlugin();
    const empty = await host.harness.runCli(["history"]);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain("No history recorded yet");

    // Both samples share one 2-hour bucket so the 30d range still returns a single point.
    const bucketStart = (Math.floor(Date.now() / 7_200_000) - 1) * 7_200_000;
    insertSample(host, bucketStart, 25, 50, 75);
    const withoutCache = await host.harness.runCli(["history", "--range", "7d"]);
    expect(withoutCache.exitCode).toBe(0);
    expect(withoutCache.stdout).toContain("History   7d");
    expect(withoutCache.stdout).toContain("avg 25.0%");
    expect(withoutCache.stdout).not.toContain("+ cache");

    insertSample(host, bucketStart + 30_000, 25, 50, 75, 40);
    const human = await host.harness.runCli(["history", "--range", "7d"]);
    expect(human.stdout).toContain("  + cache avg 40.0%  max 40.0%");

    const json = await host.harness.runCli(["history", "--range=30d", "--json"]);
    expect(json.exitCode).toBe(0);
    const parsed = historySchema.parse(JSON.parse(json.stdout));
    expect(parsed.range).toBe("30d");
    expect(parsed.points).toHaveLength(1);

    const invalid = await host.harness.runCli(["history", "--range", "2d"]);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stderr).toContain("Invalid --range value");
  });
});
