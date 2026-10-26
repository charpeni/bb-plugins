import { describe, expect, it } from "vitest";
import { turnStats } from "./breakdown.js";
import { commandStats, compareTurns, signatureOf, threadTotals } from "./insights.js";
import type { Span, Turn } from "./trace.js";

const T0 = 1_800_000_000_000;

function span(overrides: Partial<Span>): Span {
  return {
    id: "s",
    parentId: null,
    kind: "command",
    name: "",
    detail: "",
    start: T0,
    end: T0 + 1_000,
    status: "completed",
    background: false,
    tokens: null,
    exitCode: null,
    error: null,
    launchedBy: null,
    seq: 1,
    endSeq: 2,
    chatSeq: null,
    ...overrides,
  };
}

function turn(index: number, spans: Span[]): Turn {
  return {
    id: `t${index}`,
    index,
    prompt: "",
    sender: null,
    start: T0,
    end: T0 + 600_000,
    status: "completed",
    spans,
    activity: [],
    requestSeq: null,
    firstSeq: 1,
    lastSeq: 2,
  };
}

const sign = (detail: string) => signatureOf(span({ detail }), new Map());

describe("signatureOf", () => {
  it("groups commands by what they ran", () => {
    expect(sign("cd web && pnpm test --filter checkout")).toBe("pnpm test");
    expect(sign("pnpm --filter web run lint")).toBe("pnpm run lint");
    expect(sign("git -C ../repo diff --stat")).toBe("git diff");
    expect(sign("bb thread wait thr_abc --timeout 9m")).toBe("bb thread wait");
    expect(sign("bb status 2>&1 | head -30")).toBe("bb status");
    expect(sign("bb thread --help 2>&1 | head -20")).toBe("bb thread");
    expect(sign("gh pr view 12 --json files")).toBe("gh pr view");
    expect(sign('timeout 300 ./bin/clj-nrepl-eval -p 7888 "(fast-dev)"')).toBe("clj-nrepl-eval");
    expect(sign("node /tmp/race/bench.mjs 1000")).toBe("node bench.mjs");
    expect(sign("python3 -m pytest -q")).toBe("python3 -m pytest");
    expect(sign("cat <<'EOF' > probe.mjs\nconsole.log(1)\nEOF\nnode probe.mjs")).toBe(
      "node probe.mjs",
    );
    expect(sign("cat <<EOF | kubectl apply -f -\nkind: Pod\nEOF")).toBe("kubectl apply");
    expect(sign('cd "a \\"b\\"" && pnpm test')).toBe("pnpm test");
    expect(sign("cd /tmp && cat > probe.py <<'EOF'\nprint(1)\nEOF\npython3 probe.py")).toBe(
      "python3 probe.py",
    );
    expect(sign("python3 - <<'PY'\nprint(1)\nPY")).toBe("python3 (inline)");
    expect(sign("for i in $(seq 20); do npm test; done")).toBe("shell");
    expect(
      sign('cd /tmp && UA="Mozilla/5.0 (X11; Linux x86_64)" curl -sL -A "$UA" https://x.test'),
    ).toBe("curl");
    expect(sign('bash -lc "cd web && pnpm test"')).toBe("pnpm test");
    expect(sign("exec node server.mjs")).toBe("node server.mjs");
    expect(sign('spawn() { bb thread spawn --title "$1"; }; spawn a; spawn b')).toBe("shell");
    expect(sign("curl -X POST https://x.test \\\n  -d '{}'")).toBe("curl");
  });

  it("keeps a clipped heredoc's body out of the signature", () => {
    const clipped = span({
      name: "node",
      detail: "cd /tmp/race && cat > q1.mjs <<'EOF'\n// Q1: measure the rate\nconst N = 1000;…",
    });
    expect(signatureOf(clipped, new Map())).toBe("node");
  });

  it("names background runs after the command that started them", () => {
    const launcher = span({ id: "c1", detail: "pnpm test --watch=false" });
    const background = span({ id: "b1", kind: "background", launchedBy: "c1", background: true });
    expect(signatureOf(background, new Map([["c1", launcher]]))).toBe("pnpm test (background)");
    expect(signatureOf(span({ kind: "subagent" }), new Map())).toBeNull();
    expect(signatureOf(span({ kind: "tool", name: "WebSearch" }), new Map())).toBe("WebSearch");
  });
});

