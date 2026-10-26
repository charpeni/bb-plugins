import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { TRACE_CHANNEL, TRACE_EVENT_TYPES } from "./trace.js";

const T0 = 1_800_000_000_000;

interface FakeEvent {
  id: string;
  seq: number;
  threadId: string;
  createdAt: number;
  type: string;
  scope: { kind: string; turnId?: string };
  data: unknown;
}

interface FakeThread {
  id: string;
  title: string;
  projectId: string;
  providerId: string;
  parentThreadId: string | null;
  createdAt: number;
  updatedAt: number;
}

type ChangeCallback = (event: {
  id?: string;
  changes: string[];
  metadata?: { eventTypes?: string[] };
}) => void;

function createWorld() {
  const events: FakeEvent[] = [];
  const threads: FakeThread[] = [];
  let onChange: ChangeCallback | null = null;
  // Runs once during the next history read, to change the world mid-read.
  let duringNextRead: (() => void) | null = null;
  const thread = (id: string, overrides: Partial<FakeThread> = {}) => {
    threads.push({
      id,
      title: `Thread ${id}`,
      projectId: "proj_1",
      providerId: "claude-code",
      parentThreadId: null,
      createdAt: T0,
      updatedAt: T0,
      ...overrides,
    });
  };
  const push = (
    type: string,
    turnId: string | undefined,
    data: unknown,
    atSeconds: number,
    threadId = "thr_a",
  ) => {
    const seq = events.filter((event) => event.threadId === threadId).length + 1;
    events.push({
      id: `ev_${threadId}_${seq}`,
      seq,
      threadId,
      createdAt: T0 + atSeconds * 1_000,
      type,
      scope: turnId ? { kind: "turn", turnId } : { kind: "thread" },
      data,
    });
  };
  thread("thr_a");
  const host = createFakePluginHost({
    pluginId: "agent-traces",
    sdk: {
      subscribe: (args: { callback: ChangeCallback }) => {
        onChange = args.callback;
        return () => {
          onChange = null;
        };
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          threads.find((row) => row.id === threadId),
        list: async (args: { parentThreadId?: string; projectId?: string; archived?: boolean }) =>
          args.archived
            ? []
            : threads.filter(
                (row) =>
                  (args.parentThreadId === undefined ||
                    row.parentThreadId === args.parentThreadId) &&
                  (args.projectId === undefined || row.projectId === args.projectId),
              ),
        events: {
          list: async (args: { threadId: string; afterSeq?: string; limit?: string }) => {
            const page = events
              .filter((event) => event.threadId === args.threadId)
              .filter((event) => event.seq > Number(args.afterSeq ?? 0))
              .slice(0, Number(args.limit ?? 100));
            const hook = duringNextRead;
            duringNextRead = null;
            hook?.();
            return page;
          },
        },
      },
    } as never,
  });
  return {
    host,
    events,
    threads,
    thread,
    push,
    duringNextRead: (hook: () => void) => {
      duringNextRead = hook;
    },
    call: (method: string, input: unknown) =>
      host.harness.behavior.callRpc(method, input) as Promise<any>,
    change: (event: Parameters<ChangeCallback>[0]) => onChange?.(event),
  };
}

type World = ReturnType<typeof createWorld>;

