import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { activitySchema, parseCliArgs } from "./server";

// vitest.config.ts pins TZ to America/Toronto.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, day, hour, minute).getTime();
const WEEK = { from: at(5, 0), to: at(12, 0), mergeGapMinutes: 30 };

type FakeThread = {
  id: string;
  projectId: string;
  title: string | null;
  status: string;
  archivedAt: number | null;
  parentThreadId: string | null;
  updatedAt: number;
  visibility: "visible" | "hidden";
};

type FakeEvent = {
  id: string;
  seq: number;
  threadId: string;
  createdAt: number;
  type: "turn/started" | "turn/completed";
  scope: { kind: "turn"; turnId: string };
  data: Record<string, unknown>;
};

function thread(overrides: Partial<FakeThread> & { id: string }): FakeThread {
  return {
    projectId: "proj_web",
    title: `Thread ${overrides.id}`,
    status: "idle",
    archivedAt: null,
    parentThreadId: null,
    updatedAt: at(5, 18),
    visibility: "visible",
    ...overrides,
  };
}

function turnEvents(threadId: string, turns: Array<[number, number | null]>, firstSeq = 1) {
  let seq = firstSeq;
  return turns.flatMap(([start, end], index) => {
    const turnId = `${threadId}-t${firstSeq + index}`;
    const events: FakeEvent[] = [
      {
        id: `ev_${seq}`,
        seq: seq++,
        threadId,
        createdAt: start,
        type: "turn/started",
        scope: { kind: "turn", turnId },
        data: {},
      },
    ];
    if (end !== null) {
      events.push({
        id: `ev_${seq}`,
        seq: seq++,
        threadId,
        createdAt: end,
        type: "turn/completed",
        scope: { kind: "turn", turnId },
        data: { status: "completed" },
      });
    }
    return events;
  });
}

function createWorld() {
  const threads: FakeThread[] = [];
  const events = new Map<string, FakeEvent[]>();
  const host = createFakePluginHost({
    pluginId: "agent-calendar",
    sdk: {
      threads: {
        list: async (args?: { archived?: boolean; offset?: number }) =>
          (args?.offset ?? 0) > 0
            ? []
            : threads.filter((item) => (item.archivedAt !== null) === (args?.archived ?? false)),
        events: {
          list: async (args: { threadId: string; afterSeq?: string; limit?: string }) =>
            (events.get(args.threadId) ?? [])
              .filter((event) => event.seq > Number(args.afterSeq ?? 0))
              .slice(0, Number(args.limit ?? 100)),
        },
      },
      projects: {
        list: async () => [
          { id: "proj_web", name: "web" },
          { id: "proj_api", name: "api" },
        ],
      },
    } as never,
  });
  return { host, threads, events };
}