describe("commandStats", () => {
  it("adds up runs across turns and threads, most total time first", () => {
    const first = turn(1, [
      span({ id: "a", detail: "pnpm test", end: T0 + 60_000 }),
      span({ id: "b", detail: "pnpm test", end: T0 + 30_000, status: "failed" }),
      span({ id: "c", detail: "git status", end: T0 + 100 }),
    ]);
    const second = turn(2, [span({ id: "d", detail: "pnpm test", end: T0 + 45_000 })]);
    const rows = commandStats(
      [
        { threadId: "thr_a", turns: [first] },
        { threadId: "thr_b", turns: [second] },
      ],
      T0,
    );
    expect(rows[0]).toMatchObject({
      signature: "pnpm test",
      count: 3,
      totalMs: 135_000,
      avgMs: 45_000,
      maxMs: 60_000,
      failures: 1,
      threads: 2,
      slowest: { threadId: "thr_a", turnId: "t1", spanId: "a" },
    });
    expect(rows[1]).toMatchObject({ signature: "git status", count: 1 });
  });
});

describe("compareTurns", () => {
  it("shows where time moved between two turns", () => {
    const before = turn(1, [
      span({ id: "a", detail: "pnpm test", end: T0 + 90_000 }),
      span({ id: "b", detail: "pnpm lint", start: T0 + 90_000, end: T0 + 100_000 }),
    ]);
    const after = turn(2, [span({ id: "c", detail: "pnpm test", end: T0 + 20_000 })]);
    const comparison = compareTurns(before, after, T0);
    expect(comparison.commands[0]).toEqual({
      signature: "pnpm test",
      a: { count: 1, totalMs: 90_000 },
      b: { count: 1, totalMs: 20_000 },
    });
    expect(comparison.phases.find((row) => row.phase === "tools")).toEqual({
      phase: "tools",
      a: 100_000,
      b: 20_000,
    });
  });
});

describe("threadTotals", () => {
  it("adds up a thread's turns, and keeps a running one's time growing", () => {
    const first = turn(1, [
      span({ id: "a", detail: "pnpm test", end: T0 + 90_000 }),
      span({
        id: "b",
        detail: "pnpm lint",
        status: "failed",
        start: T0 + 90_000,
        end: T0 + 100_000,
      }),
    ]);
    const running = {
      ...turn(2, [span({ id: "c", detail: "pnpm test", start: T0 + 700_000, end: null })]),
      start: T0 + 700_000,
      end: null,
      status: "running" as const,
    };
    const totals = threadTotals([first, running], T0 + 730_000);
    expect(totals).toMatchObject({
      turns: 2,
      activeMs: 630_000,
      toolCalls: 3,
      errors: 1,
      longestTurnMs: 600_000,
      runningSince: T0 + 700_000,
      lastTurnAt: T0 + 700_000,
    });
    expect(totals.phases.tools).toBe(130_000);
    expect(threadTotals([], T0)).toMatchObject({ turns: 0, activeMs: 0, lastTurnAt: null });
  });
});

describe("turnStats", () => {
  it("leaves a child thread's subagents to its own trace", () => {
    const stats = turnStats(
      turn(1, [
        span({ id: "c1", kind: "subagent", tokens: 100 }),
        span({ id: "thread:x", kind: "thread", background: true }),
        span({ id: "thread:x/c9", parentId: "thread:x", kind: "subagent", tokens: 5_000 }),
        span({ id: "thread:x/i1", parentId: "thread:x", kind: "command" }),
      ]),
      T0 + 600_000,
    );
    expect(stats).toMatchObject({
      subagents: 1,
      subagentTokens: 100,
      childThreads: 1,
      toolCalls: 0,
    });
  });
});
