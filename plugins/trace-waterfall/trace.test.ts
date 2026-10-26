import { describe, expect, it } from "vitest";
import { laneBreakdown, turnStats } from "./breakdown.js";
import {
  formatDuration,
  formatTokens,
  shellCommands,
  TraceBuilder,
  type TraceEvent,
} from "./trace.js";

const T0 = 1_800_000_000_000;

/** A small event log writer: `at` is seconds after T0. */
function log() {
  const events: TraceEvent[] = [];
  let seq = 0;
  const push = (at: number, type: string, data: unknown, turnId?: string) => {
    events.push({
      seq: ++seq,
      createdAt: T0 + at * 1_000,
      type,
      scope: turnId ? { kind: "turn", turnId } : { kind: "thread" },
      data,
    });
  };
  return {
    events,
    request: (at: number, requestId: string, text: string) =>
      push(at, "client/turn/requested", { requestId, input: [{ type: "text", text }] }),
    turn: (at: number, turnId: string, extra: Record<string, unknown> = {}) =>
      push(at, "turn/started", { providerThreadId: "p", ...extra }, turnId),
    accept: (at: number, turnId: string, clientRequestId: string) =>
      push(at, "turn/input/accepted", { clientRequestId }, turnId),
    done: (at: number, turnId: string, status = "completed") =>
      push(at, "turn/completed", { status }, turnId),
    start: (at: number, turnId: string | undefined, item: Record<string, unknown>) =>
      push(at, "item/started", { item: { status: "pending", ...item } }, turnId),
    finish: (at: number, turnId: string | undefined, item: Record<string, unknown>) =>
      push(at, "item/completed", { item: { status: "completed", ...item } }, turnId),
    raw: push,
  };
}

function build(events: readonly TraceEvent[]) {
  const builder = new TraceBuilder();
  builder.apply(events);
  return builder.snapshot();
}

