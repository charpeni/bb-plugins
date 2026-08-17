import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin, { historySchema, statsSchema } from "./server";

const DAY_MS = 86_400_000;

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
) {
  host.bb.storage
    .database()
    .prepare(
      "INSERT INTO samples (sampled_at, cpu_percent, memory_percent, disk_percent) VALUES (?, ?, ?, ?)",
    )
    .run(sampledAt, cpu, memory, disk);
}

describe("System Monitor", () => {
  it("returns a schema-valid host snapshot over RPC", async () => {
    const { harness } = await loadPlugin();
    const stats = statsSchema.parse(await harness.callRpc("stats", null));

    expect(stats.hostname).not.toBe("");
    expect(stats.cpu.logicalCores).toBeGreaterThan(0);
    expect(stats.cpu.usagePercent).toBeGreaterThanOrEqual(0);
    expect(stats.cpu.usagePercent).toBeLessThanOrEqual(100);
    expect(stats.memory.totalBytes).toBeGreaterThan(0);
    expect(stats.disk.totalBytes).toBeGreaterThan(0);
    expect(stats.loadAverage).toHaveLength(3);
  });

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
    insertSample(host, base + 30_000, 20, 60, 70);
    insertSample(host, base + bucketMs, 50, 50, 71);
    insertSample(host, oldSampleAt, 99, 98, 97);

    const day = historySchema.parse(await host.harness.callRpc("history", { range: "1d" }));
    expect(day.bucketMs).toBe(bucketMs);
    expect(day.points).toHaveLength(2);
    expect(day.points[0]).toMatchObject({
      t: base,
      cpuPercent: 15,
      memoryPercent: 50,
      diskPercent: 70,
    });
    expect(day.points[1]).toMatchObject({ t: base + bucketMs, cpuPercent: 50 });

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

    insertSample(host, Date.now() - 60_000, 25, 50, 75);
    const human = await host.harness.runCli(["history", "--range", "7d"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("History   7d");
    expect(human.stdout).toContain("avg 25.0%");

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