/** One turn with `commands` quick commands, one second apart. */
function seedTurn(world: World, turnId: string, commands: number, at = 0, threadId = "thr_a") {
  world.push(
    "client/turn/requested",
    undefined,
    { requestId: `req_${turnId}`, input: [{ type: "text", text: `Run ${turnId}` }] },
    at,
    threadId,
  );
  world.push("turn/started", turnId, {}, at, threadId);
  world.push("turn/input/accepted", turnId, { clientRequestId: `req_${turnId}` }, at, threadId);
  for (let i = 0; i < commands; i++) {
    const item = { id: `${turnId}-i${i}`, type: "commandExecution", command: `echo ${i}` };
    world.push(
      "item/started",
      turnId,
      { item: { ...item, status: "pending" } },
      at + i + 0.5,
      threadId,
    );
    world.push(
      "item/completed",
      turnId,
      {
        item: {
          ...item,
          status: "completed",
          exitCode: 0,
          aggregatedOutput: `line 1\nresult ${i}\n`,
        },
      },
      at + i + 1,
      threadId,
    );
  }
  world.push("turn/completed", turnId, { status: "completed" }, at + commands + 2, threadId);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Agent Traces server", () => {
  it("returns turn summaries with phases, and spans for the requested turn", async () => {
    const world = createWorld();
    seedTurn(world, "t1", 2);
    seedTurn(world, "t2", 60, 100);
    await plugin(world.host.bb);

    const overview = await world.call("trace", { threadId: "thr_a" });
    expect(overview).toMatchObject({ title: "Thread thr_a", projectId: "proj_1", focus: null });
    expect(overview.turns).toEqual([
      expect.objectContaining({
        id: "t1",
        index: 1,
        prompt: "Run t1",
        toolCalls: 2,
        requestSeq: 1,
      }),
      expect.objectContaining({ id: "t2", index: 2, prompt: "Run t2", toolCalls: 60 }),
    ]);
    expect(overview.turns[0].phases.tools).toBe(1_000);

    const focused = await world.call("trace", { threadId: "thr_a", turnId: "t2" });
    expect(focused.focus.id).toBe("t2");
    expect(focused.focus.spans).toHaveLength(60);
  });

  it("pages through history once, filtered to trace events, then reads only what is new", async () => {
    const world = createWorld();
    seedTurn(world, "t1", 60);
    await plugin(world.host.bb);

    await world.call("trace", { threadId: "thr_a" });
    const firstReads = world.host.harness.sdk.callsTo("threads.events.list");
    expect(firstReads.map(([args]) => (args as { afterSeq: string }).afterSeq)).toEqual([
      "0",
      "100",
    ]);
    expect((firstReads[0][0] as { types: string[] }).types).toEqual([...TRACE_EVENT_TYPES]);

    const seen = world.events.length;
    seedTurn(world, "t2", 1, 200);
    const next = await world.call("trace", { threadId: "thr_a" });
    expect(next.turns).toHaveLength(2);
    const reads = world.host.harness.sdk.callsTo("threads.events.list");
    expect((reads[reads.length - 1][0] as { afterSeq: string }).afterSeq).toBe(String(seen));
  });

  it("reads a span's output from the event that ended it", async () => {
    const world = createWorld();
    seedTurn(world, "t1", 2);
    await plugin(world.host.bb);

    const details = await world.call("span", { threadId: "thr_a", spanId: "t1-i1" });
    expect(details).toMatchObject({
      output: "line 1\nresult 1",
      exitCode: 0,
      outputTruncated: false,
    });
  });

  it("folds threads spawned during a turn into it", async () => {
    const world = createWorld();
    seedTurn(world, "t1", 3);
    world.thread("thr_child", {
      parentThreadId: "thr_a",
      createdAt: T0 + 2_000,
      title: "Fix the docs",
    });
    seedTurn(world, "c1", 2, 2.5, "thr_child");
    await plugin(world.host.bb);

    const focused = await world.call("trace", { threadId: "thr_a", turnId: "t1" });
    const child = focused.focus.spans.find(
      (span: { id: string }) => span.id === "thread:thr_child",
    );
    expect(child).toMatchObject({
      kind: "thread",
      name: "Fix the docs",
      background: true,
      status: "completed",
    });
    expect(
      focused.focus.spans.filter(
        (span: { parentId: string }) => span.parentId === "thread:thr_child",
      ),
    ).toHaveLength(2);

    const output = await world.call("span", {
      threadId: "thr_a",
      spanId: "thread:thr_child/c1-i0",
    });
    expect(output.output).toBe("line 1\nresult 0");
  });

  it("groups calls by what they ran, for the thread or the project", async () => {
    const world = createWorld();
    seedTurn(world, "t1", 2);
    world.thread("thr_b");
    seedTurn(world, "u1", 1, 0, "thr_b");
    await plugin(world.host.bb);

    const thread = await world.call("commands", { threadId: "thr_a", scope: "thread" });
    expect(thread).toMatchObject({ scope: "thread", threads: 1 });
    expect(thread.rows[0]).toMatchObject({ signature: "echo", count: 2 });

    const project = await world.call("commands", { threadId: "thr_a", scope: "project" });
    expect(project.threads).toBe(2);
    expect(project.rows[0]).toMatchObject({ signature: "echo", count: 3, threads: 2 });
  });

  it("exports a turn as OTLP/JSON or an HTML snapshot", async () => {
    const world = createWorld();
    seedTurn(world, "t1", 2);
    await plugin(world.host.bb);

    const otlp = await world.call("exportTurn", {
      threadId: "thr_a",
      turnId: "t1",
      format: "otlp",
    });
    expect(otlp).toMatchObject({
      fileName: "thread-thr-a-turn-1.otlp.json",
      mimeType: "application/json",
    });
    expect(JSON.parse(otlp.content).resourceSpans[0].scopeSpans[0].spans[0].name).toBe("turn #1");

    const html = await world.call("exportTurn", {
      threadId: "thr_a",
      turnId: "t1",
      format: "html",
    });
    expect(html.content).toContain("<!doctype html>");
  });

  it("sends a turn to the configured collector, and finished turns on their own once enabled", async () => {
    const world = createWorld();
    seedTurn(world, "t1", 1);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await plugin(world.host.bb);

    expect(await world.call("sendTurn", { threadId: "thr_a", turnId: "t1" })).toMatchObject({
      ok: false,
    });
    await world.host.harness.behavior.setSettings({
      otlpEndpoint: "http://collector.test/v1/traces",
      otlpHeaders: "authorization=Bearer abc",
    });
    expect(await world.call("sendTurn", { threadId: "thr_a", turnId: "t1" })).toMatchObject({
      ok: true,
      status: 200,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://collector.test/v1/traces");
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer abc",
    });

    await world.host.harness.behavior.setSettings({ autoExport: true });
    const thread = { id: "thr_a" } as never;
    await world.host.harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: null,
    } as never);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // Nothing new finished, so nothing is sent again.
    await world.host.harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: null,
    } as never);
    seedTurn(world, "t2", 1, 100);
    await world.host.harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: null,
    } as never);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const body = JSON.parse(
      (fetchMock.mock.calls[2] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.resourceSpans[0].scopeSpans[0].spans[0].name).toBe("turn #2");
  });

  it("answers in the terminal and to agents", async () => {
    const world = createWorld();
    seedTurn(world, "t1", 2);
    await plugin(world.host.bb);

    const show = await world.host.harness.behavior.runCli(["show"], { threadId: "thr_a" } as never);
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain("Turn #1");
    const missing = await world.host.harness.behavior.runCli(["show", "--turn", "9", "thr_a"]);
    expect(missing.exitCode).not.toBe(0);

    const tool = await world.host.harness.behavior.callAgentTool(
      "agent_traces",
      { view: "turns" },
      { threadId: "thr_a" },
    );
    expect(JSON.stringify(tool)).toContain("Run t1");
  });

  it("totals threads for the Traces page, reading one again only when it changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 400_000);
    const world = createWorld();
    world.thread("thr_b");
    seedTurn(world, "t1", 2);
    seedTurn(world, "t2", 1, 100);
    seedTurn(world, "u1", 3, 0, "thr_b");
    world.push("turn/started", "u2", {}, 300, "thr_b");
    await plugin(world.host.bb);
    const reads = () => world.host.harness.sdk.callsTo("threads.events.list");
    const both = [
      { threadId: "thr_a", version: "1" },
      { threadId: "thr_b", version: "1" },
    ];

    const first = await world.call("threadTotals", { threads: both });
    expect(first.rows).toEqual([
      expect.objectContaining({ threadId: "thr_a", error: null, turns: 2, toolCalls: 3 }),
      expect.objectContaining({ threadId: "thr_b", turns: 2, runningSince: T0 + 300_000 }),
    ]);
    expect(first.rows[0].runningSince).toBeNull();
    expect(first.rows[1].activeMs).toBe(5_000 + 100_000);

    // The finished thread comes from memory; the running one reads only what is new.
    const before = reads().length;
    await world.call("threadTotals", { threads: both });
    expect(
      reads()
        .slice(before)
        .map(([args]) => args),
    ).toEqual([
      expect.objectContaining({
        threadId: "thr_b",
        afterSeq: String(world.events.filter((event) => event.threadId === "thr_b").length),
      }),
    ]);

    seedTurn(world, "t3", 1, 200);
    const changed = await world.call("threadTotals", {
      threads: [{ threadId: "thr_a", version: "2" }],
    });
    expect(changed.rows[0].turns).toBe(3);

    // Listing keeps only the running thread's trace, so only its changes are signaled.
    for (const id of ["thr_a", "thr_b"]) {
      world.change({
        id,
        changes: ["events-appended"],
        metadata: { eventTypes: ["item/started"] },
      });
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(world.host.harness.inspection.realtimeSignals).toEqual([
      expect.objectContaining({ channel: TRACE_CHANNEL, payload: { threadId: "thr_b" } }),
    ]);
  });

  it("rereads history rewritten after any read, even one under way", async () => {
    const world = createWorld();
    seedTurn(world, "t1", 1);
    await plugin(world.host.bb);
    const afterSeqs = () =>
      world.host.harness.sdk
        .callsTo("threads.events.list")
        .map(([args]) => (args as { afterSeq: string }).afterSeq);

    // No trace is open: the command stats alone read the thread.
    await world.call("commands", { threadId: "thr_a", scope: "thread" });
    world.change({ id: "thr_a", changes: ["history-rewritten"] });
    await world.call("commands", { threadId: "thr_a", scope: "thread" });
    expect(afterSeqs()).toEqual(["0", "0"]);

    // Rewritten while the read is under way: that read starts over instead of keeping it.
    world.change({ id: "thr_a", changes: ["history-rewritten"] });
    world.duringNextRead(() => world.change({ id: "thr_a", changes: ["history-rewritten"] }));
    await world.call("trace", { threadId: "thr_a" });
    expect(afterSeqs().slice(2)).toEqual(["0", "0"]);
    await world.call("trace", { threadId: "thr_a" });
    expect(afterSeqs().at(-1)).toBe(String(world.events.length));
  });

  it("picks up a renamed thread", async () => {
    const world = createWorld();
    seedTurn(world, "t1", 1);
    await plugin(world.host.bb);
    expect((await world.call("trace", { threadId: "thr_a" })).title).toBe("Thread thr_a");
    world.threads[0].title = "Fix the checkout";
    world.change({ id: "thr_a", changes: ["title-changed"] });
    expect((await world.call("trace", { threadId: "thr_a" })).title).toBe("Fix the checkout");
  });

  it("reads a project's threads for stats without keeping their traces", async () => {
    vi.useFakeTimers();
    const world = createWorld();
    world.thread("thr_b");
    seedTurn(world, "t1", 2);
    seedTurn(world, "u1", 1, 0, "thr_b");
    await plugin(world.host.bb);

    const stats = await world.call("commands", { threadId: "thr_a", scope: "project" });
    expect(stats.threads).toBe(2);
    for (const id of ["thr_a", "thr_b"]) {
      world.change({
        id,
        changes: ["events-appended"],
        metadata: { eventTypes: ["item/started"] },
      });
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(world.host.harness.inspection.realtimeSignals).toEqual([]);
  });

  it("signals open traces when span events land, and rereads rewritten history", async () => {
    vi.useFakeTimers();
    const world = createWorld();
    seedTurn(world, "t1", 1);
    await plugin(world.host.bb);
    await world.call("trace", { threadId: "thr_a" });
    const signals = () => world.host.harness.inspection.realtimeSignals;

    world.change({
      id: "thr_a",
      changes: ["events-appended"],
      metadata: { eventTypes: ["item/agentMessage/delta"] },
    });
    world.change({ id: "thr_other", changes: ["events-appended"] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signals()).toHaveLength(0);

    world.change({
      id: "thr_a",
      changes: ["events-appended"],
      metadata: { eventTypes: ["item/started"] },
    });
    world.change({
      id: "thr_a",
      changes: ["events-appended"],
      metadata: { eventTypes: ["item/completed"] },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signals()).toEqual([
      expect.objectContaining({ channel: TRACE_CHANNEL, payload: { threadId: "thr_a" } }),
    ]);

    world.change({ id: "thr_a", changes: ["history-rewritten"] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signals()).toHaveLength(2);
    const before = world.host.harness.sdk.callsTo("threads.events.list").length;
    await world.call("trace", { threadId: "thr_a" });
    const reread = world.host.harness.sdk.callsTo("threads.events.list").slice(before);
    expect((reread[0][0] as { afterSeq: string }).afterSeq).toBe("0");
  });
});