describe("TraceBuilder", () => {
  it("builds a turn with its prompt and tool spans", () => {
    const l = log();
    l.request(0, "creq_1", "Fix the flaky test\nThen open a PR");
    l.turn(1, "t1");
    l.accept(1, "t1", "creq_1");
    const command = {
      id: "i1",
      type: "commandExecution",
      command: '/bin/bash -lc "cd web && npm test"',
    };
    l.start(5, "t1", command);
    l.finish(12, "t1", command);
    const read = { id: "i2", type: "fileRead", path: "/repo/src/flaky.test.ts" };
    l.start(13, "t1", read);
    l.finish(13, "t1", read);
    l.start(14, "t1", { id: "r1", type: "reasoning" });
    l.done(20, "t1");

    const [turn] = build(l.events);
    // The second between sending the prompt and the agent starting counts as the turn's.
    expect(turn).toMatchObject({
      id: "t1",
      index: 1,
      prompt: "Fix the flaky test Then open a PR",
      start: T0,
      end: T0 + 20_000,
      status: "completed",
      requestSeq: 1,
    });
    expect(turn.spans).toEqual([
      expect.objectContaining({ kind: "startup", start: T0, end: T0 + 1_000 }),
      expect.objectContaining({
        id: "i1",
        kind: "command",
        name: "npm",
        detail: "cd web && npm test",
        start: T0 + 5_000,
        end: T0 + 12_000,
        parentId: null,
      }),
      expect.objectContaining({ id: "i2", kind: "read", name: "Read", detail: "flaky.test.ts" }),
    ]);
  });

  it("folds subagent turns into the turn that spawned them", () => {
    const l = log();
    l.turn(0, "t1");
    const delegation = {
      id: "d1",
      type: "delegation",
      childRef: "c",
      label: "Review standards",
      background: false,
    };
    l.start(2, "t1", delegation);
    l.start(2, "t1", {
      id: "b1",
      type: "backgroundTask",
      taskType: "local_agent",
      parentToolCallId: "d1",
    });
    l.turn(3, "t2", { parentToolCallId: "d1" });
    const nested = { id: "i9", type: "commandExecution", command: "git diff" };
    l.start(4, "t2", nested);
    l.finish(6, "t2", nested);
    // Claude Code reports a subagent's usage outside any turn.
    l.raw(30, "item/backgroundTask/completed", {
      item: {
        id: "b1",
        type: "backgroundTask",
        taskType: "local_agent",
        parentToolCallId: "d1",
        usage: { totalTokens: 98_521 },
      },
    });
    l.done(30, "t2");
    l.finish(31, "t1", delegation);
    l.done(40, "t1");

    const turns = build(l.events);
    expect(turns).toHaveLength(1);
    const [turn] = turns;
    expect(turn.spans.map((span) => [span.id, span.kind, span.parentId])).toEqual([
      ["d1", "subagent", null],
      ["i9", "command", "d1"],
    ]);
    expect(turn.spans[0]).toMatchObject({
      name: "Review standards",
      tokens: 98_521,
      end: T0 + 31_000,
    });
    expect(turnStats(turn, T0).subagentTokens).toBe(98_521);
  });

  it("nests items that only carry the subagent turn, not a parent id", () => {
    const l = log();
    l.turn(0, "t1");
    l.start(1, "t1", {
      id: "a1",
      type: "toolCall",
      tool: "Agent",
      arguments: { description: "Explore the repo" },
    });
    l.turn(2, "t2", { parentToolCallId: "a1" });
    l.start(3, "t2", { id: "i2", type: "search", query: "TODO" });

    const [turn] = build(l.events);
    expect(turn.spans.map((span) => [span.name, span.kind, span.parentId])).toEqual([
      ["Explore the repo", "subagent", null],
      ["Search", "search", "a1"],
    ]);
  });

  it("ignores events it already folded, so pages can overlap", () => {
    const l = log();
    l.turn(0, "t1");
    for (let i = 0; i < 6; i++) {
      const item = { id: `i${i}`, type: "commandExecution", command: `echo ${i}` };
      l.start(i * 2 + 1, "t1", item);
      l.finish(i * 2 + 2, "t1", item);
    }
    const builder = new TraceBuilder();
    builder.apply(l.events.slice(0, 5));
    builder.apply(l.events.slice(0, 9));
    builder.apply(l.events);
    expect(builder.snapshot()).toEqual(build(l.events));
    expect(builder.lastSeq).toBe(l.events.length);
  });

  it("keeps running turns and spans open", () => {
    const l = log();
    l.turn(0, "t1");
    l.start(2, "t1", {
      id: "i1",
      type: "toolCall",
      tool: "WebSearch",
      presentation: { title: "bb plugins", label: {}, icon: {} },
    });

    const [turn] = build(l.events);
    expect(turn).toMatchObject({ end: null, status: "running" });
    expect(turn.spans[0]).toMatchObject({
      name: "WebSearch",
      detail: "bb plugins",
      end: null,
      status: "running",
    });
    const now = T0 + 10_000;
    expect(turnStats(turn, now)).toMatchObject({
      durationMs: 10_000,
      modelMs: 2_000,
      toolCalls: 1,
    });
    expect(turn.activity).toEqual([]);
  });

  it("keeps a background subagent running until its agent task ends", () => {
    const l = log();
    l.turn(0, "t1");
    const delegation = {
      id: "d1",
      type: "delegation",
      childRef: "c",
      label: "Trace the race",
      background: false,
    };
    const task = {
      id: "b1",
      type: "backgroundTask",
      taskType: "local_agent",
      parentToolCallId: "d1",
    };
    l.start(2, "t1", delegation);
    l.start(2, "t1", task);
    // The tool call returns at once; the agent keeps working.
    l.finish(2.05, "t1", delegation);
    l.raw(30, "item/backgroundTask/progress", {
      item: { ...task, status: "pending", usage: { totalTokens: 15_251 } },
    });

    const [running] = build(l.events);
    expect(running.spans[0]).toMatchObject({ end: null, status: "running", tokens: 15_251 });

    l.raw(400, "item/backgroundTask/completed", {
      item: { ...task, status: "completed", usage: { totalTokens: 32_934 } },
    });
    const [done] = build(l.events);
    expect(done.spans[0]).toMatchObject({
      end: T0 + 400_000,
      status: "completed",
      tokens: 32_934,
    });
  });

  it("treats a subagent whose call returned while its agent works as background", () => {
    const l = log();
    l.turn(0, "t1");
    const agent = {
      id: "c1",
      type: "toolCall",
      tool: "Agent",
      arguments: { description: "Check the race" },
    };
    const task = {
      id: "b1",
      type: "backgroundTask",
      taskType: "local_agent",
      parentToolCallId: "c1",
    };
    l.start(1, "t1", agent);
    l.finish(1.1, "t1", agent);
    l.start(1.2, "t1", task);
    const watcher = {
      id: "c2",
      type: "toolCall",
      tool: "Agent",
      arguments: { description: "Watch CI", run_in_background: true },
    };
    l.start(1.5, "t1", watcher);
    l.done(3, "t1");

    const [turn] = build(l.events);
    // Still working after the turn ended, without counting against the turn's own agent.
    expect(turn.spans[0]).toMatchObject({ id: "c1", background: true, status: "running" });
    expect(turn.spans[0].end).toBeNull();
    expect(turn.spans[1]).toMatchObject({ detail: "background subagent", background: true });
    expect(laneBreakdown(turn, null, T0 + 3_000).totals.subagents).toBe(0);
  });

  it("keeps a subagent's turn in its turn when it is recorded before its tool call", () => {
    const l = log();
    l.turn(0, "t1");
    l.turn(1, "t2", { parentToolCallId: "c1" });
    const read = { id: "i1", type: "fileRead", path: "/repo/a.ts" };
    l.start(1.5, "t2", read);
    l.finish(1.6, "t2", read);
    const agent = { id: "c1", type: "toolCall", tool: "Agent", arguments: { description: "Look" } };
    l.start(2, "t1", agent);
    l.finish(5, "t1", agent);
    l.done(6, "t1");

    const turns = build(l.events);
    expect(turns).toHaveLength(1);
    expect(turns[0].spans.find((span) => span.id === "i1")?.parentId).toBe("c1");
  });

  it("keeps each turn's sequence range to its own run", () => {
    const l = log();
    l.request(0, "creq_1", "First");
    l.turn(0, "t1");
    l.accept(0, "t1", "creq_1");
    const server = { id: "bg1", type: "backgroundTask", taskType: "shell", description: "dev" };
    l.start(1, "t1", server);
    // Sent while the first turn runs, so it waits in the queue.
    l.request(2, "creq_2", "Second");
    l.done(3, "t1");
    l.turn(4, "t2");
    l.accept(4, "t2", "creq_2");
    // The dev server stops while the second turn runs; it reports into the first.
    l.raw(5, "item/backgroundTask/completed", { item: { ...server, status: "completed" } });
    l.done(6, "t2");

    const [first, second] = build(l.events);
    expect(first).toMatchObject({ requestSeq: 1, firstSeq: 2, lastSeq: 6 });
    expect(second).toMatchObject({ requestSeq: 5, firstSeq: 7, lastSeq: 10 });
    expect(first.spans[0].end).toBe(T0 + 5_000);
  });

  it("marks bb's own notices", () => {
    const l = log();
    l.request(0, "creq_1", "[bb system] @thread:thr_child completed: Opened a draft pull request");
    l.turn(1, "t1");
    l.accept(1, "t1", "creq_1");

    const [turn] = build(l.events);
    expect(turn).toMatchObject({
      prompt: "@thread:thr_child completed: Opened a draft pull request",
      sender: "bb",
    });
  });

  it("shows prompts from other threads without bb's prefix", () => {
    const l = log();
    l.raw(0, "client/turn/requested", {
      requestId: "creq_1",
      senderThreadId: "thr_parent",
      input: [{ type: "text", text: "[bb message from thread:thr_parent]\n\nFix the flaky test" }],
    });
    l.turn(1, "t1");
    l.accept(1, "t1", "creq_1");

    const [turn] = build(l.events);
    expect(turn).toMatchObject({ prompt: "Fix the flaky test", sender: "thr_parent" });
  });

  it("names commands after what runs, not the files they write first", () => {
    const l = log();
    l.turn(0, "t1");
    const command = [
      "mkdir -p /tmp/x && cd /tmp/x && cat > probe.mjs <<'EOF'",
      "const a = 1; console.log(a | 2);",
      "EOF",
      "node probe.mjs 1000",
    ].join("\n");
    l.start(1, "t1", { id: "i1", type: "commandExecution", command });
    l.start(2, "t1", {
      id: "i2",
      type: "commandExecution",
      command: "FOO=1 echo hi > out.txt && tee log < out.txt; pnpm test",
    });

    const [turn] = build(l.events);
    expect(turn.spans.map((span) => span.name)).toEqual(["node", "pnpm"]);
  });

  it("labels agent-started turns and counts failures", () => {
    const l = log();
    l.turn(0, "t1");
    const failing = { id: "i1", type: "commandExecution", command: "npm test" };
    l.start(1, "t1", failing);
    l.finish(2, "t1", { ...failing, status: "failed" });
    l.done(3, "t1", "failed");

    const [turn] = build(l.events);
    expect(turn.prompt).toBe("");
    expect(turn.status).toBe("failed");
    expect(turnStats(turn, T0).errors).toBe(2);
  });
});