async function loadWorld() {
  const world = createWorld();
  await plugin(world.host.bb);
  return world;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Agent Calendar server", () => {
  it("indexes turn history and returns merged blocks over RPC", async () => {
    const world = createWorld();
    world.threads.push(
      thread({ id: "thr_a", title: "Fix the flaky test" }),
      thread({ id: "thr_b", projectId: "proj_api", archivedAt: at(6, 9) }),
    );
    world.events.set(
      "thr_a",
      turnEvents("thr_a", [
        [at(5, 9, 5), at(5, 9, 20)],
        [at(5, 9, 40), at(5, 9, 55)],
        [at(5, 14, 0), at(5, 14, 20)],
      ]),
    );
    world.events.set("thr_b", turnEvents("thr_b", [[at(6, 8, 0), at(6, 8, 50)]]));
    await plugin(world.host.bb);

    const activity = activitySchema.parse(await world.host.harness.callRpc("activity", WEEK));

    expect(activity.blocks.map((block) => [block.threadId, block.start, block.end])).toEqual([
      ["thr_a", at(5, 9), at(5, 10)],
      ["thr_a", at(5, 14), at(5, 14, 30)],
      ["thr_b", at(6, 8), at(6, 9)],
    ]);
    expect(activity.threads).toContainEqual(
      expect.objectContaining({ id: "thr_b", projectId: "proj_api", archived: true }),
    );
    expect(activity.threads.find((item) => item.id === "thr_a")?.title).toBe("Fix the flaky test");
  });

  it("keeps project colors the same whatever range is shown", async () => {
    const world = createWorld();
    world.threads.push(
      thread({ id: "thr_web", projectId: "proj_web" }),
      thread({ id: "thr_api", projectId: "proj_api" }),
    );
    const recent = Date.now() - 2 * 86_400_000;
    world.events.set("thr_web", turnEvents("thr_web", [[recent, recent + 3_600_000]]));
    world.events.set(
      "thr_api",
      turnEvents("thr_api", [[recent - 86_400_000, recent - 85_000_000]]),
    );
    await plugin(world.host.bb);

    const oneDay = activitySchema.parse(
      await world.host.harness.callRpc("activity", {
        from: recent - 3_600_000,
        to: recent + 2 * 3_600_000,
        mergeGapMinutes: 30,
      }),
    );

    expect(oneDay.threads.map((item) => item.id)).toEqual(["thr_web"]);
    // Both projects keep their slots, in bb's project order.
    expect(oneDay.colorOrder).toEqual(["proj_web", "proj_api"]);
  });

  it("pages through long turn histories", async () => {
    const world = createWorld();
    world.threads.push(thread({ id: "thr_long" }));
    const turns = Array.from({ length: 80 }, (_, index): [number, number] => [
      at(5, 0) + index * 10 * 60_000,
      at(5, 0) + index * 10 * 60_000 + 60_000,
    ]);
    world.events.set("thr_long", turnEvents("thr_long", turns));
    await plugin(world.host.bb);

    const activity = activitySchema.parse(await world.host.harness.callRpc("activity", WEEK));

    expect(activity.blocks).toHaveLength(1);
    expect(activity.blocks[0]!.turnCount).toBe(80);
    expect(world.host.harness.sdk.callsTo("threads.events.list").length).toBeGreaterThan(1);
  });

  it("only re-reads threads that changed since the last sync", async () => {
    const world = await loadWorld();
    world.threads.push(thread({ id: "thr_a" }), thread({ id: "thr_b" }));
    world.events.set("thr_a", turnEvents("thr_a", [[at(5, 9), at(5, 10)]]));
    world.events.set("thr_b", turnEvents("thr_b", [[at(5, 11), at(5, 12)]]));
    await world.host.harness.callRpc("activity", WEEK);
    const firstReads = world.host.harness.sdk.callsTo("threads.events.list").length;

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    world.events.get("thr_b")!.push(...turnEvents("thr_b", [[at(5, 15), at(5, 16)]], 3));
    world.threads[1]!.updatedAt = at(5, 16);
    const activity = activitySchema.parse(await world.host.harness.callRpc("activity", WEEK));

    const reads = world.host.harness.sdk.callsTo("threads.events.list").slice(firstReads);
    expect(reads.map(([args]) => (args as { threadId: string }).threadId)).toEqual(["thr_b"]);
    expect((reads[0]![0] as { afterSeq: string }).afterSeq).toBe("2");
    expect(activity.blocks.filter((block) => block.threadId === "thr_b")).toHaveLength(2);
  });

  it("shows running turns as ongoing and caps abandoned ones", async () => {
    const world = createWorld();
    world.threads.push(
      thread({ id: "thr_running", status: "active" }),
      thread({ id: "thr_crashed", status: "idle", updatedAt: at(5, 10, 40) }),
    );
    world.events.set("thr_running", turnEvents("thr_running", [[Date.now() - 20 * 60_000, null]]));
    world.events.set("thr_crashed", turnEvents("thr_crashed", [[at(5, 10), null]]));
    await plugin(world.host.bb);

    const activity = activitySchema.parse(
      await world.host.harness.callRpc("activity", {
        from: Math.min(at(5, 0), Date.now() - 86_400_000),
        to: Math.max(at(12, 0), Date.now() + 3_600_000),
        mergeGapMinutes: 30,
      }),
    );

    const running = activity.blocks.find((block) => block.threadId === "thr_running");
    const crashed = activity.blocks.find((block) => block.threadId === "thr_crashed");
    expect(running?.ongoing).toBe(true);
    expect(running!.end).toBeGreaterThanOrEqual(Date.now());
    expect(crashed).toMatchObject({ start: at(5, 10), end: at(5, 10, 45), ongoing: false });
  });

  it("follows lifecycle events between full syncs", async () => {
    const world = createWorld();
    world.threads.push(thread({ id: "thr_a" }));
    await plugin(world.host.bb);
    await world.host.harness.callRpc("activity", WEEK);

    vi.useFakeTimers();
    world.events.set("thr_a", turnEvents("thr_a", [[at(5, 13), at(5, 13, 40)]]));
    await world.host.harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_a", projectId: "proj_web", updatedAt: at(5, 13, 40) }),
      lastAssistantText: null,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();

    const activity = activitySchema.parse(await world.host.harness.callRpc("activity", WEEK));
    expect(activity.blocks).toEqual([
      expect.objectContaining({ threadId: "thr_a", start: at(5, 13) }),
    ]);
    expect(world.host.harness.realtimeSignals.map((signal) => signal.channel)).toContain(
      "activity-changed",
    );
  });

  it("drops deleted threads from the calendar", async () => {
    const world = createWorld();
    world.threads.push(thread({ id: "thr_a" }));
    world.events.set("thr_a", turnEvents("thr_a", [[at(5, 9), at(5, 10)]]));
    await plugin(world.host.bb);
    await world.host.harness.callRpc("activity", WEEK);

    await world.host.harness.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "thr_a" }),
    });

    const activity = activitySchema.parse(await world.host.harness.callRpc("activity", WEEK));
    expect(activity.blocks).toEqual([]);
  });

  it("rejects ranges longer than 62 days and unknown merge gaps", async () => {
    const { host } = await loadWorld();
    await expect(
      host.harness.callRpc("activity", { from: 0, to: 63 * 86_400_000, mergeGapMinutes: 30 }),
    ).rejects.toThrow();
    await expect(
      host.harness.callRpc("activity", { ...WEEK, mergeGapMinutes: 45 }),
    ).rejects.toThrow();
  });

  it("prints a time sheet and a log from the CLI", async () => {
    const world = createWorld();
    world.threads.push(thread({ id: "thr_a", title: "Fix the flaky test" }));
    world.events.set("thr_a", turnEvents("thr_a", [[at(6, 9, 10), at(6, 10, 20)]]));
    await plugin(world.host.bb);

    const sheet = await world.host.harness.runCli(["timesheet", "--week", "2026-10-07"]);
    expect(sheet.exitCode).toBe(0);
    expect(sheet.stdout).toContain("Fix the flaky test (thr_a)");
    expect(sheet.stdout).toMatch(/Total(\s+[\d.]+){7}\s+1\.5\n/);

    const log = await world.host.harness.runCli(["log", "--day", "2026-10-06", "--json"]);
    const parsed = JSON.parse(log.stdout) as {
      projects: Array<{ id: string; name: string }>;
      blocks: Array<{ start: number; end: number }>;
    };
    expect(parsed.projects).toEqual([{ id: "proj_web", name: "web" }]);
    expect(parsed.blocks).toEqual([
      expect.objectContaining({ start: at(6, 9), end: at(6, 10, 30) }),
    ]);

    const usage = await world.host.harness.runCli(["log", "--gap", "45"]);
    expect(usage.exitCode).toBe(2);
    expect(usage.stderr).toContain("Invalid --gap value: 45");
  });
});

describe("parseCliArgs", () => {
  const now = at(7, 15);

  it("defaults to this week's time sheet and today's log", () => {
    expect(parseCliArgs([], now)).toMatchObject({
      kind: "run",
      command: "timesheet",
      range: { from: at(5, 0), to: at(12, 0) },
      gap: 30,
    });
    expect(parseCliArgs(["log"], now)).toMatchObject({
      command: "log",
      range: { from: at(7, 0), to: at(8, 0) },
    });
  });

  it("resolves relative and explicit dates", () => {
    expect(parseCliArgs(["--week", "last"], now)).toMatchObject({
      range: { from: new Date(2026, 8, 28).getTime() },
    });
    expect(parseCliArgs(["log", "--day=yesterday", "--gap", "60"], now)).toMatchObject({
      range: { from: at(6, 0) },
      gap: 60,
    });
  });

  it("rejects invalid input", () => {
    expect(parseCliArgs(["--week", "2026-02-30"], now)).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["timesheet", "--day", "today"], now)).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["--day", "today", "--week", "this"], now)).toMatchObject({
      kind: "error",
    });
    expect(parseCliArgs(["export"], now)).toMatchObject({ kind: "error" });
  });
});