describe("calls that never reported finishing", () => {
  it("end with their finished turn, and go quiet after hours of silence", () => {
    const l = log();
    l.turn(0, "t1");
    l.start(1, "t1", { id: "i1", type: "commandExecution", command: "kill 123" });
    l.start(2, "t1", {
      id: "b1",
      type: "backgroundTask",
      taskType: "local_bash",
      description: "Dev server",
    });
    l.done(5, "t1", "interrupted");
    l.turn(10, "t2");
    l.start(11, "t2", { id: "i2", type: "commandExecution", command: "sleep 600" });

    const builder = new TraceBuilder();
    builder.apply(l.events);
    const [first, second] = builder.snapshot(T0 + 60_000);
    expect(first.spans.map((span) => [span.id, span.end, span.status])).toEqual([
      ["i1", T0 + 5_000, "interrupted"],
      // A background task may still be running a minute later.
      ["b1", null, "running"],
    ]);
    expect(second).toMatchObject({ end: null, status: "running" });

    const [staleFirst, staleSecond] = builder.snapshot(T0 + 7 * 60 * 60 * 1_000);
    expect(staleFirst.spans[1]).toMatchObject({ id: "b1", end: T0 + 5_000, status: "interrupted" });
    expect(staleSecond).toMatchObject({ end: T0 + 11_000, status: "interrupted" });
    expect(staleSecond.spans[0]).toMatchObject({
      end: T0 + 11_000,
      error: "Never reported finishing",
    });
  });
});

describe("laneBreakdown", () => {
  it("splits the agent's time into phases", () => {
    const l = log();
    l.request(0, "creq_1", "Fix it");
    l.turn(1, "t1");
    l.accept(1, "t1", "creq_1");
    const thinking = { id: "r1", type: "reasoning" };
    l.start(1, "t1", thinking);
    l.finish(3, "t1", thinking);
    const command = { id: "i1", type: "commandExecution", command: "pnpm test" };
    l.start(4, "t1", command);
    l.finish(6, "t1", command);
    // A dev server keeps running, but the agent goes on with other things.
    l.start(6, "t1", {
      id: "b1",
      type: "backgroundTask",
      taskType: "local_bash",
      description: "Dev server",
    });
    l.raw(6.5, "system/interaction/lifecycle", {
      interaction: {
        id: "pint_1",
        status: "pending",
        payload: { kind: "plugin", title: "Approve command" },
      },
    });
    l.raw(8, "system/interaction/lifecycle", { interaction: { id: "pint_1", status: "resolved" } });
    const compaction = { id: "c1", type: "contextCompaction" };
    l.start(8, "t1", compaction);
    l.finish(8.5, "t1", compaction);
    const reply = { id: "m1", type: "agentMessage" };
    l.start(9, "t1", reply);
    l.finish(10, "t1", reply);
    l.done(10, "t1");

    const [turn] = build(l.events);
    const { segments, totals } = laneBreakdown(turn, null, T0);
    expect(
      segments.map((segment) => [segment.phase, segment.start - T0, segment.end - T0]),
    ).toEqual([
      ["startup", 0, 1_000],
      ["thinking", 1_000, 3_000],
      ["model", 3_000, 4_000],
      ["tools", 4_000, 6_000],
      ["model", 6_000, 6_500],
      ["waiting", 6_500, 8_000],
      ["compaction", 8_000, 8_500],
      ["model", 8_500, 9_000],
      ["writing", 9_000, 10_000],
    ]);
    expect(totals).toMatchObject({ model: 2_000, thinking: 2_000, writing: 1_000, waiting: 1_500 });
    expect(turnStats(turn, T0)).toMatchObject({ durationMs: 10_000, modelMs: 5_000, toolCalls: 2 });
  });

  it("counts a running agent's time up to now", () => {
    const l = log();
    l.turn(0, "t1");
    l.start(2, "t1", { id: "i1", type: "commandExecution", command: "sleep 60" });

    const [turn] = build(l.events);
    expect(laneBreakdown(turn, null, T0 + 5_000).totals).toMatchObject({
      model: 2_000,
      tools: 3_000,
    });
  });
});

describe("what went wrong", () => {
  it("keeps exit codes and errors, and links spans to the reply that followed", () => {
    const l = log();
    l.request(0, "creq_1", "Run the tests");
    l.turn(0.1, "t1");
    l.accept(0.1, "t1", "creq_1");
    const failing = { id: "i1", type: "commandExecution", command: "pnpm test" };
    l.start(1, "t1", failing);
    l.finish(2, "t1", { ...failing, status: "failed", exitCode: 1 });
    const tool = { id: "i2", type: "toolCall", tool: "WebFetch" };
    l.start(3, "t1", tool);
    l.finish(4, "t1", { ...tool, status: "failed", error: "HTTP 404" });
    const reply = { id: "m1", type: "agentMessage" };
    l.start(5, "t1", reply);
    l.finish(6, "t1", reply);
    l.done(6, "t1");

    const [turn] = build(l.events);
    const replySeq = l.events.find(
      (event) =>
        event.type === "item/completed" &&
        (event.data as { item: { id: string } }).item.id === "m1",
    )!.seq;
    expect(turn.spans).toEqual([
      expect.objectContaining({ id: "i1", exitCode: 1, status: "failed", chatSeq: replySeq }),
      expect.objectContaining({ id: "i2", error: "HTTP 404", chatSeq: replySeq }),
    ]);
  });

  it("waits through an answered question until the agent has it", () => {
    const l = log();
    l.turn(0, "t1");
    const question = {
      id: "pint_q",
      payload: {
        kind: "user_question",
        questions: [{ prompt: "Keep 35 ms or raise it to 60 ms?", shortLabel: "Timeout" }],
      },
    };
    l.raw(
      2,
      "system/interaction/lifecycle",
      { interaction: { ...question, status: "pending" } },
      "t1",
    );
    l.raw(
      12,
      "system/interaction/lifecycle",
      { interaction: { ...question, status: "resolving" } },
      "t1",
    );
    l.raw(
      13,
      "system/interaction/lifecycle",
      { interaction: { ...question, status: "resolved" } },
      "t1",
    );
    l.done(20, "t1");

    const [turn] = build(l.events);
    expect(turn.spans[0]).toMatchObject({
      kind: "waiting",
      name: "Question",
      detail: "Keep 35 ms or raise it to 60 ms?",
      start: T0 + 2_000,
      end: T0 + 13_000,
      status: "completed",
    });
  });

  it("marks provider errors, stops, and waits that timed out", () => {
    const l = log();
    l.turn(0, "t1");
    l.raw(1, "system/interaction/lifecycle", {
      interaction: {
        id: "pint_1",
        status: "pending",
        payload: { kind: "plugin", title: "Add secrets" },
      },
    });
    l.raw(601, "system/interaction/lifecycle", {
      interaction: { id: "pint_1", status: "interrupted", statusReason: "timeout" },
    });
    l.raw(602, "provider/error", { message: "Provider error", detail: "Overloaded" }, "t1");
    l.raw(603, "system/thread/interrupted", { reason: "manual-stop" });
    l.done(603, "t1", "interrupted");

    const [turn] = build(l.events);
    expect(turn.spans.map((span) => [span.kind, span.name, span.status, span.error])).toEqual([
      ["waiting", "Add secrets", "interrupted", "timeout"],
      ["error", "Provider error", "failed", "Provider error: Overloaded"],
      ["error", "Stopped", "interrupted", "Stopped by hand"],
    ]);
    expect(turnStats(turn, T0).errors).toBe(1);
  });
});

describe("shellCommands", () => {
  it("splits like a shell, keeping quotes and substitutions together", () => {
    expect(
      shellCommands(
        'cd /tmp && UA="Mozilla/5.0 (X11; Linux)" curl -A "$UA" -o out.html https://x.test',
      ),
    ).toEqual([
      ["cd", "/tmp"],
      ["UA=Mozilla/5.0 (X11; Linux)", "curl", "-A", "$UA", "-o", "out.html", "https://x.test"],
    ]);
    expect(shellCommands("out=$(gh pr checks 12 | tail -1); echo $out")).toEqual([
      ["out=$(gh pr checks 12 | tail -1)"],
      ["echo", "$out"],
    ]);
    expect(
      shellCommands("curl -X POST https://x.test \\\n  -d '{\"a\": 1}' 2>&1 | head -5"),
    ).toEqual([
      ["curl", "-X", "POST", "https://x.test", "-d", '{"a": 1}', "2>&1"],
      ["head", "-5"],
    ]);
    expect(shellCommands('cd "a \\"b\\"" && pnpm test')).toEqual([
      ["cd", 'a "b"'],
      ["pnpm", "test"],
    ]);
  });
});

describe("formatting", () => {
  it("formats durations at every scale", () => {
    expect([450, 4_250, 37_000, 65_000, 3_725_000].map(formatDuration)).toEqual([
      "450ms",
      "4.3s",
      "37s",
      "1m 05s",
      "1h 02m",
    ]);
  });

  it("rounds before picking the unit", () => {
    expect([999.6, 9_960, 59_600, 3_599_600].map(formatDuration)).toEqual([
      "1.0s",
      "10s",
      "1m 00s",
      "1h 00m",
    ]);
  });

  it("formats token counts", () => {
    expect([512, 3_840, 2_469_871].map(formatTokens)).toEqual(["512", "3.8k", "2.47M"]);
    expect([999_949, 999_999].map(formatTokens)).toEqual(["999.9k", "1.00M"]);
  });
});
